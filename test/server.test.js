import "fake-indexeddb/auto";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createserver } from "../demo/server.js";
import { openstore, closestore } from "../src/storage.js";
import { edit, sync } from "../src/state.js";

// The demo's server must be a plain REST server: these tests drive it the
// way a client would, then sync two replicas through it.

const seedfile = join(import.meta.dirname, "../demo/db.json");
const seed = JSON.parse(await readFile(seedfile, "utf8"));
const origin = "https://demo.test";

async function call(server, method, path, body, headers = {}) {
    const init = { method: method, headers: headers };
    if (body !== undefined) init.body = JSON.stringify(body);
    const response = await server.fetch(`${origin}${path}`, init);
    return {
        status: response.status,
        etag: response.headers.get("ETag"),
        body: await response.json()
    };
}

test("a collection lists and creates, assigning the id", async () => {
    const server = createserver(seed);
    assert.deepEqual((await call(server, "GET", "/posts")).body, seed.posts);
    const created = await call(server, "POST", "/posts", { id: "x", t: 1 });
    assert.equal(created.status, 201);
    assert.notEqual(created.body.id, "x");
    assert.equal(server.snapshot().posts.length, seed.posts.length + 1);
    assert.equal((await call(server, "PUT", "/posts")).status, 405);
});

test("an entity reads, replaces and deletes, keeping its id", async () => {
    const server = createserver(seed);
    assert.deepEqual((await call(server, "GET", "/posts/1")).body,
        seed.posts[0]);
    const put = await call(server, "PUT", "/posts/1", { id: "9", t: 2 });
    assert.deepEqual(put.body, { id: "1", t: 2 });
    assert.equal((await call(server, "POST", "/posts/1")).status, 405);
    assert.equal((await call(server, "DELETE", "/posts/1")).status, 200);
    assert.equal((await call(server, "GET", "/posts/1")).status, 404);
});

test("a single resource reads and replaces", async () => {
    const server = createserver(seed);
    assert.deepEqual((await call(server, "GET", "/profile")).body,
        seed.profile);
    await call(server, "PUT", "/profile", { name: "grace" });
    assert.deepEqual(server.snapshot().profile, { name: "grace" });
    assert.equal((await call(server, "DELETE", "/profile")).status, 405);
});

test("a write naming an older ETag is refused", async () => {
    const server = createserver(seed);
    for (const path of ["/posts/1", "/profile"]) {
        const read = await call(server, "GET", path);
        assert.match(read.etag, /^"[0-9a-f]+"$/);
        const stale = { "If-Match": "\"0\"" };
        const fresh = { "If-Match": read.etag };
        assert.equal((await call(server, "PUT", path, {}, stale)).status, 412);
        assert.equal((await call(server, "PUT", path, {}, fresh)).status, 200);
    }
    const gone = await call(server, "DELETE", "/posts/1", undefined,
        { "If-Match": "\"0\"" });
    assert.equal(gone.status, 412);
});

test("unknown paths are not found", async () => {
    const server = createserver(seed);
    for (const path of ["/nope", "/toString", "/profile/1", "/posts/1/x"]) {
        assert.equal((await call(server, "GET", path)).status, 404);
    }
});

test("the server never shares its state with a caller", async () => {
    const server = createserver(seed);
    server.snapshot().posts.pop();
    (await call(server, "GET", "/posts")).body.pop();
    assert.equal(server.snapshot().posts.length, seed.posts.length);
});

// Runs work with fetch answered by server, through handle when given.
async function through(server, work, handle = server.fetch) {
    const realfetch = globalThis.fetch;
    globalThis.fetch = handle;
    try {
        return await work();
    } finally {
        globalThis.fetch = realfetch;
    }
}

const url = new URL(`${origin}/posts`);
const retitle = (p) => p.id === "1" ? { ...p, title: "A" } : p;
const reauthor = (p) => p.id === "1" ? { ...p, author: "B" } : p;

test("two replicas merge their offline edits through it", async () => {
    const server = createserver(seed);
    await through(server, async () => {
        const [a, b] = [await openstore("demo-a"), await openstore("demo-b")];
        const [posts] = [(await sync(a, url)).data];
        await sync(b, url);
        await edit(a, url, posts.map(retitle));
        await edit(b, url, posts.map(reauthor));
        await sync(a, url);
        const merged = (await sync(b, url)).data[0];
        assert.equal(merged.title, "A");
        assert.equal(merged.author, "B");
        closestore(a);
        closestore(b);
    });
});

test("a write racing another is refused by its ETag and merged", async () => {
    const server = createserver(seed);
    let raced = false;
    const racing = async (target, init) => {
        if (!raced && init.method === "PUT") {
            raced = true;
            const other = reauthor(server.snapshot().posts[0]);
            await call(server, "PUT", "/posts/1", other);
        }
        return server.fetch(target, init);
    };
    await through(server, async () => {
        const db = await openstore("demo-race");
        const posts = (await sync(db, url)).data;
        await edit(db, url, posts.map(retitle));
        const merged = (await sync(db, url)).data[0];
        assert.deepEqual([merged.title, merged.author], ["A", "B"]);
        closestore(db);
    }, racing);
    assert.deepEqual(server.snapshot().posts[0].author, "B");
});
