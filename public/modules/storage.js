// One IndexedDB database per replica, holding one record per resource URL:
// { url, base, ours }. Every read and write is a single transaction, so a
// record is never half-written.

const storename = "documents";

function openstore(name) {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(name, 1);
        request.onupgradeneeded = () => createstore(request.result);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

function createstore(db) {
    db.createObjectStore(storename, { keyPath: "url" });
}

function closestore(db) {
    db.close();
}

// Resolves to undefined only when the URL has never been stored.
function load(db, url) {
    return run(db, "readonly", (store) => store.get(url));
}

// Reads a record and writes back change(record) in one transaction, so a
// write made meanwhile is never overwritten. change runs synchronously;
// if it throws, nothing is written and the promise rejects with its error.
function update(db, url, change) {
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(storename, "readwrite");
        const store = transaction.objectStore(storename);
        const request = store.get(url);
        let doc;
        request.onsuccess = () => {
            try {
                doc = change(request.result);
                store.put(doc);
            } catch (error) {
                reject(error);
                transaction.abort();
            }
        };
        transaction.oncomplete = () => resolve(doc);
        transaction.onabort = () => reject(transaction.error);
    });
}

function run(db, mode, operation) {
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(storename, mode);
        const request = operation(transaction.objectStore(storename));
        transaction.oncomplete = () => resolve(request.result);
        transaction.onabort = () => reject(transaction.error);
    });
}

export { openstore, closestore, load, update };
