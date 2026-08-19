import assert from 'node:assert/strict';
import test from 'node:test';

import { estimateTokens, fitContextBudget, makeBudgetedContext, preparePromptLlmConversation, selectDialogueTurns } from '../shared/context.js';
import { fnv1a, modeRequiresImageTag, parseImageTags } from '../shared/tag-parser.js';

test('parses both image tag syntaxes and hides every tag', () => {
    const result = parseImageTags('正文\n<image>  first scene  </image>\n中间<image>image###second\nscene###</image>尾');
    assert.equal(result.selected.directive, 'first scene');
    assert.equal(result.trigger.directive, 'first scene');
    assert.equal(result.ignored.length, 1);
    assert.equal(result.ignored[0].directive, 'second\nscene');
    assert.equal(result.cleanedText, '正文\n\n中间尾');
});

test('skips empty image tags and uses the first non-empty tag', () => {
    const result = parseImageTags('<image> </image>A<image>image### valid ###</image><image>later</image>');
    assert.equal(result.selected.directive, 'valid');
    assert.equal(result.ignored.length, 2);
    assert.equal(result.cleanedText, 'A');
    assert.equal(parseImageTags('normal reply').selected, null);
    assert.equal(fnv1a('same'), fnv1a('same'));
});

test('empty tag remains a presence-only trigger for mode 2', () => {
    const result = parseImageTags('visible<image> </image>reply');
    assert.equal(result.selected, null);
    assert.equal(result.trigger.directive, '');
    assert.equal(result.cleanedText, 'visiblereply');
});

test('only Mode 1 requires an image tag', () => {
    assert.equal(modeRequiresImageTag(1), true);
    assert.equal(modeRequiresImageTag(2), false);
});

test('mode 2 context strips every image tag and never budgets directive content', () => {
    const markerSecret = 'SECRET_TAG_BODY_MUST_NOT_REACH_LLM';
    const config = { modes: {
        2: { historyTurns: 4, maxInputTokens: 8000, promptTemplate: 'Generate from conversation.' },
    } };
    const result = makeBudgetedContext(config, 2, {
        directive: markerSecret,
        conversation: [
            { role: 'user', content: 'show the current scene' },
            { role: 'assistant', content: `visible reply<image>${markerSecret}</image>` },
        ],
    });
    assert.equal(result.messages.at(-1).content, 'visible reply');
    assert.doesNotMatch(JSON.stringify(result), new RegExp(markerSecret));
});

test('mode 2 includes only the configured recent positive prompts as continuity data', () => {
    const config = { modes: {
        2: { historyTurns: 1, promptHistoryCount: 2, maxInputTokens: 8000, promptTemplate: 'Generate.' },
    } };
    const result = makeBudgetedContext(config, 2, {
        conversation: [{ role: 'assistant', content: 'current scene<image></image>' }],
        previousPrompts: ['old style', 'same character, blue eyes', 'same character, blue eyes, new outfit'],
    });
    assert.deepEqual(JSON.parse(result.extras.continuityPrompts), ['same character, blue eyes', 'same character, blue eyes, new outfit']);
    assert.equal(result.previousPromptCount, 2);
    assert.doesNotMatch(result.messages[0].content, /<image>/);
});

const dialogue = [
    { role: 'user', content: 'u1' }, { role: 'assistant', content: 'a1' },
    { role: 'user', content: 'u2' }, { role: 'assistant', content: 'a2' },
    { role: 'user', content: 'u3' }, { role: 'assistant', content: 'a3 current' },
];

test('history turns are complete pairs while zero still retains current assistant', () => {
    assert.deepEqual(selectDialogueTurns(dialogue, 0), [dialogue[5]]);
    assert.deepEqual(selectDialogueTurns(dialogue, 1), dialogue.slice(4));
    assert.deepEqual(selectDialogueTurns(dialogue, 2), dialogue.slice(2));
    assert.deepEqual(selectDialogueTurns(dialogue, 100), dialogue);
});

test('prompt LLM receives the current AI scene as an unchanged user request', () => {
    const prepared = preparePromptLlmConversation(dialogue);
    assert.deepEqual(prepared.slice(0, -1), dialogue.slice(0, -1));
    assert.equal(prepared.at(-1).role, 'user');
    assert.equal(prepared.at(-1).content, dialogue.at(-1).content);
    assert.equal(dialogue.at(-1).role, 'assistant');
});

test('budget drops oldest complete turns, then extras in required order', () => {
    const mandatory = [{ role: 'system', content: 'fixed' }];
    const extras = { worldBook: '世'.repeat(100), systemPrompt: '系'.repeat(100), persona: '人'.repeat(100), characterCard: '角'.repeat(100) };
    const full = estimateTokens({ mandatory, messages: dialogue, extras });
    const result = fitContextBudget({ mandatory, messages: dialogue, extras, maxTokens: Math.floor(full * 0.45) });
    assert.equal(result.messages.at(-1).content, 'a3 current');
    assert.ok(result.dropped.turns > 0);
    assert.deepEqual(result.dropped.extras.slice(0, 2), ['worldBook', 'systemPrompt']);
});

test('mandatory content exceeding limit fails instead of silent truncation', () => {
    assert.throws(() => fitContextBudget({ mandatory: ['文'.repeat(1000)], messages: [dialogue.at(-1)], maxTokens: 256 }), /Mandatory prompt content/);
});
