// One sync at a time per resource, across every tab and worker of the
// origin, through the Web Locks API. Where that is missing, as in Node
// before 24.5 or a page served without HTTPS, syncs queue within this
// page only.

const queues = new Map();

function exclusive(name, task) {
    const locks = globalThis.navigator?.locks;
    return locks ? locks.request(name, task) : queued(name, task);
}

// Runs task once every task queued before it under name has settled.
function queued(name, task) {
    const run = (queues.get(name) ?? Promise.resolve()).then(task, task);
    const done = () => {
        if (queues.get(name) === run) queues.delete(name);
    };
    queues.set(name, run);
    run.then(done, done);
    return run;
}

export { exclusive, queued };
