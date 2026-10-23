// A document is flattened into records keyed by JSON Pointer. Each record
// is one node: an object, a list of entities, or a value. A list whose
// elements all carry a unique id is keyed by that id instead of by
// position, so an insert never renames its neighbours. Any other array is
// one atomic value.

// --- pointers ---------------------------------------------------------------

function escape(segment) {
    return String(segment).replaceAll("~", "~0").replaceAll("/", "~1");
}

function unescape(segment) {
    return segment.replaceAll("~1", "/").replaceAll("~0", "~");
}

function child(pointer, segment) {
    return `${pointer}/${escape(segment)}`;
}

function parentof(pointer) {
    return pointer.slice(0, pointer.lastIndexOf("/"));
}

function keyof(pointer) {
    return unescape(pointer.slice(pointer.lastIndexOf("/") + 1));
}

// --- shapes -----------------------------------------------------------------

function isobject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isentity(value) {
    return isobject(value) && ["string", "number"].includes(typeof value.id);
}

function iskeyedlist(value) {
    return Array.isArray(value)
        && value.every(isentity)
        && new Set(value.map((e) => String(e.id))).size === value.length;
}

function idof(entity) {
    return entity.id;
}

function nodeof(value) {
    if (iskeyedlist(value)) return { kind: "list", order: value.map(idof) };
    if (isobject(value)) return { kind: "object" };
    return { kind: "value", value: value };
}

// Deep equality of JSON values. Key order is not part of a value: a server
// may return an object's keys in any order.
function same(a, b) {
    if (a === b) return true;
    if (!isnode(a) || !isnode(b)) return false;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length
        && keys.every((k) => Object.hasOwn(b, k) && same(a[k], b[k]));
}

function isnode(value) {
    return value !== null && typeof value === "object";
}

// --- flatten ----------------------------------------------------------------

function flatten(value, pointer = "", records = new Map()) {
    records.set(pointer, nodeof(value));
    for (const [segment, item] of children(value)) {
        flatten(item, child(pointer, segment), records);
    }
    return records;
}

function children(value) {
    if (iskeyedlist(value)) return value.map((e) => [idof(e), e]);
    if (isobject(value)) return Object.entries(value);
    return [];
}

// --- unflatten --------------------------------------------------------------

function unflatten(records) {
    return records.has("") ? build(records, index(records), "") : undefined;
}

function index(records) {
    const byparent = new Map();
    for (const pointer of records.keys()) {
        if (pointer === "") continue;
        const parent = parentof(pointer);
        if (!byparent.has(parent)) byparent.set(parent, []);
        byparent.get(parent).push(pointer);
    }
    return byparent;
}

function build(records, byparent, pointer) {
    const node = records.get(pointer);
    if (node.kind === "object") return buildobject(records, byparent, pointer);
    if (node.kind === "list") return buildlist(records, byparent, pointer);
    return node.value;
}

function buildobject(records, byparent, pointer) {
    const entries = (byparent.get(pointer) ?? [])
        .map((p) => [keyof(p), build(records, byparent, p)]);
    return Object.fromEntries(entries);
}

function buildlist(records, byparent, pointer) {
    return records.get(pointer).order
        .map((id) => child(pointer, id))
        .filter((p) => records.has(p))
        .map((p) => build(records, byparent, p));
}

export {
    parentof, keyof, isentity, iskeyedlist, same, flatten, unflatten
};
