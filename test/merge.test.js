import { test } from "node:test";
import assert from "node:assert/strict";
import { merge } from "../src/merge.js";

const keeptheirs = (conflict) => conflict.theirs;

test("changes to different fields both survive", () => {
    const base = { title: "a", author: "x" };
    const ours = { title: "b", author: "x" };
    const theirs = { title: "a", author: "y" };
    assert.deepEqual(merge(base, ours, theirs),
        { value: { title: "b", author: "y" }, conflicts: [] });
});

test("an identical change on both sides is no conflict", () => {
    const result = merge({ n: 1 }, { n: 2 }, { n: 2 });
    assert.deepEqual(result, { value: { n: 2 }, conflicts: [] });
});

test("two different changes to one field are a conflict", () => {
    const result = merge({ n: 1 }, { n: 2 }, { n: 3 });
    assert.deepEqual(result.value, { n: 2 });
    assert.deepEqual(result.conflicts, [{
        pointer: "/n",
        base: { kind: "value", value: 1 },
        ours: { kind: "value", value: 2 },
        theirs: { kind: "value", value: 3 }
    }]);
});

test("the resolver settles a conflict", () => {
    const result = merge({ n: 1 }, { n: 2 }, { n: 3 }, keeptheirs);
    assert.deepEqual(result.value, { n: 3 });
});

test("a deletion on one side wins over an untouched field", () => {
    const result = merge({ a: 1, b: 2 }, { a: 1 }, { a: 1, b: 2 });
    assert.deepEqual(result.value, { a: 1 });
});

test("entity lists merge additions, removals and field edits", () => {
    const base = [{ id: 1, t: "a", n: 1 }, { id: 2, t: "b" }];
    const ours = [{ id: 1, t: "A", n: 1 }, { id: 2, t: "b" }, { id: 3 }];
    const theirs = [{ id: 0 }, { id: 1, t: "a", n: 9 }];
    assert.deepEqual(merge(base, ours, theirs), {
        value: [{ id: 0 }, { id: 1, t: "A", n: 9 }, { id: 3 }],
        conflicts: []
    });
});

test("an entity both sides added appears once", () => {
    const ours = [{ id: 1, t: "a" }];
    const result = merge([], ours, [...ours, { id: 2 }]);
    assert.deepEqual(result.value, [{ id: 1, t: "a" }, { id: 2 }]);
});

test("a list replacing a value adopts membership from both sides", () => {
    const result = merge("none", [{ id: 1 }], [{ id: 2 }]);
    assert.deepEqual(result.value, [{ id: 2 }, { id: 1 }]);
});

test("replacing a node another side edited inside is a conflict", () => {
    const base = { a: { x: 1 } };
    const result = merge(base, { a: 5 }, { a: { x: 2 } });
    assert.deepEqual(result.value, { a: 5 });
    assert.deepEqual(result.conflicts, [{
        pointer: "/a",
        base: { kind: "object" },
        ours: { kind: "value", value: 5 },
        theirs: { kind: "object" }
    }]);
});

test("removing an entity the server edited is a conflict", () => {
    const base = [{ id: 1, t: "a" }];
    const result = merge(base, [], [{ id: 1, t: "b" }]);
    assert.deepEqual(result.value, []);
    assert.deepEqual(result.conflicts, [{
        pointer: "/1",
        base: { kind: "object" },
        ours: undefined,
        theirs: { kind: "object" }
    }]);
});

test("an entity edited here and removed on the server is kept", () => {
    const base = [{ id: 1, t: "a" }, { id: 2 }];
    const result = merge(base, [{ id: 1, t: "b" }, { id: 2 }], [{ id: 2 }]);
    assert.deepEqual(result.value, [{ id: 1, t: "b" }, { id: 2 }]);
    assert.deepEqual(result.conflicts.map((c) => c.pointer), ["/1"]);
});

test("keeping the edit restores the entity where it stood", () => {
    const base = [{ id: 1 }, { id: 2, t: "a" }, { id: 3 }];
    const ours = [{ id: 1 }, { id: 3 }];
    const theirs = [{ id: 1 }, { id: 2, t: "b" }, { id: 3 }];
    const result = merge(base, ours, theirs, keeptheirs);
    assert.deepEqual(result.value, theirs);
});

test("an entity removed first in the list is restored first", () => {
    const base = [{ id: 1, t: "a" }, { id: 2 }];
    const theirs = [{ id: 1, t: "b" }, { id: 2 }];
    const result = merge(base, [{ id: 2 }], theirs, keeptheirs);
    assert.deepEqual(result.value, theirs);
});

test("a removal nobody edited against merges silently", () => {
    const base = [{ id: 1, t: "a" }, { id: 2 }];
    const result = merge(base, [{ id: 2 }], base);
    assert.deepEqual(result, { value: [{ id: 2 }], conflicts: [] });
});

test("a node both sides replaced the same way is no conflict", () => {
    const result = merge({ a: { x: 1 } }, { a: 5 }, { a: 5 });
    assert.deepEqual(result, { value: { a: 5 }, conflicts: [] });
});

test("a node both sides replaced differently is one conflict", () => {
    const result = merge({ a: { x: 1 } }, { a: 5 }, { a: 6 }, keeptheirs);
    assert.deepEqual(result.value, { a: 6 });
    assert.equal(result.conflicts.length, 1);
});

test("key order is not a change", () => {
    const base = [{ id: 1, t: "a", n: 1 }];
    const result = merge(base, [], [{ n: 1, t: "a", id: 1 }]);
    assert.deepEqual(result, { value: [], conflicts: [] });
});

test("a conflict inside a surviving entity is reported", () => {
    const base = [{ id: 1, t: "a" }];
    const result = merge(base, [{ id: 1, t: "b" }], [{ id: 1, t: "c" }]);
    assert.deepEqual(result.conflicts.map((c) => c.pointer), ["/1/t"]);
});
