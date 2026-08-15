const IMAGE_TAG = /<image\b[^>]*>([\s\S]*?)<\/image\s*>/gi;

/**
 * Extracts image directives and returns message text without image tags.
 * Both <image>prompt</image> and <image>image###prompt###</image> are accepted.
 * @param {string} source
 */
export function parseImageTags(source) {
    const text = String(source ?? '');
    const tags = [];
    let match;
    IMAGE_TAG.lastIndex = 0;
    while ((match = IMAGE_TAG.exec(text)) !== null) {
        const raw = match[0];
        const inner = String(match[1] ?? '').trim();
        const wrapped = inner.match(/^image\s*###([\s\S]*?)###\s*$/i);
        const directive = String(wrapped ? wrapped[1] : inner).trim();
        tags.push({ raw, directive, start: match.index, end: IMAGE_TAG.lastIndex });
    }

    const cleanedText = text.replace(IMAGE_TAG, '').replace(/\n{3,}/g, '\n\n').trim();
    const selectedIndex = tags.findIndex(tag => tag.directive.length > 0);
    return {
        cleanedText,
        // `trigger` is the first tag even when its body is empty. Mode 2
        // do not require it, but still ignore its body when one is present.
        trigger: tags[0] || null,
        selected: selectedIndex >= 0 ? tags[selectedIndex] : null,
        tags,
        ignored: selectedIndex >= 0 ? tags.filter((_, index) => index !== selectedIndex) : tags,
    };
}

export function modeRequiresImageTag(mode) {
    return Number(mode) === 1;
}

export function fnv1a(value) {
    let hash = 0x811c9dc5;
    for (const char of String(value ?? '')) {
        hash ^= char.charCodeAt(0);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
}
