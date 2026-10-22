import { openstore, closestore, load } from "./modules/storage.js";
import { edit, sync } from "./modules/state.js";
import { flatten, keyof, parentof, same } from "./modules/json.js";
import { createserver } from "./demo/server.js";

// The page plays a whole system: two devices, each with its own IndexedDB
// database, and one plain REST server. The server runs in this page unless
// ?api= names a real one, such as ?api=http://localhost:3000/posts.

const demoorigin = "https://server.localstate.demo";
const latency = 300;
const savedkey = "localstate-demo";
const loglength = 8;

const seed = await (await fetch("db.json")).json();
const api = new URLSearchParams(location.search).get("api");
const url = new URL(api ?? `${demoorigin}/posts`);
const saved = restore();
const server = createserver(saved.server ?? seed);
const realfetch = window.fetch.bind(window);

const devices = [
    { key: "laptop", name: "Ada's laptop", author: "ada" },
    { key: "phone", name: "Grace's phone", author: "grace" }
];

const requests = [];
let caller = "";
let rescued = saved.rescued ?? 0;
let queue = Promise.resolve();

// --- the network ------------------------------------------------------------

window.fetch = async (input, init = {}) => {
    const target = new URL(input, location.href);
    const response = await network(target, init);
    record(init.method ?? "GET", target, response.status);
    return response;
};

async function network(target, init) {
    if (target.origin !== demoorigin) return realfetch(target, init);
    await new Promise((resolve) => setTimeout(resolve, latency));
    const response = await server.fetch(target, init);
    persist();
    return response;
}

function record(method, target, status) {
    requests.unshift({ who: caller, method, path: target.pathname, status });
    requests.length = Math.min(requests.length, loglength);
    renderserver();
}

// What the server holds now, read without a request in the log.
async function peek() {
    const source = url.origin === demoorigin ? server.fetch : realfetch;
    return (await source(url, { method: "GET" })).json();
}

// --- remembering the demo across reloads ------------------------------------

// Storage can be missing, as in a private window; the demo then still works
// but starts over on reload.
function restore() {
    try {
        return JSON.parse(localStorage.getItem(savedkey)) ?? {};
    } catch {
        return {};
    }
}

function persist() {
    const online = Object.fromEntries(devices.map((d) => [d.key, d.online]));
    const state = { server: server.snapshot(), online, rescued };
    try {
        localStorage.setItem(savedkey, JSON.stringify(state));
    } catch {
        // see restore
    }
}

// --- what the devices do ----------------------------------------------------

function enqueue(device, action) {
    queue = queue
        .then(action)
        .catch((error) => { device.note = failure(error); })
        .then(renderall);
}

function failure(error) {
    if (error instanceof TypeError) {
        return "The server is unreachable; edits stay on this device.";
    }
    return error.message;
}

async function start(device) {
    const doc = await load(device.db, url.href);
    if (doc === undefined || device.online) await syncone(device);
}

async function change(device, transform) {
    const doc = await load(device.db, url.href);
    device.conflicts = [];
    await edit(device.db, url, transform(doc.ours));
    if (device.online) await syncfrom(device);
}

function update(device, id, name, value) {
    const set = (p) => String(p.id) === id ? { ...p, [name]: value } : p;
    return change(device, (posts) => posts.map(set));
}

function add(device) {
    const id = `new-${crypto.randomUUID().slice(0, 4)}`;
    const post = { id: id, title: "", author: device.author };
    device.focus = `${device.key}-${id}-title`;
    return change(device, (posts) => [...posts, post]);
}

function remove(device, id) {
    return change(device, (posts) => posts.filter((p) => String(p.id) !== id));
}

async function setonline(device, online) {
    device.online = online;
    device.conflicts = [];
    persist();
    if (online) await syncfrom(device);
}

// The device that acted syncs first; every other online device follows,
// as a poll or a push would make it.
async function syncfrom(device) {
    const others = devices.filter((d) => d !== device);
    for (const d of [device, ...others].filter((d) => d.online)) {
        await syncone(d);
    }
}

async function syncone(device) {
    caller = device.name;
    const doc = await load(device.db, url.href);
    if (doc !== undefined) rescued += overwritten(doc, await peek());
    const result = await sync(device.db, url);
    if (result.conflicts.length > 0) device.conflicts = result.conflicts;
    device.note = "";
    persist();
}

// --- counting edits ---------------------------------------------------------

// Edits made elsewhere that writing this device's copy back whole, the
// usual offline fallback, would have erased.
function overwritten(doc, theirs) {
    if (same(doc.ours, doc.base)) return 0;
    const versions = [doc.base, doc.ours, theirs];
    const [base, ours, server] = versions.map((v) => flatten(v));
    return fields(base, server)
        .filter((p) => differs(base, server, p) && !differs(base, ours, p))
        .length;
}

