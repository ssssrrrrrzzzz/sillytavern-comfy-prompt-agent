export function getStoredSwipe(message, swipeId = Number(message?.swipe_id ?? 0)) {
    const id = Number(swipeId);
    if (!message || !Number.isInteger(id) || id < 0) return null;
    if (!Array.isArray(message.swipes) || id >= message.swipes.length) return null;
    const info = message.swipe_info?.[id];
    if (!info || typeof info !== 'object') return null;
    const extra = info.extra;
    if (!extra || typeof extra !== 'object' || Array.isArray(extra)) return null;
    return { swipeId: id, info, extra };
}

export function storedSwipeOwnsJob(message, swipeId, jobId, triggerHash = '') {
    const stored = getStoredSwipe(message, swipeId);
    if (!stored) return null;
    const state = stored.extra.comfy_prompt_agent;
    if (!state || state.job_id !== jobId) return null;
    if (triggerHash && state.trigger_hash !== triggerHash) return null;
    return stored;
}

export function incomingMessageHasInheritedJob(message, rawText) {
    const state = message?.extra?.comfy_prompt_agent;
    if (!state) return false;
    const stored = getStoredSwipe(message, Number(message?.swipe_id ?? 0));
    if (!stored) return true;
    const original = String(state.original_text || '');
    return Boolean(original && original !== String(rawText ?? ''));
}

export function incomingSwipeIsReady(message, expectedMessage, swipeId, rawText) {
    if (!message || message !== expectedMessage) return false;
    const id = Number(swipeId);
    if (Number(message.swipe_id ?? 0) !== id) return false;
    if (!getStoredSwipe(message, id)) return false;
    return String(message.swipes[id]) === String(rawText ?? '');
}
