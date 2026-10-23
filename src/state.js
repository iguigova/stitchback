import { load, update } from "./storage.js";
import { isentity, iskeyedlist, same } from "./json.js";
import { merge, keepours } from "./merge.js";
import { exclusive } from "./lock.js";
import {
    RemoteError, notfound, preconditionfailed, getremote, sendremote
} from "./fetch.js";

// A resource is stored as { url, base, ours }: base is the server state at
// the last sync, ours is the local copy with any offline edits. A sync
// merges ours with the server's current state against base, writes the
// difference back, and makes the result the new base. Syncs of one
// resource run one at a time; edits may land while one runs.

const attempts = 3;

// The server changed between the sync's read and its write, and that
// change was caught before it could be overwritten: by the server, as a
// 412, or by guard.
class StaleError extends Error {
    constructor(url) {
        super(`${url} changed while syncing`);
    }
}

// --- reading and editing ----------------------------------------------------

async function get(db, url, ondata) {
    const doc = await local(db, url);
    if (doc !== undefined) ondata(doc.ours);
    const result = await sync(db, url);
    ondata(result.data);
    return result;
}

// The stored { url, base, ours }, or undefined before the first sync.
// Comparing ours with base shows what has not reached the server yet.
function local(db, url) {
    return load(db, url.href);
}

async function edit(db, url, data) {
    await update(db, url.href, (doc) => {
        if (doc === undefined) {
            throw new Error(`get ${url.href} before editing it`);
        }
        return { ...doc, ours: data };
    });
}

// --- syncing ----------------------------------------------------------------

function sync(db, url, resolve = keepours) {
    const name = `stitchback ${db.name} ${url.href}`;
    return exclusive(name, () => attempt(db, url, resolve, 1));
}

function attempt(db, url, resolve, count) {
    return synconce(db, url, resolve).catch((error) => {
        if (!retryable(error, count)) throw error;
        return attempt(db, url, resolve, count + 1);
    });
}

function retryable(error, count) {
    return error instanceof StaleError && count < attempts;
}

function refused(error, status) {
    return error instanceof RemoteError && error.status === status;
}

async function synconce(db, url, resolve) {
    const remote = await getremote(url);
    const doc = await load(db, url.href) ?? unedited(url, remote.data);
    const result = merge(doc.base, doc.ours, remote.data, resolve);
    const writes = requests(url, remote, result.value);
    const late = [];
    for (const request of writes) {
        const response = await send(request);
        if (request.method === "POST") {
            late.push(...await adopt(db, url, request.data, response, resolve));
        }
    }
    const settled = writes.length > 0 ? await getremote(url) : remote;
    const saved = await update(db, url.href, (current) => {
        if (current === undefined) return unedited(url, settled.data);
        const edits = merge(doc.ours, current.ours, settled.data, resolve);
        late.push(...edits.conflicts);
        return { url: url.href, base: settled.data, ours: edits.value };
    });
    return { data: saved.ours, conflicts: [...result.conflicts, ...late] };
}

function unedited(url, data) {
    return { url: url.href, base: data, ours: data };
}

// The server has created an entity, under an id it chose. That is
// recorded at once, so a sync that fails later does not post it again:
// base gains the server's copy, and the local entity takes its id along
// with any edit made to it since it was posted.
async function adopt(db, url, posted, response, resolve) {
    const created = await response.json().catch(() => undefined);
    if (!isentity(created)) return [];
    const conflicts = [];
    await update(db, url.href, (doc) => {
        const rename = (e) => {
            if (String(e.id) !== String(posted.id)) return e;
            const result = merge(posted, e, created, resolve);
            conflicts.push(...result.conflicts);
            return result.value;
        };
        const base = [...doc.base, created];
        return { ...doc, base: base, ours: doc.ours.map(rename) };
    });
    return conflicts;
}

// --- syncing on its own -----------------------------------------------------

// Syncs now, then whenever the browser comes back online or the page is
// shown again; visibilitychange bubbles from the document to the window.
// Being offline is expected and stays quiet; any other failure goes to
// onerror. Returns a function that stops it.
function autosync(db, url, options = {}) {
    const { resolve, onsync = () => {}, onerror = () => {} } = options;
    const run = () => sync(db, url, resolve).then(onsync, (error) => {
        if (!(error instanceof TypeError)) onerror(error);
    });
    const onvisible = () => {
        if (globalThis.document?.visibilityState !== "hidden") run();
    };
    globalThis.addEventListener("online", run);
    globalThis.addEventListener("visibilitychange", onvisible);
    run();
    return () => {
        globalThis.removeEventListener("online", run);
        globalThis.removeEventListener("visibilitychange", onvisible);
    };
}

// --- writing back -----------------------------------------------------------

// A collection of entities is written entity by entity, the way REST
// expects; anything else is replaced whole, guarded by its ETag.
function requests(url, remote, merged) {
    if (iskeyedlist(remote.data) && iskeyedlist(merged)) {
        return entityrequests(url, remote.data, merged);
    }
    if (same(remote.data, merged)) return [];
    return [{ method: "PUT", url: url, data: merged, etag: remote.etag }];
}

// A PUT or DELETE carries the entity as the sync read it, for guard.
function entityrequests(url, theirs, merged) {
    const before = byid(theirs);
    const after = byid(merged);
    const added = merged.filter((e) => !before.has(String(e.id)));
    const changed = merged.filter((e) => modified(before, e));
    const removed = theirs.filter((e) => !after.has(String(e.id)));
    const read = (e) => before.get(String(e.id));
    return [
        ...added.map((e) => request("POST", collection(url), e)),
        ...changed.map((e) => request("PUT", entity(url, e), e, read(e))),
        ...removed.map((e) => request("DELETE", entity(url, e), undefined, e))
    ];
}

function request(method, url, data, read) {
    return { method: method, url: url, data: data, read: read };
}

async function send(request) {
    const guarded = await guard(request);
    return sendremote(guarded).catch(stale(request, preconditionfailed));
}

// A collection listing carries no ETag per entity, so the entity is read
// again just before it is written. If it changed since the listing, or is
// gone, the sync starts over; if not, its ETag guards the write.
async function guard(request) {
    if (request.read === undefined) return request;
    const current = await getremote(request.url)
        .catch(stale(request, notfound));
    if (!same(current.data, request.read)) throw new StaleError(request.url);
    return { ...request, etag: current.etag };
}

// Turns a refusal with status into a StaleError.
function stale(request, status) {
    return (error) => {
        throw refused(error, status) ? new StaleError(request.url) : error;
    };
}

function byid(entities) {
    return new Map(entities.map((e) => [String(e.id), e]));
}

function modified(before, e) {
    return before.has(String(e.id)) && !same(before.get(String(e.id)), e);
}

function collection(url) {
    return new URL(url.pathname, url.origin);
}

function entity(url, e) {
    const base = url.pathname.replace(/\/$/, "");
    return new URL(`${base}/${encodeURIComponent(e.id)}`, url.origin);
}

export { get, local, edit, sync, autosync, StaleError };
