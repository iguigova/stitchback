import { parentof, keyof, same, flatten, unflatten } from "./json.js";

// Three-way merge, one record at a time. base is the last state both sides
// agreed on, ours is the local copy, theirs is what the server holds now.
// A side that left a record as it was in base yields to the side that
// changed it; two different changes to one record are a conflict, settled
// by resolve. Absent records count as values, so a deletion is a change.

function keepours(conflict) {
    return conflict.ours;
}

function merge(base, ours, theirs, resolve = keepours) {
    const sides = {
        base: flatten(base),
        ours: flatten(ours),
        theirs: flatten(theirs)
    };
    const merged = new Map();
    const conflicts = [];
    for (const pointer of pointers(sides)) {
        const node = mergenode(sides, pointer, resolve, conflicts);
        if (node !== undefined) merged.set(pointer, node);
    }
    return {
        value: unflatten(merged),
        conflicts: conflicts.filter((c) => reachable(merged, c.pointer))
    };
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

// --- conflicts --------------------------------------------------------------

// A conflict under a node the merge dropped or replaced is moot.
function reachable(records, pointer) {
    if (pointer === "") return true;
    const parent = records.get(parentof(pointer));
    return parent !== undefined
        && contains(parent, pointer)
        && reachable(records, parentof(pointer));
}

function contains(parent, pointer) {
    if (parent.kind === "object") return true;
    if (parent.kind === "list") return ids(parent.order).has(keyof(pointer));
    return false;
}

export { merge, keepours };
