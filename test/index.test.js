import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const types = await readFile(
    join(import.meta.dirname, "../src/index.d.ts"), "utf8");

test("the types declare exactly what the entry point exports", async () => {
    const declared = [...types.matchAll(/^export (?:function|class) (\w+)/gm)]
        .map((match) => match[1]);
    const exported = Object.keys(await import("../src/index.js"));
    assert.deepEqual(new Set(declared), new Set(exported));
});
