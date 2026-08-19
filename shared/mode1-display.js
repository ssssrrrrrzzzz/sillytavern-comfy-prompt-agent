import { parseImageTags } from './tag-parser.js';

export const EMPTY_MODE1_DISPLAY = '\u200B';

export function hideMode1ImageTags(extra, rawText) {
    if (!extra || typeof extra !== 'object') return { changed: false, parsed: parseImageTags(rawText) };
    const parsed = parseImageTags(rawText);
    if (!parsed.selected) return { changed: false, parsed };

    const state = extra.comfy_prompt_agent || (extra.comfy_prompt_agent = {});
    const current = typeof extra.display_text === 'string' ? extra.display_text : null;
    let displaySource = String(rawText ?? '');

    // Respect display_text owned by translation/regex extensions. If their
    // version still contains an image tag, remove the tag from that version;
    // if it is already clean, leave it entirely under their ownership.
    const ownsCurrent = state.display_text_owned === true && current === state.display_text_value;
    if (current !== null && current !== String(rawText ?? '') && !ownsCurrent) {
        const displayed = parseImageTags(current);
        if (!displayed.tags.length && current) return { changed: false, parsed, displayText: current };
        if (!displayed.tags.length) displaySource = '';
        else displaySource = current;
    }

    const cleaned = parseImageTags(displaySource).cleanedText.trim();
    const displayText = cleaned || EMPTY_MODE1_DISPLAY;
    const changed = current !== displayText;
    extra.display_text = displayText;
    state.display_text_owned = true;
    state.display_text_value = displayText;
    return { changed, parsed, displayText };
}
