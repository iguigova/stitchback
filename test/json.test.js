import { test } from "node:test";
import assert from "node:assert/strict";
import {
    parentof, keyof, iskeyedlist, flatten, unflatten
} from "../public/modules/json.js";

const roundtrip = (value) => unflatten(flatten(value));

test("documents survive flatten and unflatten unchanged", () => {
    const documents = [
        { a: {}, b: [] },
        { "2023": "numeric key" },
        { "a.b": 1, "c/d": { "~": 2 } },
        [{ id: 1, tags: ["x", { y: 1 }] }, { id: "two" }],
        [1, [2, null]],
        { nested: { deep: { value: false } } },
        "scalar",
        null,
        []
    ];
    for (const document of documents) {
        assert.deepEqual(roundtrip(document), document);
    }
});

test("entities are keyed by id, so an insert renames nothing", () => {
    const before = [...flatten([{ id: 1 }, { id: 2 }]).keys()];
    const after = [...flatten([{ id: 0 }, { id: 1 }, { id: 2 }]).keys()];
    assert.ok(before.every((pointer) => after.includes(pointer)));
    assert.ok(after.includes("/2/id"));
});

test("only arrays of uniquely identified objects are keyed lists", () => {
    assert.ok(iskeyedlist([{ id: 1 }, { id: "2" }]));
    assert.ok(iskeyedlist([]));
    assert.ok(!iskeyedlist([{ id: 1 }, { id: "1" }]));
    assert.ok(!iskeyedlist([{ id: 1 }, { name: "x" }]));
    assert.ok(!iskeyedlist([{ id: {} }]));
    assert.ok(!iskeyedlist({ id: 1 }));
});

test("pointers escape slash and tilde", () => {
    const pointer = [...flatten({ "a/b~c": 1 }).keys()][1];
    assert.equal(pointer, "/a~1b~0c");
    assert.equal(keyof(pointer), "a/b~c");
    assert.equal(parentof(pointer), "");
});

test("an empty record set is no document", () => {
    assert.equal(unflatten(new Map()), undefined);
});
