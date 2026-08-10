import { URL } from 'node:url';

export function validateUrl(value, { httpsOnly = false } = {}) {
    const url = new URL(String(value || ''));
    const protocols = httpsOnly ? ['https:'] : ['http:', 'https:'];
    if (!protocols.includes(url.protocol)) throw new Error(`Only ${protocols.join('/')} URLs are allowed.`);
    if (url.username || url.password) throw new Error('Embedded URL credentials are not allowed.');
    return url;
}

export async function fetchWithTimeout(url, options = {}, timeoutMs = 30000, redirectsLeft = 5) {
    const controller = new AbortController();
    const parentSignal = options.signal;
    const onAbort = () => controller.abort(parentSignal.reason);
    parentSignal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(new Error('Request timed out.')), timeoutMs);
    try {
        const response = await fetch(url, { ...options, signal: controller.signal, redirect: 'manual' });
        if ([301, 302, 303, 307, 308].includes(response.status)) {
            if (redirectsLeft <= 0) throw new Error('Too many URL redirects.');
            const location = response.headers.get('location');
            if (!location) throw new Error('Redirect response has no Location header.');
            const next = new URL(location, url);
            validateUrl(next, { httpsOnly: new URL(url).protocol === 'https:' });
            const nextOptions = { ...options };
            if (response.status === 303) { nextOptions.method = 'GET'; delete nextOptions.body; }
            return await fetchWithTimeout(next, nextOptions, timeoutMs, redirectsLeft - 1);
        }
        return response;
    } finally {
        clearTimeout(timer);
        parentSignal?.removeEventListener('abort', onAbort);
    }
}

export async function readResponseLimited(response, maxBytes = 10 * 1024 * 1024) {
    const contentLength = Number(response.headers.get('content-length') || 0);
    if (contentLength > maxBytes) throw new Error('Remote response is too large.');
    const reader = response.body?.getReader();
    if (!reader) return Buffer.from(await response.arrayBuffer());
    const chunks = [];
    let total = 0;
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
            await reader.cancel();
            throw new Error('Remote response is too large.');
        }
        chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks);
}

export function joinUrl(base, suffix) {
    const url = validateUrl(base);
    url.pathname = `${url.pathname.replace(/\/$/, '')}/${String(suffix).replace(/^\//, '')}`;
    return url;
}