function unsynced(doc) {
    const [base, ours] = [doc.base, doc.ours].map((v) => flatten(v));
    return fields(base, ours).filter((p) => differs(base, ours, p)).length;
}

function fields(...versions) {
    const pointers = new Set(versions.flatMap((v) => [...v.keys()]));
    return [...pointers].filter((p) => keyof(p) !== "id"
        && versions.some((v) => v.get(p)?.kind === "value"));
}

function differs(a, b, pointer) {
    return !same(a.get(pointer), b.get(pointer));
}

// --- rendering --------------------------------------------------------------

function el(tag, attributes = {}, ...children) {
    const node = document.createElement(tag);
    for (const [name, value] of Object.entries(attributes)) {
        if (value === true) node.setAttribute(name, "");
        else if (value !== false && value !== undefined) {
            node.setAttribute(name, value);
        }
    }
    node.append(...children.filter((c) => c !== undefined));
    return node;
}

async function renderall() {
    await Promise.all([...devices.map(renderdevice), renderserver()]);
}

async function renderdevice(device) {
    const doc = await load(device.db, url.href);
    const section = document.getElementById(device.key);
    const view = el("div", {}, ...devicehead(device), status(device, doc),
        postlist(device, doc), addbutton(device), conflictlist(device));
    patch(section, view);
    if (device.focus) document.getElementById(device.focus)?.focus();
    device.focus = undefined;
}

function devicehead(device) {
    const toggle = el("input", {
        type: "checkbox",
        role: "switch",
        id: `${device.key}-online`,
        "data-action": "online",
        checked: device.online
    });
    return [
        el("h2", { id: `${device.key}-name` }, device.name),
        el("label", { class: "switch" }, toggle, " Online")
    ];
}

function status(device, doc) {
    const waiting = doc === undefined ? 0 : unsynced(doc);
    const text = device.note || statustext(device.online, waiting);
    return el("p", { class: "status", role: "status" }, text);
}

function statustext(online, waiting) {
    const changes = `${waiting} ${waiting === 1 ? "change" : "changes"}`;
    if (online) return waiting === 0 ? "In sync." : `${changes} to sync.`;
    return waiting === 0
        ? "Offline. Edits stay here until you reconnect."
        : `Offline. ${changes} waiting.`;
}

function postlist(device, doc) {
    const list = doc?.ours ?? [];
    return el("ol", { class: "posts" },
        ...list.map((post) => postitem(device, doc.base, post)));
}

function postitem(device, base, post) {
    const known = base.find((p) => String(p.id) === String(post.id));
    const title = known ? `Post #${post.id}` : "New post, not synced yet";
    const name = post.title || "untitled";
    const button = el("button", {
        type: "button",
        class: "delete",
        id: `${device.key}-${post.id}-delete`,
        "data-action": "delete",
        "data-id": post.id,
        "aria-label": `Delete “${name}”`
    }, "Delete");
    return el("li", {}, el("fieldset", { class: "post" },
        el("legend", {}, title),
        field(device, known, post, "title", "Title"),
        field(device, known, post, "author", "Author"),
        button));
}

function field(device, known, post, name, label) {
    const id = `${device.key}-${post.id}-${name}`;
    const edited = known !== undefined && !same(known[name], post[name]);
    const mark = edited
        ? el("span", { class: "mark" }, "not synced")
        : undefined;
    return el("div", { class: "field" },
        el("label", { for: id }, label, mark),
        el("input", {
            id: id,
            value: post[name] ?? "",
            autocomplete: "off",
            "data-id": post.id,
            "data-field": name
        }));
}

function addbutton(device) {
    return el("button", {
        type: "button",
        class: "add",
        id: `${device.key}-add`,
        "data-action": "add"
    }, "Add post");
}

function conflictlist(device) {
    if (device.conflicts.length === 0) return undefined;
    const count = device.conflicts.length;
    const items = device.conflicts.map((c) => el("li", {}, describe(c)));
    return el("div", { class: "conflicts", role: "alert" },
        el("h3", {}, count === 1 ? "1 conflict" : `${count} conflicts`),
        el("ul", {}, ...items));
}

function describe(conflict) {
    return `${place(conflict.pointer)}: kept this device's ` +
        `${shown(conflict.ours)}; the server had ${shown(conflict.theirs)}.`;
}

function place(pointer) {
    const parent = parentof(pointer);
    if (parent === "") return `Post #${keyof(pointer)}`;
    return `Post #${keyof(parent)}, ${keyof(pointer)}`;
}

function shown(node) {
    if (node === undefined) return "deletion";
    if (node.kind !== "value") return node.kind;
    const value = node.value;
    return typeof value === "string" ? `“${value}”` : JSON.stringify(value);
}

