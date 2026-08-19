import { validateUrl } from './http.js';
import { newId } from './storage.js';

const MAX_LLM_OUTPUT_TOKENS = 131072;

export const integer = (value, fallback, min, max) => {
    const parsed = value === '' || value === null || value === undefined ? Number(fallback) : Number(value);
    return Math.max(min, Math.min(max, Math.trunc(Number.isFinite(parsed) ? parsed : Number(fallback))));
};

export const decimal = (value, fallback, min, max) => Math.max(min, Math.min(max, Number.isFinite(Number(value)) ? Number(value) : fallback));
export const bool = (value, fallback = false) => value === undefined ? Boolean(fallback) : Boolean(value);
export const text = (value, fallback = '', max = 100000) => String(value ?? fallback).slice(0, max);

export function normalizeModeSettings(input, current) {
    const output = {
        ...current,
        profileId: text(input?.profileId, current.profileId, 100),
        historyTurns: integer(input?.historyTurns, current.historyTurns, 0, 100),
        promptHistoryCount: integer(input?.promptHistoryCount, current.promptHistoryCount, 0, 20),
        maxInputTokens: integer(input?.maxInputTokens, current.maxInputTokens, 256, 1000000),
        maxOutputTokens: integer(input?.maxOutputTokens, current.maxOutputTokens, 16, MAX_LLM_OUTPUT_TOKENS),
        timeoutSeconds: integer(input?.timeoutSeconds, current.timeoutSeconds, 1, 3600),
        includeCharacterCard: bool(input?.includeCharacterCard, current.includeCharacterCard),
        includePersona: bool(input?.includePersona, current.includePersona),
        includeSystemPrompt: bool(input?.includeSystemPrompt, current.includeSystemPrompt),
        includeWorldBook: bool(input?.includeWorldBook, current.includeWorldBook),
        worldBooks: Array.isArray(input?.worldBooks) ? input.worldBooks.map(String).slice(0, 100) : current.worldBooks,
    };
    output.promptTemplate = text(input?.promptTemplate, current.promptTemplate);
    return output;
}

export function profileFromBody(body, current = {}) {
    const extraJson = body?.extraJson && typeof body.extraJson === 'object' && !Array.isArray(body.extraJson) ? body.extraJson : {};
    const requestedId = current.id || text(body?.id || newId('llm'), '', 100);
    if (!/^[a-zA-Z0-9_-]+$/.test(requestedId)) throw new Error('Invalid LLM Profile ID.');
    return {
        ...current,
        id: requestedId,
        name: text(body?.name, current.name || 'LLM Profile', 120),
        baseUrl: validateUrl(text(body?.baseUrl, current.baseUrl || '')).toString().replace(/\/$/, ''),
        model: text(body?.model, current.model || '', 300),
        temperature: decimal(body?.temperature, current.temperature ?? 0.4, 0, 2),
        topP: decimal(body?.topP, current.topP ?? 1, 0, 1),
        maxOutputTokens: integer(body?.maxOutputTokens, current.maxOutputTokens || 1024, 16, MAX_LLM_OUTPUT_TOKENS),
        timeoutSeconds: integer(body?.timeoutSeconds, current.timeoutSeconds || 120, 1, 3600),
        extraJson,
        secretKey: current.secretKey || `api_key_comfy_prompt_agent_${requestedId}`,
        hasApiKey: Boolean(current.hasApiKey),
    };
}

export function normalizeComfySettings(input, current) {
    return {
        ...current,
        url: validateUrl(text(input?.url, current.url)).toString().replace(/\/$/, ''),
        authType: ['none', 'bearer', 'basic'].includes(input?.authType) ? input.authType : current.authType,
        concurrency: integer(input?.concurrency, current.concurrency, 1, 8),
        maxQueue: integer(input?.maxQueue, current.maxQueue, 1, 100),
        timeoutSeconds: integer(input?.timeoutSeconds, current.timeoutSeconds, 10, 3600),
        secretKey: current.secretKey || 'api_key_comfy_prompt_agent_comfy',
    };
}
