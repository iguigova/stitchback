// Types for stitchback. The JavaScript is the source of truth;
// test/index.test.js checks that this file and src/index.js export the
// same names.

/** One node of a document, as the merge sees it. */
export type NodeRecord =
    | { kind: "value"; value: unknown }
    | { kind: "object" }
    | { kind: "list"; order: Array<string | number> };

export interface Conflict {
    /** JSON Pointer of the node, such as "/1/title". */
    pointer: string;
    /** Each side's record; undefined where that side has none. */
    base: NodeRecord | undefined;
    ours: NodeRecord | undefined;
    theirs: NodeRecord | undefined;
}

/** Returns conflict.ours or conflict.theirs: the side to keep. */
export type Resolve = (conflict: Conflict) => NodeRecord | undefined;

/** A resource as stored: the server's state at the last sync, and the
 * local copy with every edit made since. */
export interface Stored<T = unknown> {
    url: string;
    base: T;
    ours: T;
}

export interface Synced<T = unknown> {
    /** The local copy after the sync. */
    data: T;
    conflicts: Conflict[];
}

export function openstore(name: string): Promise<IDBDatabase>;
export function closestore(db: IDBDatabase): void;

export function get<T = unknown>(
    db: IDBDatabase, url: URL, ondata: (data: T) => void): Promise<Synced<T>>;
export function local<T = unknown>(
    db: IDBDatabase, url: URL): Promise<Stored<T> | undefined>;
export function edit<T = unknown>(
    db: IDBDatabase, url: URL, data: T): Promise<void>;
export function sync<T = unknown>(
    db: IDBDatabase, url: URL, resolve?: Resolve): Promise<Synced<T>>;

/** The default resolver: keeps the local side. */
export function keepours(conflict: Conflict): NodeRecord | undefined;

/** A request the server refused, with its HTTP status. */
export class RemoteError extends Error {
    constructor(method: string, url: URL | string, status: number);
    status: number;
}

/** The server kept changing under the sync for three attempts. */
export class StaleError extends Error {
    constructor(url: URL | string);
}
