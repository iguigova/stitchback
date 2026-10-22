// An in-memory JSON REST server, so the demo runs with no backend. It
// behaves like a plain one and knows nothing about sync: a collection
// answers GET and POST, an entity in it answers GET, PUT and DELETE, any
// other top-level value answers GET and PUT, and POST assigns the id.

function createserver(data) {
    const state = structuredClone(data);
    return {
        snapshot: () => structuredClone(state),
        fetch: (url, init) => respond(state, url, init)
    };
}

// Answers a fetch call the way the network would.
async function respond(state, url, init) {
    const result = handle(state, {
        method: init.method ?? "GET",
        path: new URL(url).pathname,
        body: init.body === undefined ? undefined : JSON.parse(init.body)
    });
    return new Response(JSON.stringify(result.body), {
        status: result.status,
        headers: { "Content-Type": "application/json" }
    });
}

function handle(state, request) {
    const [name, id, ...rest] = request.path.split("/").filter(Boolean);
    if (!Object.hasOwn(state, name) || rest.length > 0) return reply(404);
    if (Array.isArray(state[name])) {
        return id === undefined
            ? collection(state[name], request)
            : entity(state[name], decodeURIComponent(id), request);
    }
    return id === undefined ? single(state, name, request) : reply(404);
}

function collection(entities, request) {
    if (request.method === "GET") return reply(200, entities);
    if (request.method !== "POST") return reply(405);
    const created = { ...request.body, id: newid() };
    entities.push(created);
    return reply(201, created);
}

function entity(entities, id, request) {
    const index = entities.findIndex((e) => String(e.id) === id);
    if (index === -1) return reply(404);
    if (request.method === "GET") return reply(200, entities[index]);
    if (request.method === "PUT") {
        entities[index] = { ...request.body, id: entities[index].id };
        return reply(200, entities[index]);
    }
    if (request.method !== "DELETE") return reply(405);
    entities.splice(index, 1);
    return reply(200, {});
}

function single(state, name, request) {
    if (request.method === "GET") return reply(200, state[name]);
    if (request.method !== "PUT") return reply(405);
    state[name] = request.body;
    return reply(200, state[name]);
}

function reply(status, body = {}) {
    return { status: status, body: structuredClone(body) };
}

function newid() {
    return crypto.randomUUID().slice(0, 4);
}

export { createserver };
