import { parseImageTags } from './tag-parser.js';

/** A provider-independent token estimate used only for budgeting and display. */
export function estimateTokens(value) {
    const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
    let weighted = 0;
    for (const char of text) weighted += char.codePointAt(0) > 0x7f ? 1.5 : 0.25;
    return Math.max(1, Math.ceil(weighted));
}

/**
 * Selects the current assistant message plus at most N-1 earlier user/assistant pairs.
 * @param {Array<{role:string,content:string,name?:string}>} messages
 * @param {number} turns
 */
export function selectDialogueTurns(messages, turns) {
    const limit = Math.max(0, Math.min(100, Number(turns) || 0));
    const currentAssistantIndex = messages.findLastIndex?.(item => item?.role === 'assistant')
        ?? (() => { for (let i = messages.length - 1; i >= 0; i--) if (messages[i]?.role === 'assistant') return i; return -1; })();
    if (currentAssistantIndex < 0) return [];
    if (limit === 0) return [messages[currentAssistantIndex]];
    const pairs = [];
    for (let index = messages.length - 1; index >= 0; index--) {
        const assistant = messages[index];
        if (assistant?.role !== 'assistant') continue;
        let user = null;
        for (let cursor = index - 1; cursor >= 0; cursor--) {
            if (messages[cursor]?.role === 'user') {
                user = messages[cursor];
                break;
            }
            if (messages[cursor]?.role === 'assistant') break;
        }
        pairs.unshift(user ? [user, assistant] : [assistant]);
        if (pairs.length >= limit) break;
    }
    return pairs.flat();
}

/**
 * The current SillyTavern AI reply is source material for the prompt LLM, not
 * an answer previously produced by that LLM. Keep its text byte-for-byte, but
 * present the final selected assistant reply as the user's current request.
 * Earlier roleplay turns retain their original roles for continuity.
 */
export function preparePromptLlmConversation(messages) {
    const output = (Array.isArray(messages) ? messages : []).map(item => ({ ...item }));
    const currentIndex = output.findLastIndex?.(item => item?.role === 'assistant')
        ?? (() => { for (let i = output.length - 1; i >= 0; i--) if (output[i]?.role === 'assistant') return i; return -1; })();
    if (currentIndex >= 0) output[currentIndex].role = 'user';
    return output;
}

/**
 * Drops complete oldest turns, then optional extras in a stable priority order.
 * @param {{messages:Array, extras?:Record<string,string>, mandatory?:Array, maxTokens:number}} input
 */
export function fitContextBudget(input) {
    const maxTokens = Math.max(256, Number(input.maxTokens) || 8000);
    const mandatory = Array.isArray(input.mandatory) ? input.mandatory : [];
    const messages = [...(input.messages || [])];
    const extras = { ...(input.extras || {}) };
    const dropped = { turns: 0, extras: [] };
    const extraOrder = ['worldBook', 'systemPrompt', 'persona', 'characterCard', 'continuityPrompts'];
    const total = () => estimateTokens({ mandatory, messages, extras });

    while (total() > maxTokens && messages.length > 2) {
        messages.splice(0, Math.min(2, messages.length - 1));
        dropped.turns++;
    }
    for (const key of extraOrder) {
        if (total() <= maxTokens) break;
        if (extras[key]) {
            delete extras[key];
            dropped.extras.push(key);
        }
    }
    if (total() > maxTokens) {
        throw new Error('Mandatory prompt content exceeds the configured input token limit.');
    }
    return { messages, extras, estimatedTokens: total(), dropped };
}

const boundedText = (value, fallback = '', max = 100000) => String(value ?? fallback).slice(0, max);

/**
 * Builds Mode 2 context without ever exposing image-control tag bodies.
 * The tag is a front-end trigger only; even a custom client-supplied directive
 * is deliberately absent from the mandatory prompt budget.
 */
export function makeBudgetedContext(config, mode, body) {
    const settings = config.modes[mode] || {};
    const conversation = Array.isArray(body?.conversation)
        ? body.conversation.map(item => ({
            role: item?.role === 'user' ? 'user' : 'assistant',
            content: parseImageTags(boundedText(item?.content, '', 1000000)).cleanedText,
        }))
        : [];
    const messages = selectDialogueTurns(conversation, settings.historyTurns);
    const extras = {};
    const requested = body?.extras && typeof body.extras === 'object' ? body.extras : {};
    if (settings.includeWorldBook) extras.worldBook = boundedText(requested.worldBook, '', 2000000);
    if (settings.includeSystemPrompt) extras.systemPrompt = boundedText(requested.systemPrompt, '', 1000000);
    if (settings.includePersona) extras.persona = boundedText(requested.persona, '', 1000000);
    if (settings.includeCharacterCard) extras.characterCard = boundedText(requested.characterCard, '', 2000000);
    const promptHistoryCount = Math.max(0, Math.min(20, Number(settings.promptHistoryCount) || 0));
    const previousPrompts = Array.isArray(body?.previousPrompts)
        ? body.previousPrompts.map(item => boundedText(item, '', 50000).trim()).filter(Boolean).slice(-promptHistoryCount)
        : [];
    if (previousPrompts.length) extras.continuityPrompts = JSON.stringify(previousPrompts);
    const fitted = fitContextBudget({
        messages,
        extras,
        mandatory: [
            { role: 'system', content: settings.promptTemplate },
        ],
        maxTokens: settings.maxInputTokens,
    });
    return {
        ...fitted,
        previousPromptCount: fitted.extras.continuityPrompts ? previousPrompts.length : 0,
    };
}
