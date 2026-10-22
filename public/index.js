import { openstore } from "./modules/storage.js";
import { get, edit, sync } from "./modules/state.js";

// Each replica is its own IndexedDB database, so two tabs on two replicas
// behave like two devices.

const replica = new URLSearchParams(location.search).get("replica") ?? "a";
const db = await openstore(`localstate-${replica}`);

const $ = (id) => document.getElementById(id);

$("replica").textContent = `· replica ${replica}`;
$("other").href = `?replica=${replica === "a" ? "b" : "a"}`;

// --- rendering --------------------------------------------------------------

function show(data) {
    $("body").value = JSON.stringify(data, null, 2);
    $("body").removeAttribute("aria-invalid");
}

function report(message) {
    $("status").textContent = message;
}

function listconflicts(conflicts) {
    const none = conflicts.length === 0;
    const items = none ? ["None."] : conflicts.map(describe);
    $("conflicts").replaceChildren(...items.map(listitem));
}

function describe(conflict) {
    return `${conflict.pointer}: kept ours ${shown(conflict.ours)}, ` +
        `theirs was ${shown(conflict.theirs)}`;
}

function shown(node) {
    if (node === undefined) return "(deleted)";
    return node.kind === "value" ? JSON.stringify(node.value) : `(${node.kind})`;
}

function listitem(text) {
    const item = document.createElement("li");
    item.textContent = text;
    return item;
}

function failed(error) {
    const offline = error instanceof TypeError;
    report(offline ? "Offline: showing the local copy." : error.message);
}

// --- actions ----------------------------------------------------------------

function url() {
    return new URL($("url").value);
}

function synced(result) {
    listconflicts(result.conflicts);
    report(`Synced at ${new Date().toLocaleTimeString()}.`);
}

function parsed() {
    try {
        return JSON.parse($("body").value);
    } catch (error) {
        $("body").setAttribute("aria-invalid", "true");
        throw new Error(`The local copy is not valid JSON: ${error.message}`);
    }
}

async function load() {
    synced(await get(db, url(), show));
}

async function savelocally() {
    await edit(db, url(), parsed());
    report("Saved locally.");
}

async function syncnow() {
    const result = await sync(db, url());
    show(result.data);
    synced(result);
}

function bind(id, action) {
    $(id).addEventListener("click", () => action().catch(failed));
}

bind("load", load);
bind("save", savelocally);
bind("sync", syncnow);
