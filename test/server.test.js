import "fake-indexeddb/auto";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createserver } from "../public/demo/server.js";
import { openstore, closestore } from "../public/modules/storage.js";
import { edit, sync } from "../public/modules/state.js";

// The demo's server must be a plain REST server: these tests drive it the
// way a client would, then sync two replicas through it.

const seedfile = join(import.meta.dirname, "../public/db.json");
const seed = JSON.parse(await readFile(seedfile, "utf8"));
const origin = "https://demo.test";

async function call(server, method, path, body) {
    const init = { method: method };
    if (body !== undefined) init.body = JSON.stringify(body);
    const response = await server.fetch(`${origin}${path}`, init);
    return { status: response.status, body: await response.json() };
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

test("two replicas merge their offline edits through it", async () => {
    const server = createserver(seed);
    const realfetch = globalThis.fetch;
    globalThis.fetch = server.fetch;
    try {
        const url = new URL(`${origin}/posts`);
        const [a, b] = [await openstore("demo-a"), await openstore("demo-b")];
        const [posts] = [(await sync(a, url)).data];
        await sync(b, url);
        const retitle = (p) => p.id === "1" ? { ...p, title: "A" } : p;
        const reauthor = (p) => p.id === "1" ? { ...p, author: "B" } : p;
        await edit(a, url, posts.map(retitle));
        await edit(b, url, posts.map(reauthor));
        await sync(a, url);
        const merged = (await sync(b, url)).data[0];
        assert.equal(merged.title, "A");
        assert.equal(merged.author, "B");
        closestore(a);
        closestore(b);
    } finally {
        globalThis.fetch = realfetch;
    }
});
