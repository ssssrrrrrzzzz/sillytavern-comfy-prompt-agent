const TRANSIENT_STATUS = new Set([408, 425, 429, 502, 503, 504]);
const TRANSIENT_CODES = new Set([
    'ECONNRESET',
    'ECONNREFUSED',
    'EPIPE',
    'ETIMEDOUT',
    'EAI_AGAIN',
    'ENETDOWN',
    'ENETRESET',
    'ENETUNREACH',
    'EHOSTDOWN',
    'EHOSTUNREACH',
]);

function parseJsonError(value) {
    if (!value || typeof value !== 'object') return '';
    const nested = value.error;
    if (typeof nested === 'string') return nested;
    if (nested && typeof nested === 'object') return String(nested.message || nested.detail || nested.error || '');
    return String(value.message || value.detail || '');
}

function redactErrorText(value) {
    return String(value || '')
        .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+/gi, 'Bearer [REDACTED]')
        .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, 'sk-[REDACTED]')
        .replace(/(["']?(?:api[_-]?key|authorization)["']?\s*[:=]\s*["']?)[^"'\s,}]+/gi, '$1[REDACTED]');
}

export function errorMessage(value, fallback = '请求失败。') {
    if (typeof value === 'string') {
        const text = value.trim();
        if (!text) return fallback;
        try {
            return redactErrorText(parseJsonError(JSON.parse(text)) || text);
        } catch {
            return redactErrorText(text);
        }
    }
    if (value && typeof value === 'object') {
        return redactErrorText(parseJsonError(value) || String(value.message || value.cause?.message || fallback));
    }
    return fallback;
}

function errorCode(value) {
    const candidates = [
        value?.code,
        value?.cause?.code,
        value?.errno,
        value?.cause?.errno,
        errorMessage(value, ''),
    ];
    const joined = candidates.filter(Boolean).join(' ');
    return [...TRANSIENT_CODES].find(code => joined.toLocaleUpperCase().includes(code)) || '';
}

export function isTransientNetworkError(value) {
    if (TRANSIENT_STATUS.has(Number(value?.status))) return true;
    if (errorCode(value)) return true;
    const message = errorMessage(value, '').toLocaleLowerCase();
    return /fetch failed|failed to fetch|network error|socket (?:hang up|disconnected)|network socket disconnected before secure tls connection|timed? ?out|temporarily unavailable/.test(message);
}

export function readableRequestError(value, { label = '请求', attempts = 1 } = {}) {
    const message = errorMessage(value);
    const suffix = attempts > 1 ? `，已自动重试 ${attempts - 1} 次仍失败` : '';
    const code = errorCode(value);
    if (code === 'ECONNRESET' || /network socket disconnected before secure tls connection/i.test(message)) {
        return new Error(`${label}的上游 TLS 连接被重置（ECONNRESET）${suffix}。这不是提示词错误，请稍后重新生成当前 Swipe。`);
    }
    if (code === 'ETIMEDOUT' || /timed? ?out/i.test(message)) {
        return new Error(`${label}连接超时${suffix}。请检查上游服务状态后重试。`);
    }
    if (code === 'ECONNREFUSED') {
        return new Error(`${label}连接被拒绝${suffix}。请检查地址和服务状态。`);
    }
    if (isTransientNetworkError(value)) {
        return new Error(`${label}暂时不可用${suffix}：${message.slice(0, 500)}`);
    }
    return new Error(message.slice(0, 2000));
}

export async function retryDelay(attempt, signal) {
    const delay = attempt <= 1 ? 350 : 900;
    await new Promise((resolve, reject) => {
        if (signal?.aborted) return reject(signal.reason || new Error('请求已取消。'));
        const timer = setTimeout(done, delay);
        function done() {
            signal?.removeEventListener('abort', aborted);
            resolve();
        }
        function aborted() {
            clearTimeout(timer);
            signal?.removeEventListener('abort', aborted);
            reject(signal.reason || new Error('请求已取消。'));
        }
        signal?.addEventListener('abort', aborted, { once: true });
    });
}
