import { fetchWithTimeout, validateUrl } from './http.js';

const RESERVED_PAYLOAD = new Set(['messages', 'model', 'stream', 'tools', 'tool_choice', 'max_tokens', 'temperature', 'top_p']);

function endpoint(baseUrl, path) {
    const url = validateUrl(baseUrl);
    let pathname = url.pathname.replace(/\/$/, '');
    if (!/\/v\d+(?:beta)?$/i.test(pathname)) pathname += '/v1';
    url.pathname = `${pathname}/${path}`;
    return url;
}

export function parseJsonObject(text) {
    const value = String(text || '').trim();
    const fenced = value.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] ?? value;
    try {
        const parsed = JSON.parse(fenced);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch {
        const start = fenced.indexOf('{');
        const end = fenced.lastIndexOf('}');
        if (start >= 0 && end > start) {
            const parsed = JSON.parse(fenced.slice(start, end + 1));
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
        }
    }
    throw new Error('LLM response is not a JSON object.');
}

export class OpenAICompatibleClient {
    constructor(profile, apiKey) {
        this.profile = profile;
        this.apiKey = apiKey || '';
    }

    headers() {
        return { 'Content-Type': 'application/json', ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}) };
    }

    async models(signal) {
        const response = await fetchWithTimeout(endpoint(this.profile.baseUrl, 'models'), { headers: this.headers(), signal }, Number(this.profile.timeoutSeconds || 120) * 1000);
        if (!response.ok) throw new Error(`Model list failed (${response.status}): ${await response.text()}`);
        const body = await response.json();
        return (body.data || []).map(item => item.id).filter(Boolean).sort();
    }

    async complete(messages, { tools, maxTokens, signal, forceNoTools = false } = {}) {
        const extra = this.profile.extraJson && typeof this.profile.extraJson === 'object' ? this.profile.extraJson : {};
        const safeExtra = Object.fromEntries(Object.entries(extra).filter(([key]) => !RESERVED_PAYLOAD.has(key)));
        const payload = {
            ...safeExtra,
            model: this.profile.model,
            messages,
            stream: false,
            temperature: Number(this.profile.temperature ?? 0.4),
            top_p: Number(this.profile.topP ?? 1),
            max_tokens: Number(maxTokens || this.profile.maxOutputTokens || 1024),
        };
        if (tools?.length && !forceNoTools) {
            payload.tools = tools;
            payload.tool_choice = 'auto';
        }
        const response = await fetchWithTimeout(endpoint(this.profile.baseUrl, 'chat/completions'), { method: 'POST', headers: this.headers(), body: JSON.stringify(payload), signal }, Number(this.profile.timeoutSeconds || 120) * 1000);
        if (!response.ok) throw new Error(`LLM request failed (${response.status}): ${(await response.text()).slice(0, 2000)}`);
        const body = await response.json();
        const message = body.choices?.[0]?.message;
        if (!message) throw new Error('LLM returned no assistant message.');
        return {
            content: message.content || '',
            reasoningContent: message.reasoning_content || '',
            toolCalls: message.tool_calls || [],
            rawMessage: message,
            usage: body.usage || {},
            finishReason: body.choices?.[0]?.finish_reason ?? null,
        };
    }
}

function emptyPromptError(response, maxTokens) {
    const completionTokens = response?.usage?.completion_tokens;
    const reasoningTokens = response?.usage?.completion_tokens_details?.reasoning_tokens;
    const details = [
        `finish_reason=${response?.finishReason ?? 'unknown'}`,
        `completion_tokens=${Number.isFinite(Number(completionTokens)) ? completionTokens : 'unknown'}`,
        `reasoning_tokens=${Number.isFinite(Number(reasoningTokens)) ? reasoningTokens : 'unknown'}`,
        `max_tokens=${maxTokens}`,
    ];
    return new Error(`模式 2 LLM 未返回最终 Prompt（${details.join('，')}）。思考过程可能耗尽输出额度，请提高模式 2 的最大输出 token。`);
}

