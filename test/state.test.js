import "fake-indexeddb/auto";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    openstore, closestore, load, save
} from "../public/modules/storage.js";
import { get, edit, sync } from "../public/modules/state.js";
import { RemoteError } from "../public/modules/fetch.js";

// Two replicas sync through a real json-server; a small server of our own
// covers the ETag path json-server does not implement.

const root = join(import.meta.dirname, "..");
const jsonserver = join(root, "node_modules/.bin/json-server");
const seed = join(root, "public/db.json");

let server;
let origin;

before(async () => {
    const port = await freeport();
    const data = join(await mkdtemp(join(tmpdir(), "stitchback-")), "db.json");
    await copyFile(seed, data);
    server = spawn(jsonserver, [data, "--port", String(port)]);
    origin = `http://localhost:${port}`;
    await ready(`${origin}/posts`);
});

after(() => server.kill());

function freeport() {
    return new Promise((resolve) => {
        const probe = createServer().listen(0, () => {
            const port = probe.address().port;
            probe.close(() => resolve(port));
        });
    });
}

async function ready(url) {
    for (;;) {
        const response = await fetch(url).catch(() => undefined);
        if (response?.ok) return;
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
}

let replicas = 0;

function replica() {
    replicas += 1;
    return openstore(`replica-${replicas}`);
}

function posturl() {
    return new URL(`${origin}/posts`);
}

const byid = (posts, id) => posts.find((p) => p.id === id);
const bytitle = (posts, title) => posts.find((p) => p.title === title);

// --- json-server ------------------------------------------------------------

test("offline edits from two replicas merge field by field", async () => {
    const [a, b] = [await replica(), await replica()];
    const [postsa] = [(await sync(a, posturl())).data];
    await sync(b, posturl());

    const first = byid(postsa, "1");
    await edit(a, posturl(), [{ ...first, title: "A's title" }, postsa[1]]);
    const postsb = (await load(b, posturl().href)).ours;
    const rename = (p) => p.id === "1" ? { ...p, author: "bea" } : p;
    const edited = postsb.map(rename);
    await edit(b, posturl(), [...edited, { id: "3", title: "new from B" }]);

    await sync(a, posturl());
    const result = await sync(b, posturl());
    assert.deepEqual(result.conflicts, []);
    assert.equal(byid(result.data, "1").title, "A's title");
    assert.equal(byid(result.data, "1").author, "bea");
    assert.ok(bytitle(result.data, "new from B"));

    const settled = (await sync(a, posturl())).data;
    assert.deepEqual(settled, result.data);
    [a, b].forEach(closestore);
});

test("a deletion reaches the server", async () => {
    const db = await replica();
    const posts = (await sync(db, posturl())).data;
    await edit(db, posturl(), [...posts, { id: "tmp", title: "doomed" }]);
    const created = (await sync(db, posturl())).data;
    const doomed = bytitle(created, "doomed");
    await edit(db, posturl(), created.filter((p) => p !== doomed));
    const result = await sync(db, posturl());
    assert.equal(byid(result.data, doomed.id), undefined);
    closestore(db);
});

test("a conflict is reported and settled by the resolver", async () => {
    const [a, b] = [await replica(), await replica()];
    const posts = (await sync(a, posturl())).data;
    await sync(b, posturl());
    const retitle = (title) => posts.map((p) => ({ ...p, title: title }));
    await edit(a, posturl(), retitle("from A"));
    await edit(b, posturl(), retitle("from B"));
    await sync(a, posturl());
    const result = await sync(b, posturl(), (c) => c.theirs);
    assert.ok(result.conflicts.length > 0);
    assert.ok(result.data.every((p) => p.title === "from A"));
    [a, b].forEach(closestore);
});

test("a single resource is replaced whole", async () => {
    const db = await replica();
    const url = new URL(`${origin}/profile`);
    const profile = (await sync(db, url)).data;
    await edit(db, url, { ...profile, theme: "light" });
    const result = await sync(db, url);
    assert.equal(result.data.theme, "light");
    closestore(db);
});

test("get shows the local copy first, then the synced one", async () => {
    const db = await replica();
    const shown = [];
    await get(db, posturl(), (data) => shown.push(data));
    await get(db, posturl(), (data) => shown.push(data));
    assert.equal(shown.length, 3);
    closestore(db);
});

test("editing an unknown resource is refused", async () => {
    const db = await replica();
    await assert.rejects(edit(db, posturl(), []), /before editing/);
    closestore(db);
});

test("offline, sync fails and the local edit is kept", async () => {
    const db = await replica();
    const posts = (await sync(db, posturl())).data;
    await edit(db, posturl(), [...posts, { id: "9", title: "offline" }]);
    const offline = new URL(`http://localhost:${await freeport()}/posts`);
    await save(db, { ...(await load(db, posturl().href)), url: offline.href });
    await assert.rejects(sync(db, offline), TypeError);
    const kept = await load(db, offline.href);
    assert.ok(bytitle(kept.ours, "offline"));
    closestore(db);
});

test("a refused write raises with its status", async () => {
    const db = await replica();
    const missing = new URL(`${origin}/nothing-here`);
    await assert.rejects(sync(db, missing), (error) => error.status === 404);
    closestore(db);
});

// --- ETag -------------------------------------------------------------------

// Holds one document. A PUT whose If-Match is stale is refused with 412;
// `interfere` lets a concurrent writer change the document first.
function etagserver(interfere) {
    let version = 1;
    let doc = { a: 1, b: 1 };
    const http = createServer(async (request, response) => {
        if (request.method === "PUT") {
            if (interfere()) { version += 1; doc = { ...doc, b: version }; }
            const current = `"${version}"`;
            if (request.headers["if-match"] !== current) {
                response.writeHead(412).end();
                return;
            }
            doc = JSON.parse(await body(request));
            version += 1;
        }
        response.writeHead(200, { ETag: `"${version}"` });
        response.end(JSON.stringify(doc));
    });
    return new Promise((resolve) => http.listen(0, () => resolve(http)));
}

async function body(request) {
    let text = "";
    for await (const chunk of request) text += chunk;
    return text;
}

async function syncagainst(interfere) {
    const http = await etagserver(interfere);
    const url = new URL(`http://localhost:${http.address().port}/doc`);
    const db = await replica();
    await sync(db, url);
    await edit(db, url, { a: 2, b: 1 });
    try {
        return await sync(db, url);
    } finally {
        closestore(db);
        http.close();
    }
}

test("a stale write is retried against the newer state", async () => {
    let writes = 0;
    const result = await syncagainst(() => ++writes === 1);
    assert.deepEqual(result.data, { a: 2, b: 2 });
});

test("a write that stays stale gives up", async () => {
    await assert.rejects(
        syncagainst(() => true),
        (error) => error instanceof RemoteError && error.status === 412);
});

// --- storage ----------------------------------------------------------------

test("opening a store at an older version fails", async () => {
    const newer = await new Promise((resolve) => {
        const request = indexedDB.open("newer", 2);
        request.onsuccess = () => resolve(request.result);
    });
    closestore(newer);
    await assert.rejects(
        openstore("newer"),
        (error) => error.name === "VersionError");
});
