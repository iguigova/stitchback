import { test } from "node:test";
import assert from "node:assert/strict";
import { exclusive, queued } from "../src/lock.js";

// queued is the fallback where Web Locks is missing; exclusive uses Web
// Locks where the runtime has them, as Node does from 24.5.

for (const [name, lock] of [["queued", queued], ["exclusive", exclusive]]) {
    test(`${name} runs tasks under one name one at a time`, async () => {
        const events = [];
        const task = (id) => async () => {
            events.push(`start ${id}`);
            await new Promise((resolve) => setTimeout(resolve, 5));
            events.push(`end ${id}`);
            return id;
        };
        const results = await Promise.all([
            lock(`${name} one`, task(1)), lock(`${name} one`, task(2))
        ]);
        assert.deepEqual(results, [1, 2]);
        assert.deepEqual(events, ["start 1", "end 1", "start 2", "end 2"]);
    });

    test(`${name} runs the next task after one fails`, async () => {
        const failing = lock(`${name} two`, async () => {
            throw new Error("boom");
        });
        const next = lock(`${name} two`, async () => "ran");
        await assert.rejects(failing, /boom/);
        assert.equal(await next, "ran");
    });
}