export function parsePositivePromptText(text) {
    const value = String(text || '').trim();
    if (!value) throw new Error('Mode 2 returned an empty prompt.');
    if (/```/.test(value)) throw new Error('Mode 2 returned Markdown instead of a plain prompt.');
    if (/^[{[]/.test(value)) throw new Error('Mode 2 returned JSON instead of a plain prompt.');
    if (/^(?:positive[_ ]?prompt|prompt)\s*:/i.test(value)) throw new Error('Mode 2 returned a label instead of only the prompt.');
    if (/\bnegative[_ ]prompt\s*[:=]/i.test(value)) throw new Error('negative_prompt is not allowed.');
    if (/\r|\n/.test(value)) throw new Error('Mode 2 must return exactly one line.');
    return value;
}

const ANIMA_WORKFLOW_OWNED_TAGS = new Set([
    'masterpiece', 'best quality', 'high quality', 'highres', 'absurdres',
    'very aesthetic', 'newest', 'year 2025',
]);

function isAnimaOwnedTag(tag) {
    const lower = tag.toLocaleLowerCase();
    return ANIMA_WORKFLOW_OWNED_TAGS.has(lower)
        || /^score\s*[1-9](?:\s*(?:up|or above))?$/.test(lower)
        || /^year\s+\d{4}$/.test(lower)
        || lower.startsWith('@')
        || /^artist\s*:/.test(lower);
}

export function normalizeAnimaPromptText(text) {
    const tags = parsePositivePromptText(text).split(',').map(tag => tag.trim()).filter(Boolean);
    const normalized = [];
    const seen = new Set();
    for (const rawTag of tags) {
        const spaced = rawTag.replaceAll('_', ' ').replace(/\s+/g, ' ').trim();
        const tag = /^break$/i.test(spaced) ? 'BREAK' : spaced.toLocaleLowerCase();
        if (!tag || isAnimaOwnedTag(tag)) continue;
        // Preserve every optional BREAK token exactly as the model returned it.
        if (tag === 'BREAK') {
            normalized.push(tag);
            continue;
        }
        const key = tag.toLocaleLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        normalized.push(tag);
    }
    if (!normalized.length) throw new Error('Anima prompt became empty after normalization.');
    return normalized.join(', ');
}

function parseForDialect(text, dialect) {
    if (dialect !== 'anima') return parsePositivePromptText(text);
    return normalizeAnimaPromptText(text);
}

function repairInstruction(promptTemplate) {
    return `Repair the supplied response so it follows this user-configured Mode 2 prompt:\n\n${promptTemplate}\n\nReturn exactly one line containing only the corrected positive prompt.`;
}

export async function generatePositivePrompt(client, messages, maxTokens, signal, { dialect = 'generic', promptTemplate = '' } = {}) {
    let response = await client.complete(messages, { maxTokens, signal, forceNoTools: true });
    if (!String(response.content || '').trim()) throw emptyPromptError(response, maxTokens);
    try {
        return { positivePrompt: parseForDialect(response.content, dialect), usage: response.usage, repairs: 0 };
    } catch (firstError) {
        response = await client.complete([
            { role: 'system', content: repairInstruction(promptTemplate) },
            { role: 'user', content: response.content },
        ], { maxTokens, signal, forceNoTools: true });
        if (!String(response.content || '').trim()) {
            throw new Error(`模式 2 格式修复请求失败：${emptyPromptError(response, maxTokens).message} 原始错误：${firstError.message}`);
        }
        try {
            return { positivePrompt: parseForDialect(response.content, dialect), usage: response.usage, repairs: 1 };
        } catch (repairError) {
            throw new Error(`Mode 2 plain-prompt repair failed: ${repairError.message}; original error: ${firstError.message}`);
        }
    }
}
