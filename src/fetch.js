// HTTP against a plain JSON REST API. A response that is not ok raises a
// RemoteError carrying its status; a network failure raises fetch's own
// TypeError, which is how a caller tells offline from refused.

class RemoteError extends Error {
    constructor(method, url, status) {
        super(`${method} ${url} failed with ${status}`);
        this.status = status;
    }
}

const notfound = 404;
const preconditionfailed = 412;

async function getremote(url) {
    const response = await call("GET", url);
    return { data: await response.json(), etag: response.headers.get("ETag") };
}

function sendremote(request) {
    return call(request.method, request.url, request.data, request.etag);
}

async function call(method, url, data, etag) {
    const response = await fetch(url, {
        method: method,
        headers: headers(etag),
        body: data === undefined ? undefined : JSON.stringify(data)
    });
    if (!response.ok) throw new RemoteError(method, url, response.status);
    return response;
}

// If-Match is compared strongly (RFC 9110, section 13.1.1), so a weak
// ETag can never match and is not sent.
function headers(etag) {
    const base = { "Content-Type": "application/json" };
    const strong = etag && !etag.startsWith("W/");
    return strong ? { ...base, "If-Match": etag } : base;
}

export { RemoteError, notfound, preconditionfailed, getremote, sendremote };