async function renderserver() {
    const section = document.getElementById("server");
    const where = url.origin === demoorigin
        ? "Running in this page."
        : `At ${url.origin}.`;
    patch(section, el("div", {},
        el("h2", { id: "server-name" }, "Server"),
        el("p", { class: "lede" },
            `${where} Plain REST: GET, POST, PUT, DELETE. No sync endpoint.`),
        servertable(await peek()),
        el("h3", {}, "Requests"),
        requestlog(),
        el("h3", {}, "Saved by the merge"),
        score()));
}

function servertable(list) {
    const row = (p) => el("tr", {},
        el("td", {}, String(p.id)), el("td", {}, p.title ?? ""),
        el("td", {}, p.author ?? ""));
    return el("table", {},
        el("caption", {}, "Posts on the server"),
        el("thead", {}, el("tr", {},
            el("th", { scope: "col" }, "Id"),
            el("th", { scope: "col" }, "Title"),
            el("th", { scope: "col" }, "Author"))),
        el("tbody", {}, ...list.map(row)));
}

function requestlog() {
    if (requests.length === 0) {
        return el("p", { class: "log-empty" }, "No requests yet.");
    }
    const item = (r) => el("li", { class: r.status < 300 ? "ok" : "bad" },
        el("span", { class: "who" }, r.who),
        el("code", {}, `${r.method} ${r.path}`),
        el("span", { class: "code" }, String(r.status)));
    return el("ol", { class: "log" }, ...requests.map(item));
}

function score() {
    const edits = rescued === 1 ? "edit" : "edits";
    return el("p", { class: "score", role: "status" },
        el("strong", {}, String(rescued)),
        ` ${edits} from the other device that writing a copy back whole ` +
        "would have erased. localstate merged them.");
}

// Updates the page in place, so a field being typed in keeps its focus,
// its cursor and its text. Nodes are matched by position, and every
// handler reads data attributes, never a closure over one render.
function patch(current, next) {
    const [have, want] = [[...current.childNodes], [...next.childNodes]];
    have.slice(want.length).forEach((node) => node.remove());
    want.forEach((node, i) => {
        if (i >= have.length) current.append(node);
        else if (!alike(have[i], node)) have[i].replaceWith(node);
        else patchnode(have[i], node);
    });
}

function alike(a, b) {
    return a.nodeName === b.nodeName && a.nodeType === b.nodeType;
}

function patchnode(current, next) {
    if (current.nodeType === Node.TEXT_NODE) {
        if (current.data !== next.data) current.data = next.data;
        return;
    }
    for (const { name } of [...current.attributes]) {
        if (!next.hasAttribute(name)) current.removeAttribute(name);
    }
    for (const { name, value } of [...next.attributes]) {
        if (current.getAttribute(name) !== value) {
            current.setAttribute(name, value);
        }
    }
    if (current instanceof HTMLInputElement) updateinput(current, next);
    patch(current, next);
}

function updateinput(current, next) {
    current.checked = next.hasAttribute("checked");
    if (current !== document.activeElement) {
        current.value = next.getAttribute("value") ?? "";
    }
}

// --- wiring -----------------------------------------------------------------

function bind(device) {
    const section = document.getElementById(device.key);
    section.addEventListener("change", (event) => onchange(device, event));
    section.addEventListener("click", (event) => onclick(device, event));
}

function onchange(device, event) {
    const target = event.target;
    if (target.dataset.action === "online") {
        const online = target.checked;
        enqueue(device, () => setonline(device, online));
    } else if (target.dataset.field) {
        const { id, field } = target.dataset;
        const value = target.value;
        enqueue(device, () => update(device, id, field, value));
    }
}

function onclick(device, event) {
    const button = event.target.closest("button");
    if (button?.dataset.action === "add") {
        enqueue(device, () => add(device));
    } else if (button?.dataset.action === "delete") {
        enqueue(device, () => remove(device, button.dataset.id));
    }
}

async function reset() {
    for (const device of devices) {
        closestore(device.db);
        await removedatabase(`localstate-demo-${device.key}`);
    }
    try {
        localStorage.removeItem(savedkey);
    } catch {
        // see restore
    }
    location.reload();
}

function removedatabase(name) {
    return new Promise((resolve, reject) => {
        const request = indexedDB.deleteDatabase(name);
        request.onsuccess = resolve;
        request.onblocked = resolve;
        request.onerror = () => reject(request.error);
    });
}

for (const device of devices) {
    device.db = await openstore(`localstate-demo-${device.key}`);
    device.online = saved.online?.[device.key] ?? true;
    device.conflicts = [];
    device.note = "";
    bind(device);
}

document.getElementById("reset").addEventListener("click", () => {
    queue = queue.then(reset);
});

for (const device of devices) enqueue(device, () => start(device));
