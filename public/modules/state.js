import { load, update } from "./storage.js";
import { isentity, iskeyedlist, same } from "./json.js";
import { merge, keepours } from "./merge.js";
import { exclusive } from "./lock.js";
import {
    RemoteError, preconditionfailed, getremote, sendremote
} from "./fetch.js";

// A resource is stored as { url, base, ours }: base is the server state at
// the last sync, ours is the local copy with any offline edits. A sync
// merges ours with the server's current state against base, writes the
// difference back, and makes the result the new base. Syncs of one
// resource run one at a time; edits may land while one runs.

const attempts = 3;

// --- reading and editing ----------------------------------------------------

async function get(db, url, ondata) {
    const doc = await load(db, url.href);
    if (doc !== undefined) ondata(doc.ours);
    const result = await sync(db, url);
    ondata(result.data);
    return result;
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
    return error instanceof RemoteError
        && error.status === preconditionfailed
        && count < attempts;
}

async function synconce(db, url, resolve) {
    const remote = await getremote(url);
    const doc = await load(db, url.href) ?? unedited(url, remote.data);
    const result = merge(doc.base, doc.ours, remote.data, resolve);
    const writes = requests(url, remote, result.value);
    const late = [];
    for (const request of writes) {
        const response = await sendremote(request);
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

function entityrequests(url, theirs, merged) {
    const before = byid(theirs);
    const after = byid(merged);
    const added = merged.filter((e) => !before.has(String(e.id)));
    const changed = merged.filter((e) => modified(before, e));
    const removed = theirs.filter((e) => !after.has(String(e.id)));
    return [
        ...added.map((e) => request("POST", collection(url), e)),
        ...changed.map((e) => request("PUT", entity(url, e), e)),
        ...removed.map((e) => request("DELETE", entity(url, e)))
    ];
}

function request(method, url, data) {
    return { method: method, url: url, data: data };
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

export { get, edit, sync };
