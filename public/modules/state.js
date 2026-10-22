import { load, save } from "./storage.js";
import { iskeyedlist, same } from "./json.js";
import { merge, keepours } from "./merge.js";
import {
    RemoteError, preconditionfailed, getremote, sendremote
} from "./fetch.js";

// A resource is stored as { url, base, ours }: base is the server state at
// the last sync, ours is the local copy with any offline edits. A sync
// merges ours with the server's current state against base, writes the
// difference back, and makes the result the new base.

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
    const doc = await load(db, url.href);
    if (doc === undefined) throw new Error(`get ${url.href} before editing it`);
    await save(db, { ...doc, ours: data });
}

// --- syncing ----------------------------------------------------------------

function sync(db, url, resolve = keepours, attempt = 1) {
    return synconce(db, url, resolve).catch((error) => {
        if (!retryable(error, attempt)) throw error;
        return sync(db, url, resolve, attempt + 1);
    });
}

function retryable(error, attempt) {
    return error instanceof RemoteError
        && error.status === preconditionfailed
        && attempt < attempts;
}

async function synconce(db, url, resolve) {
    const remote = await getremote(url);
    const doc = await load(db, url.href) ?? unedited(url, remote.data);
    const result = merge(doc.base, doc.ours, remote.data, resolve);
    const writes = requests(url, remote, result.value);
    for (const request of writes) await sendremote(request);
    const settled = writes.length > 0 ? await getremote(url) : remote;
    await save(db, unedited(url, settled.data));
    return { data: settled.data, conflicts: result.conflicts };
}

function unedited(url, data) {
    return { url: url.href, base: data, ours: data };
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
