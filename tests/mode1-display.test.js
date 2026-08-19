import assert from 'node:assert/strict';
import test from 'node:test';

import { EMPTY_MODE1_DISPLAY, hideMode1ImageTags } from '../shared/mode1-display.js';

test('Mode 1 hides image tags only in display_text and preserves raw Swipe text', () => {
    const raw = '叙事正文\n<image>image###1girl, red twintails, amber eyes###</image>';
    const message = { mes: raw, swipes: [raw], extra: {} };
    const result = hideMode1ImageTags(message.extra, raw);
    assert.equal(result.changed, true);
    assert.equal(message.extra.display_text, '叙事正文');
    assert.equal(message.mes, raw);
    assert.equal(message.swipes[0], raw);
});

test('a tag-only Mode 1 message uses a zero-width placeholder instead of falling back to raw text', () => {
    const extra = {};
    hideMode1ImageTags(extra, '<image>image###1girl, red hair###</image>');
    assert.equal(extra.display_text, EMPTY_MODE1_DISPLAY);
    assert.equal(extra.display_text.length, 1);
});

test('Mode 1 does not overwrite a clean display_text owned by another extension', () => {
    const extra = { display_text: 'translated visible narration' };
    const result = hideMode1ImageTags(extra, '正文<image>1girl</image>');
    assert.equal(result.changed, false);
    assert.equal(extra.display_text, 'translated visible narration');
});

test('an empty external display_text becomes a zero-width placeholder', () => {
    const extra = { display_text: '' };
    const result = hideMode1ImageTags(extra, '<image>1girl</image>');
    assert.equal(result.changed, true);
    assert.equal(extra.display_text, EMPTY_MODE1_DISPLAY);
});
