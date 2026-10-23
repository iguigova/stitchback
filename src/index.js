// stitchback: offline-first for the REST API you already have.

export { openstore, closestore } from "./storage.js";
export {
    get, local, edit, sync, autosync, StaleError
} from "./state.js";
export { keepours } from "./merge.js";
export { RemoteError } from "./fetch.js";
