import assert from 'node:assert/strict';
import test from 'node:test';

import { getStoredSwipe, incomingMessageHasInheritedJob, incomingSwipeIsReady, storedSwipeOwnsJob } from '../shared/swipe-state.js';

test('an overswipe slot is not ready and lookup never creates it', () => {
    const message = {
        swipe_id: 1,
        swipes: ['stored reply'],
        swipe_info: [{ extra: { comfy_prompt_agent: { job_id: 'old' } } }],
        extra: { comfy_prompt_agent: { job_id: 'old' } },
    };
    const before = structuredClone(message);
    assert.equal(getStoredSwipe(message, 1), null);
    assert.deepEqual(message, before);
});

test('job ownership rejects deleted, replaced and stale Swipe targets without mutation', () => {
    const message = {
        swipe_id: 0,
        swipes: ['reply'],
        swipe_info: [{ extra: { comfy_prompt_agent: { job_id: 'new-job', trigger_hash: 'new-trigger' } } }],
    };
    const before = structuredClone(message);
    assert.equal(storedSwipeOwnsJob(message, 1, 'old-job', 'old-trigger'), null);
    assert.equal(storedSwipeOwnsJob(message, 0, 'old-job', 'old-trigger'), null);
    assert.equal(storedSwipeOwnsJob(message, 0, 'new-job', 'old-trigger'), null);
    assert.equal(storedSwipeOwnsJob(message, 0, 'new-job', 'new-trigger')?.swipeId, 0);
    assert.deepEqual(message, before);
});

test('new or changed incoming Swipe rejects an inherited completed job state', () => {
    const overswipe = {
        swipe_id: 1,
        swipes: ['old reply', undefined],
        swipe_info: [{ extra: {} }],
        mes: 'new reply',
        extra: { comfy_prompt_agent: { status: 'completed', original_text: 'old reply' } },
    };
    assert.equal(incomingMessageHasInheritedJob(overswipe, overswipe.mes), true);

    const stored = {
        swipe_id: 0,
        swipes: ['same reply'],
        swipe_info: [{ extra: {} }],
        mes: 'same reply',
        extra: { comfy_prompt_agent: { status: 'completed', original_text: 'same reply' } },
    };
    assert.equal(incomingMessageHasInheritedJob(stored, stored.mes), false);
    stored.mes = 'same reply plus continuation';
    assert.equal(incomingMessageHasInheritedJob(stored, stored.mes), true);
});

test('automatic submission waits for the exact message, Swipe and stored raw text', () => {
    const message = {
        swipe_id: 1,
        swipes: ['old reply', 'new reply'],
        swipe_info: [{ extra: {} }, { extra: {} }],
    };
    assert.equal(incomingSwipeIsReady(message, message, 1, 'new reply'), true);
    assert.equal(incomingSwipeIsReady(message, structuredClone(message), 1, 'new reply'), false);
    assert.equal(incomingSwipeIsReady(message, message, 0, 'old reply'), false);
    assert.equal(incomingSwipeIsReady(message, message, 1, 'different reply'), false);
    delete message.swipe_info[1];
    assert.equal(incomingSwipeIsReady(message, message, 1, 'new reply'), false);
});
