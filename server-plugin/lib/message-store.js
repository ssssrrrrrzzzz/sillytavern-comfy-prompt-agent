import fs from 'node:fs';
import path from 'node:path';

function safeBaseName(value, label) {
    const source = String(value || '');
    const base = path.basename(source);
    if (!base || base !== source || base.includes('\0')) throw new Error(`Invalid ${label}.`);
    return base;
}

function chatPath(directories, target) {
    let chatId = safeBaseName(target?.chatId, 'chat ID');
    if (!chatId.toLowerCase().endsWith('.jsonl')) chatId += '.jsonl';
    if (target?.isGroup) return path.join(directories.groupChats, chatId);
    const avatar = safeBaseName(target?.avatar, 'character avatar').replace(/\.[^/.]+$/, '');
    return path.join(directories.chats, avatar, chatId);
}

function jobMetadata(job) {
    const result = job.result;
    return {
        trigger_hash: job.spec.triggerHash,
        directive: job.spec.directive,
        mode: job.mode,
        job_id: job.id,
        status: job.status,
        error: job.error || '',
        positive_prompt: result?.positivePrompt || '',
        negative_prompt: result?.negativePrompt || '',
        workflow: result?.workflow,
        preset: result?.preset,
        parameters: result?.parameters,
        images: result?.images || [],
        context: result?.context,
        prompt_warnings: result?.promptWarnings || [],
    };
}

/**
 * Writes a completed background job back to the exact persisted chat/swipe.
 * The trigger hash must already exist in the pending metadata, so a stale job
 * can never attach itself to a different or replaced message.
 */
export function writeJobToOriginalSwipe(job) {
    const target = job.spec?.target;
    if (!target || !Number.isInteger(Number(target.messageIndex)) || !Number.isInteger(Number(target.swipeId))) return false;
    const file = chatPath(job.directories, target);
    if (!fs.existsSync(file)) return false;
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    const lineIndex = Number(target.messageIndex) + 1; // JSONL line 0 is chat_metadata.
    if (lineIndex <= 0 || lineIndex >= lines.length) return false;
    const message = JSON.parse(lines[lineIndex]);
    const swipeId = Number(target.swipeId);
    const swipeExtra = message.swipe_info?.[swipeId]?.extra;
    const existing = swipeExtra?.comfy_prompt_agent;
    if (!existing || existing.trigger_hash !== job.spec.triggerHash) return false;

    const metadata = { ...existing, ...jobMetadata(job) };
    swipeExtra.comfy_prompt_agent = metadata;
    if (job.result?.images?.length) {
        swipeExtra.media ||= [];
        for (const image of job.result.images) {
            const url = String(image.path || '').startsWith('/') ? image.path : `/${String(image.path || '').replace(/^\/+/, '')}`;
            if (!swipeExtra.media.some(item => item.url === url)) swipeExtra.media.push({
                type: 'image', url,
                title: `${job.result.workflow?.name || 'ComfyUI'} · ${job.result.preset?.name || ''}`,
                generation_type: 'comfy-prompt-agent',
            });
        }
        swipeExtra.media_display = 'gallery';
        swipeExtra.inline_image = true;
        swipeExtra.media_index = Math.max(0, swipeExtra.media.length - 1);
    }
    if (Number(message.swipe_id ?? 0) === swipeId) message.extra = structuredClone(swipeExtra);
    lines[lineIndex] = JSON.stringify(message);
    const temp = `${file}.${process.pid}.cpa.tmp`;
    fs.writeFileSync(temp, lines.join('\n'), 'utf8');
    fs.renameSync(temp, file);
    return true;
}
