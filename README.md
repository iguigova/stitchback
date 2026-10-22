# localstate

**Offline-first for the REST API you already have.**

[![tests](https://github.com/iguigova/localstate-poc/actions/workflows/pages.yml/badge.svg)](https://github.com/iguigova/localstate-poc/actions/workflows/pages.yml)

### ▶ [Try the live demo](https://iguigova.github.io/localstate-poc/)

Two devices and one server, in your browser. Take a device offline, edit
on both, bring it back, and watch every edit survive.

---

People edit on trains, in basements and in the field. When they reconnect,
most apps do one of two things:

- **Write their copy back whole.** Whatever a colleague changed in the
  meantime is silently gone, even in fields this user never touched.
- **Adopt a sync engine.** It merges well, and it brings its own server,
  protocol or database with it. That is a rewrite, and not an option when
  the API belongs to someone else.

localstate is the third way. It keeps a local copy of any JSON resource,
lets people edit it with or without a connection, and on reconnect merges
their edits **field by field** with what changed on the server. The server
stays exactly as it is: if it speaks `GET`, `POST`, `PUT` and `DELETE`, it
works.

- **No backend changes.** No sync endpoint, no metadata, no new database.
- **Nothing lost silently.** Edits to different fields always merge. Two
  different edits to the same field are the only conflict, and you get
  told about it.
- **Small.** Five dependency-free ES modules, about 400 lines.

## How it works

![How localstate works: the app edits a local copy; a sync fetches the
server's state, merges base, ours and theirs record by record, and writes
only the difference back](docs/how-it-works.svg)

Every resource is kept as three versions of the same document:

| Version  | What it is                                            |
|----------|-------------------------------------------------------|
| `base`   | The server's state at the last successful sync        |
| `ours`   | The local copy, with every edit made since            |
| `theirs` | What the server holds right now, fetched at sync time |

A sync is a **three-way merge**, the mechanism `git merge` uses. Each
document is flattened into records keyed by
[JSON Pointer](https://www.rfc-editor.org/rfc/rfc6901), such as
`/1/title`, and each record is decided on its own: changed on one side
only, that side wins; changed the same way on both, nothing to do; changed
differently on both, a **conflict**, settled by a resolver you supply. A
missing record is a value like any other, so a deletion is a change and
merges by the same rules.

**Entities, not positions.** An array whose elements all carry a unique
`id` is keyed by that id, so `/42/title` means post 42 wherever it sits.
Inserting a post renames nothing, and additions and removals from both
sides merge as sets. Any other array is a single value.

**Writing back.** Only the difference between the merge and `theirs` is
sent, in the shape REST expects. A collection is written entity by entity:
`POST` added, `PUT` changed, `DELETE` removed. Anything else is one `PUT`,
carrying `If-Match` when the server sent an `ETag`; a `412` means someone
wrote first, so localstate fetches, re-merges and retries, up to three
attempts. Afterwards a fresh `GET` becomes the new `base`, which is also
how ids the server assigns replace the placeholders used offline.

## The theory, briefly

Distributed state has two famous answers. **CRDTs** make every operation
commute, so replicas converge with no coordinator, at the price of
metadata on every value and a sync layer that understands it.
**Operational transformation** needs a central server that transforms
every operation.

A REST API already *is* a central server. It serializes writes and owns
the truth, so a client does not need commutativity; it needs to know
**what it changed**. Keeping `base` gives exactly that. `ours` against
`base` is the user's intent, `theirs` against `base` is everyone else's,
and a three-way merge combines the two while naming the only real
conflicts. HTTP has always named the failure this prevents: the "lost
update" ([RFC 9110 §13.1.1](https://www.rfc-editor.org/rfc/rfc9110#section-13.1.1)).
`If-Match` refuses the stale write; localstate goes one step further and
merges it.

## How it compares

Checked against each project's documentation on 2026-10-22.

| Approach | What the server needs | Concurrent edits |
|---|---|---|
| Replay queued requests, e.g. TanStack Query's paused mutations | Nothing new | Replayed in order on reconnect; the docs leave conflicts to the app ([mutations guide](https://tanstack.com/query/v5/docs/framework/react/guides/mutations)) |
| Replication protocol, e.g. RxDB | Pull and push handlers and a change stream ([RxDB replication](https://rxdb.info/replication.html)) | Resolved per document by a handler; the default keeps the server's state |
| Sync engine, e.g. Zero | Its own sync service plus a push endpoint ([Zero mutators](https://zero.rocicorp.dev/docs/mutators)) | Server-authoritative mutators, re-run on the server |
| CRDT library, e.g. Automerge or Yjs | A sync layer that speaks its format | Converge automatically, at the cost of a CRDT document format |
| **localstate** | **Nothing new** | **Merged field by field; same-field edits reported** |

**Where it fits:** forms, settings, CRUD screens and field-work apps on an
API you cannot or would rather not change, where edits are occasional and
a lost one is expensive.

**Where it does not:** real-time co-editing of the same text, where CRDTs
such as Yjs are the right tool, and very large collections, which are
merged whole on every sync.

## Try it locally

Requires Node 22.12 or newer.

```sh
npm install
npm start
```

- <http://localhost:3000/> is the demo, with its server running in the
  page.
- <http://localhost:3000/?api=http://localhost:3000/posts> points both
  devices at a real [json-server](https://github.com/typicode/json-server)
  instead. `npm start` serves a working copy, `data.json`, so the seed in
  `public/db.json` stays clean; delete `data.json` to start over.

## API

```js
import { openstore } from "./modules/storage.js";
import { get, edit, sync } from "./modules/state.js";

const db = await openstore("my-app");            // one database per replica
const url = new URL("https://api.example.com/posts");

await get(db, url, render);   // render(local) at once, then render(synced)
await edit(db, url, posts);   // save an edit locally; works offline
const { data, conflicts } = await sync(db, url, resolve);
```

- **`get(db, url, ondata)`** calls `ondata` with the local copy straight
  away, if there is one, then syncs and calls it again with the result.
- **`edit(db, url, data)`** replaces the local copy. The resource must
  have been fetched once, so there is a `base` to merge against.
- **`sync(db, url, resolve)`** merges and writes back. It returns the
  server's state and the conflicts it settled. Offline, it rejects with
  fetch's `TypeError` and leaves the local copy untouched. A refused
  request rejects with a `RemoteError` carrying the HTTP status.
- **`resolve(conflict)`** receives `{ pointer, base, ours, theirs }`. Each
  side is a record (`{ kind: "value", value }`, `{ kind: "object" }` or
  `{ kind: "list", order }`) or `undefined` for deleted, and `resolve`
  returns the side to keep. The default keeps ours.

## Limits

Each of these is a design choice worth knowing:

- **Same-field edits need a resolver.** The default keeps the local edit
  and reports the server's value it replaced.
- **Deleting an entity beats a concurrent edit inside it,** and that edit
  is not reported.
- **Collections have a small race window.** Entity writes carry no
  `If-Match`, because a collection listing has no per-entity `ETag`. A
  write landing between localstate's fetch and its own can be
  overwritten. Single resources with an `ETag` are fully guarded.
- **Creates are not idempotent when the server assigns ids.** If a sync
  fails after a `POST` succeeded, the next sync can post the entity again.
- **Arrays without ids are atomic.** `["a", "b"]` merges as one value.
- **One sync at a time per replica.** A sync replaces the local copy with
  the merged result.
- **The resource must round-trip.** What `GET` returns is what `PUT`
  accepts, so views such as `?_embed=` are read-only for this purpose.

## Development

```sh
npm test
```

33 tests run on Node's built-in runner. They cover the flattening, every
merge rule, the demo's server, and sync between replicas through a real
json-server, including offline, deletion, conflicts and a server that
enforces `ETag`. The run fails below 100% line coverage of
`public/modules` and `public/demo`. Every push runs them on GitHub
Actions, and a green `main` publishes `public/` as the live demo.

| Module                      | Responsibility                               |
|-----------------------------|----------------------------------------------|
| `public/modules/json.js`    | flatten a document into records and back     |
| `public/modules/merge.js`   | three-way merge of records                   |
| `public/modules/state.js`   | `get`, `edit`, `sync`, and writing back      |
| `public/modules/storage.js` | one IndexedDB store of `{ url, base, ours }` |
| `public/modules/fetch.js`   | HTTP with `ETag` and typed errors            |
| `public/demo/server.js`     | the demo's in-page REST server               |

## License

MIT
