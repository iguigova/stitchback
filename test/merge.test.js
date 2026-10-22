import { test } from "node:test";
import assert from "node:assert/strict";
import { merge } from "../public/modules/merge.js";

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

test("a conflict under a node the merge replaced is dropped", () => {
    const base = { a: { x: 1 } };
    const result = merge(base, { a: 5 }, { a: { x: 2 } });
    assert.deepEqual(result.value, { a: 5 });
    assert.deepEqual(result.conflicts, []);
});

test("a conflict under a removed entity is dropped", () => {
    const base = [{ id: 1, t: "a" }];
    const result = merge(base, [], [{ id: 1, t: "b" }]);
    assert.deepEqual(result, { value: [], conflicts: [] });
});

test("a conflict inside a surviving entity is reported", () => {
    const base = [{ id: 1, t: "a" }];
    const result = merge(base, [{ id: 1, t: "b" }], [{ id: 1, t: "c" }]);
    assert.deepEqual(result.conflicts.map((c) => c.pointer), ["/1/t"]);
});
