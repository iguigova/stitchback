import "fake-indexeddb/auto";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    openstore, closestore, load, update
} from "../src/storage.js";
import {
    get, local, edit, sync, StaleError
} from "../src/state.js";
import { RemoteError } from "../src/fetch.js";

// Two replicas sync through a real json-server; a small server of our own
// covers the ETag path json-server does not implement.

const root = join(import.meta.dirname, "..");
const jsonserver = join(root, "node_modules/.bin/json-server");
const seed = join(root, "demo/db.json");

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

// --- intercepting fetch ----------------------------------------------------

// Runs work with every fetch call going through handle(realfetch, url,
// init) instead.
async function intercept(handle, work) {
    const realfetch = globalThis.fetch;
    globalThis.fetch = (url, init) => handle(realfetch, url, init);
    try {
        return await work();
    } finally {
        globalThis.fetch = realfetch;
    }
}

// Runs during() once, just before the first request that matches leaves.
function beforesend(matches, during, work) {
    let pending = true;
    return intercept(async (realfetch, url, init) => {
        if (pending && matches(new URL(url), init?.method ?? "GET")) {
            pending = false;
            await during();
        }
        return realfetch(url, init);
    }, work);
}

const write = (url, method) => method !== "GET";

// Lets the first POST through, then fails every request as offline.
function offlineafterpost(work) {
    let posted = false;
    return intercept(async (realfetch, url, init) => {
        if (posted) throw new TypeError("fetch failed");
        posted = init?.method === "POST";
        return realfetch(url, init);
    }, work);
}

// Strips the body from every response to a POST.
function withoutbody(work) {
    return intercept(async (realfetch, url, init) => {
        const response = await realfetch(url, init);
        if (init?.method !== "POST") return response;
        return new Response(null, { status: response.status });
    }, work);
}

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

test("local shows what has not reached the server yet", async () => {
    const db = await replica();
    assert.equal(await local(db, posturl()), undefined);
    const posts = (await sync(db, posturl())).data;
    await edit(db, posturl(), [...posts, { id: "tmp", title: "unsent" }]);
    const doc = await local(db, posturl());
    assert.deepEqual(doc.base, posts);
    assert.ok(bytitle(doc.ours, "unsent"));
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
    const doc = await load(db, posturl().href);
    await update(db, offline.href, () => ({ ...doc, url: offline.href }));
    await assert.rejects(sync(db, offline), TypeError);
    const kept = await load(db, offline.href);
    assert.ok(bytitle(kept.ours, "offline"));
    closestore(db);
});

test("a refused write raises with its status", async () => {
    const db = await replica();
    const missing = new URL(`${origin}/nothing-here`);
    await assert.rejects(sync(db, missing),
        (error) => error instanceof RemoteError && error.status === 404);
    closestore(db);
});

test("concurrent syncs of one resource post a new entity once", async () => {
    const db = await replica();
    const posts = (await sync(db, posturl())).data;
    await edit(db, posturl(), [...posts, { id: "tmp", title: "only once" }]);
    await Promise.all([sync(db, posturl()), sync(db, posturl())]);
    const result = await sync(db, posturl());
    const copies = result.data.filter((p) => p.title === "only once");
    assert.equal(copies.length, 1);
    closestore(db);
});

test("an edit made while a sync runs is kept and synced next", async () => {
    const db = await replica();
    const posts = (await sync(db, posturl())).data;
    const first = byid(posts, "1");
    const retitled = posts.map((p) => p === first ? { ...p, title: "T" } : p);
    await edit(db, posturl(), retitled);
    const late = retitled.map((p) => p.id === "1" ? { ...p, author: "L" } : p);
    const result = await beforesend(write, () => edit(db, posturl(), late),
        () => sync(db, posturl()));
    assert.deepEqual(result.conflicts, []);
    assert.equal(byid(result.data, "1").author, "L");
    const server = await (await fetch(posturl())).json();
    assert.equal(byid(server, "1").title, "T");
    assert.notEqual(byid(server, "1").author, "L");
    const next = await sync(db, posturl());
    assert.equal(byid(next.data, "1").author, "L");
    closestore(db);
});

test("a create that went through before a sync failed is not repeated",
    async () => {
        const db = await replica();
        const posts = (await sync(db, posturl())).data;
        const edited = posts.map((p) => ({ ...p, title: `${p.title}!` }));
        const added = { id: "tmp", title: "posted once" };
        await edit(db, posturl(), [...edited, added]);
        await assert.rejects(offlineafterpost(() => sync(db, posturl())),
            TypeError);
        const result = await sync(db, posturl());
        const copies = result.data.filter((p) => p.title === "posted once");
        assert.equal(copies.length, 1);
        assert.notEqual(copies[0].id, "tmp");
        closestore(db);
    });

