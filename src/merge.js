import {
    parentof, keyof, same, flatten, unflatten, childrenof
} from "./json.js";

// Three-way merge, one record at a time. base is the last state both sides
// agreed on, ours is the local copy, theirs is what the server holds now.
// A side that left a record as it was in base yields to the side that
// changed it; two different changes to one record are a conflict, settled
// by resolve. Absent records count as values, so a deletion is a change.
//
// One conflict spans many records: a side that removes or replaces a node
// while the other changes something beneath it. The node's own record
// looks untouched on the editing side, so record by record the removal
// would win unreported. These are settled first, a subtree at a time.

function keepours(conflict) {
    return conflict.ours;
}

function merge(base, ours, theirs, resolve = keepours) {
    const sides = {
        base: flatten(base),
        ours: flatten(ours),
        theirs: flatten(theirs)
    };
    const conflicts = [];
    settleremovals(sides, resolve, conflicts);
    const merged = new Map();
    for (const pointer of pointers(sides)) {
        const node = mergenode(sides, pointer, resolve, conflicts);
        if (node !== undefined) merged.set(pointer, node);
    }
    return { value: unflatten(merged), conflicts: conflicts };
}

function pointers(sides) {
    const { base, ours, theirs } = sides;
    return new Set([...ours.keys(), ...theirs.keys(), ...base.keys()]);
}

function mergenode(sides, pointer, resolve, conflicts) {
    const [b, o, t] = [sides.base, sides.ours, sides.theirs]
        .map((side) => side.get(pointer));
    if (same(o, t) || same(t, b)) return o;
    if (same(o, b)) return t;
    if (o?.kind === "list" && t?.kind === "list") return mergelist(b, o, t);
    const conflict = { pointer: pointer, base: b, ours: o, theirs: t };
    conflicts.push(conflict);
    return resolve(conflict);
}

// --- lists ------------------------------------------------------------------

// Membership merges as sets; theirs decides the order of what both sides
// kept, and entities ours added follow it.
function mergelist(b, o, t) {
    const before = ids(b?.kind === "list" ? b.order : []);
    const mine = ids(o.order);
    const removed = (id) => before.has(String(id)) && !mine.has(String(id));
    const kept = t.order.filter((id) => !removed(id));
    const known = ids(kept);
    const added = o.order.filter((id) => !before.has(String(id)));
    const fresh = added.filter((id) => !known.has(String(id)));
    return { kind: "list", order: [...kept, ...fresh] };
}

function ids(order) {
    return new Set(order.map(String));
}

// --- removals ---------------------------------------------------------------

// Base is walked parents first, so once a node is settled every node
// beneath it agrees on both sides, or differs only as one side's own edit.
function settleremovals(sides, resolve, conflicts) {
    for (const [pointer, node] of sides.base) {
        if (node.kind === "value") continue;
        for (const [mine, other] of [["ours", "theirs"], ["theirs", "ours"]]) {
            if (!removes(sides, mine, other, pointer)) continue;
            const conflict = {
                pointer: pointer,
                base: node,
                ours: sides.ours.get(pointer),
                theirs: sides.theirs.get(pointer)
            };
            conflicts.push(conflict);
            const kept = resolve(conflict);
            restore(sides, kept === conflict.ours ? "theirs" : "ours", pointer);
        }
    }
}

// mine removed or replaced the node at pointer, and other changed
// something beneath it.
function removes(sides, mine, other, pointer) {
    const node = sides[mine].get(pointer);
    if (node !== undefined && node.kind === sides.base.get(pointer).kind) {
        return false;
    }
    const theirs = subtree(sides[other], pointer);
    return !same(theirs, subtree(sides.base, pointer))
        && !same(theirs, subtree(sides[mine], pointer));
}

function subtree(records, pointer) {
    const index = indexof(records);
    const found = {};
    const visit = (p) => {
        found[p] = records.get(p);
        for (const child of index.get(p) ?? []) visit(child);
    };
    if (records.has(pointer)) visit(pointer);
    return found;
}

// Each side's parent-to-children index, built on first use.
const indexes = new WeakMap();

function indexof(records) {
    if (!indexes.has(records)) indexes.set(records, childrenof(records));
    return indexes.get(records);
}

// Gives the losing side base's subtree back, so the merge that follows
// sees only the winner's changes. The side's index follows along.
function restore(sides, loser, pointer) {
    const records = sides[loser];
    const index = indexof(records);
    const had = records.has(pointer);
    for (const p of Object.keys(subtree(records, pointer))) {
        records.delete(p);
        index.delete(p);
    }
    const before = indexof(sides.base);
    for (const [p, node] of Object.entries(subtree(sides.base, pointer))) {
        records.set(p, node);
        if (before.has(p)) index.set(p, [...before.get(p)]);
    }
    if (pointer === "") return;
    if (!had) {
        const siblings = index.get(parentof(pointer)) ?? [];
        index.set(parentof(pointer), [...siblings, pointer]);
    }
    const parent = records.get(parentof(pointer));
    const was = sides.base.get(parentof(pointer));
    if (parent?.kind === "list" && was.kind === "list") {
        const order = reinsert(parent.order, was.order, keyof(pointer));
        records.set(parentof(pointer), { kind: "list", order: order });
    }
}

// Puts id back after the nearest entity that preceded it in base, so a
// side that only removed it ends up with base's order again.
function reinsert(order, before, id) {
    const present = ids(order);
    if (present.has(id)) return order;
    const at = before.findIndex((e) => String(e) === id);
    const anchor = before.slice(0, at).findLast((e) => present.has(String(e)));
    const index = order.findIndex((e) => String(e) === String(anchor)) + 1;
    return [...order.slice(0, index), before[at], ...order.slice(index)];
}

export { merge, keepours };