test("an edit to a new entity made while it is posted is kept", async () => {
    const db = await replica();
    const posts = (await sync(db, posturl())).data;
    const added = { id: "tmp", title: "draft" };
    await edit(db, posturl(), [...posts, added]);
    const later = [...posts, { ...added, title: "final" }];
    const result = await beforesend(write, () => edit(db, posturl(), later),
        () => sync(db, posturl()));
    const mine = bytitle(result.data, "final");
    assert.ok(mine && mine.id !== "tmp");
    assert.equal(bytitle(result.data, "draft"), undefined);
    const next = (await sync(db, posturl())).data;
    assert.equal(byid(next, mine.id).title, "final");
    closestore(db);
});

test("a create answered without a body still settles", async () => {
    const db = await replica();
    const posts = (await sync(db, posturl())).data;
    await edit(db, posturl(), [...posts, { id: "tmp", title: "no body" }]);
    const result = await withoutbody(() => sync(db, posturl()));
    const copies = result.data.filter((p) => p.title === "no body");
    assert.equal(copies.length, 1);
    assert.notEqual(copies[0].id, "tmp");
    closestore(db);
});

test("an entity changed after the sync read it is merged, not overwritten",
    async () => {
        const db = await replica();
        const posts = (await sync(db, posturl())).data;
        const first = byid(posts, "1");
        const mine = posts.map((p) => p === first ? { ...p, title: "M" } : p);
        await edit(db, posturl(), mine);
        const other = () => put(`${origin}/posts/1`, { ...first, author: "O" });
        const touches = (url) => url.pathname === "/posts/1";
        const result = await beforesend(touches, other,
            () => sync(db, posturl()));
        const server = await (await fetch(`${origin}/posts/1`)).json();
        assert.deepEqual([server.title, server.author], ["M", "O"]);
        assert.deepEqual(byid(result.data, "1"), server);
        closestore(db);
    });

test("an entity deleted after the sync read it is a conflict", async () => {
    const db = await replica();
    const posts = (await sync(db, posturl())).data;
    const first = byid(posts, "1");
    const mine = posts.map((p) => p === first ? { ...p, title: "kept" } : p);
    await edit(db, posturl(), mine);
    const other = () => fetch(`${origin}/posts/1`, { method: "DELETE" });
    const touches = (url) => url.pathname === "/posts/1";
    const result = await beforesend(touches, other,
        () => sync(db, posturl()));
    assert.deepEqual(result.conflicts.map((c) => c.pointer), ["/1"]);
    assert.ok(bytitle(result.data, "kept"));
    closestore(db);
});

function put(url, data) {
    return fetch(url, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data)
    });
}

// --- ETag -------------------------------------------------------------------

// Holds one document. A PUT whose If-Match is stale is refused with 412;
// `interfere` lets a concurrent writer change the document first. With
// weak tags, If-Match can never match, as RFC 9110 compares it strongly,
// so only an unconditional PUT succeeds.
function etagserver(interfere, weak = false) {
    let version = 1;
    let doc = { a: 1, b: 1 };
    const tag = () => weak ? `W/"${version}"` : `"${version}"`;
    const http = createServer(async (request, response) => {
        if (request.method === "PUT") {
            if (interfere()) { version += 1; doc = { ...doc, b: version }; }
            const ifmatch = request.headers["if-match"];
            if (weak ? ifmatch !== undefined : ifmatch !== tag()) {
                response.writeHead(412).end();
                return;
            }
            doc = JSON.parse(await body(request));
            version += 1;
        }
        response.writeHead(200, { ETag: tag() });
        response.end(JSON.stringify(doc));
    });
    return new Promise((resolve) => http.listen(0, () => resolve(http)));
}

async function body(request) {
    let text = "";
    for await (const chunk of request) text += chunk;
    return text;
}

async function syncagainst(interfere, weak) {
    const http = await etagserver(interfere, weak);
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

test("a weak ETag is not sent as If-Match", async () => {
    const result = await syncagainst(() => false, true);
    assert.deepEqual(result.data, { a: 2, b: 1 });
});

test("a write that stays stale gives up", async () => {
    await assert.rejects(syncagainst(() => true), StaleError);
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
