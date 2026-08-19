import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { BrowserRuntime } from '../browser-runtime.js';

const bundledWorkflow = JSON.parse(fs.readFileSync(new URL('../server-plugin/bundled/workflows/Anima-API.json', import.meta.url), 'utf8'));

function json(value, status = 200) {
    return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
}

function runtimeFixture({ llmResponses = ['1girl, solo, black_hair, blue_eyes'], llmFailures = [] } = {}) {
    const requests = [];
    const storage = {};
    let saves = 0;
    const fetchImpl = async (url, options = {}) => {
        const target = String(url);
        const body = typeof options.body === 'string' ? JSON.parse(options.body) : options.body;
        requests.push({ target, body, options });
        if (target === 'asset:server-plugin/bundled/workflows/Anima-API.json') return json(bundledWorkflow);
        if (target.startsWith('http://127.0.0.1:8188/')) throw new TypeError('CORS blocked direct browser request');
        if (target === '/api/sd/comfy/ping') return new Response('', { status: 200 });
        if (target === '/api/sd/comfy/models') return json([{ value: 'anima-aesthetic-v1.1.safetensors', text: 'Anima' }]);
        if (target === '/api/sd/comfy/samplers') return json(['er_sde']);
        if (target === '/api/sd/comfy/schedulers') return json(['simple']);
        if (target === '/api/sd/comfy/vaes') return json(['qwen_image_vae.safetensors']);
        if (target === '/api/sd/comfy/generate') return json({ format: 'png', data: 'aW1hZ2U=' });
        if (target === '/api/images/upload') return json({ path: '/user/images/Comfy-Prompt-Agent/test.png' });
        if (target === '/api/backends/chat-completions/status') return json({ data: [{ id: 'prompt-model' }] });
        if (target === '/api/backends/chat-completions/generate') {
            const failure = llmFailures.shift();
            if (failure instanceof Error) throw failure;
            if (failure) return json(failure.body, failure.status || 500);
            return json({ choices: [{ message: { role: 'assistant', content: llmResponses.shift() ?? '1girl, solo, black_hair, blue_eyes' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10 } });
        }
        throw new Error(`Unexpected fetch: ${target}`);
    };
    const runtime = new BrowserRuntime({
        storage,
        save: () => { saves++; },
        headers: () => ({ 'Content-Type': 'application/json', 'X-CSRF-Token': 'test' }),
        assetUrl: relative => `asset:${relative}`,
        fetchImpl,
    });
    return { runtime, storage, requests, saves: () => saves };
}

async function completed(runtime, id) {
    for (let attempt = 0; attempt < 400; attempt++) {
        const job = await runtime.handle(`/jobs/${id}`);
        if (['completed', 'failed', 'cancelled'].includes(job.status)) return job;
        await new Promise(resolve => setTimeout(resolve, 5));
    }
    throw new Error('Browser job did not finish.');
}

test('browser runtime seeds a ready-to-run Anima workflow without a server plugin', async () => {
    const fixture = runtimeFixture();
    const health = await fixture.runtime.handle('/health');
    const config = await fixture.runtime.handle('/config');

    assert.equal(health.browserRuntime, true);
    assert.equal(config.workflows.length, 1);
    assert.equal(config.workflows[0].name, 'Anima · API（内置）');
    assert.equal(config.workflows[0].presets[0].positiveTargets[0].nodeId, '161:165');
    assert.equal(config.mode, 1);
    assert.deepEqual(Object.keys(config.modes), ['2']);
    assert.equal(config.skills, undefined);
    assert.equal(fixture.storage.config.resourceDiscovery.browserDefaultsVersion, 1);
    assert.ok(fixture.saves() > 0);
});

test('browser runtime refreshes dynamic ComfyUI values through SillyTavern built-in proxies', async () => {
    const { runtime } = runtimeFixture();
    await runtime.handle('/comfy/test', { method: 'POST', body: {} });
    const info = await runtime.handle('/comfy/object-info');

    assert.deepEqual(info.UNETLoader.input.required.unet_name[0], ['anima-aesthetic-v1.1.safetensors']);
    assert.deepEqual(info.KSampler.input.required.sampler_name[0], ['er_sde']);
    assert.deepEqual(info.KSampler.input.required.scheduler[0], ['simple']);
    assert.deepEqual(info.VAELoader.input.required.vae_name[0], ['qwen_image_vae.safetensors']);
});

test('browser runtime rejects insecure remote imports and credential-bearing URLs', async () => {
    const { runtime } = runtimeFixture();
    await assert.rejects(runtime.handle('/workflows/url', { method: 'POST', body: { url: 'https://user:password@example.com/workflow.json' } }), /不能包含用户名或密码/);
});

test('browser Mode 1 generates through the built-in ComfyUI proxy and keeps preset negatives', async () => {
    const fixture = runtimeFixture();
    const config = await fixture.runtime.handle('/config');
    const created = await fixture.runtime.handle('/jobs', { method: 'POST', body: {
        mode: 1,
        directive: '1girl, solo, black hair, blue eyes',
        workflowId: config.selectedWorkflowId,
        presetId: config.selectedPresetId,
        triggerHash: 'mode1-test',
    } });
    const job = await completed(fixture.runtime, created.id);

    assert.equal(job.status, 'completed', job.error);
    assert.equal(job.result.images[0].path, '/user/images/Comfy-Prompt-Agent/test.png');
    assert.equal(job.result.positivePrompt, '1girl, solo, black hair, blue eyes');
    assert.ok(job.result.negativePrompt.length > 100);
    const comfyRequest = fixture.requests.find(item => item.target === '/api/sd/comfy/generate');
    const payload = JSON.parse(comfyRequest.body.prompt);
    assert.equal(payload.prompt['161:165'].inputs.value, '1girl, solo, black hair, blue eyes');
    assert.equal(payload.prompt['161:159'].inputs.text, job.result.negativePrompt);
    const uploadRequest = fixture.requests.find(item => item.target === '/api/images/upload');
    assert.equal(uploadRequest.body.image, 'aW1hZ2U=');
    assert.equal(uploadRequest.body.format, 'png');
});

test('browser Mode 2 uses the independent custom LLM proxy and strips image tag bodies', async () => {
    const fixture = runtimeFixture();
    const saved = await fixture.runtime.handle('/llm-profiles', { method: 'POST', body: {
        name: 'Prompt LLM', baseUrl: 'http://127.0.0.1:1234/v1', apiKey: 'private-test-key', model: 'prompt-model', maxOutputTokens: 2048, timeoutSeconds: 120,
    } });
    const models = await fixture.runtime.handle('/llm-profiles/test', { method: 'POST', body: { id: saved.id, name: 'Prompt LLM', baseUrl: 'http://127.0.0.1:1234/v1', model: 'prompt-model' } });
    assert.deepEqual(models.models, ['prompt-model']);
    const config = await fixture.runtime.handle('/config');
    assert.equal(config.modes[2].profileId, saved.id);
    await fixture.runtime.handle('/config', { method: 'PUT', body: { mode: 2, modes: { 2: config.modes[2] } } });
    const created = await fixture.runtime.handle('/jobs', { method: 'POST', body: {
        mode: 2,
        directive: '',
        workflowId: config.selectedWorkflowId,
        presetId: config.selectedPresetId,
        triggerHash: 'mode2-test',
        conversation: [{ role: 'user', content: 'draw the current scene' }, { role: 'assistant', content: 'She stands by the window. <image>secret tag body</image>' }],
        previousPrompts: ['1girl, consistent blue eyes'],
        extras: {},
    } });
    const job = await completed(fixture.runtime, created.id);

    assert.equal(job.status, 'completed', job.error);
    assert.equal(job.result.positivePrompt, '1girl, solo, black hair, blue eyes');
    const llmRequest = fixture.requests.find(item => item.target === '/api/backends/chat-completions/generate');
    assert.equal(llmRequest.body.messages[0].content, config.modes[2].promptTemplate);
    assert.match(llmRequest.body.messages[0].content, /You are an Anima prompt engineer/);
    assert.doesNotMatch(JSON.stringify(llmRequest.body.messages), /The selected workflow uses Anima/);
    assert.equal(JSON.stringify(llmRequest.body.messages).includes('secret tag body'), false);
    assert.equal(llmRequest.body.messages.at(-1).role, 'user');
    assert.equal(llmRequest.body.messages.at(-1).content, 'She stands by the window.');
    assert.match(llmRequest.body.custom_include_headers, /private-test-key/);
});

test('browser Mode 2 retries transient TLS resets without changing the user prompt or messages', async () => {
    const reset = { status: 200, body: { error: { message: 'request failed', code: 'ECONNRESET' } } };
    const fixture = runtimeFixture({ llmFailures: [reset] });
    const profile = await fixture.runtime.handle('/llm-profiles', { method: 'POST', body: {
        name: 'Prompt LLM', baseUrl: 'https://example.test/v1', apiKey: 'private-test-key', model: 'prompt-model', maxOutputTokens: 2048,
    } });
    const config = await fixture.runtime.handle('/config');
    const customPrompt = 'KEEP THIS EXACT CUSTOM MODE 2 PROMPT';
    config.mode = 2;
    config.modes[2].profileId = profile.id;
    config.modes[2].promptTemplate = customPrompt;
    await fixture.runtime.handle('/config', { method: 'PUT', body: config });
    const created = await fixture.runtime.handle('/jobs', { method: 'POST', body: {
        mode: 2,
        workflowId: config.selectedWorkflowId,
        presetId: config.selectedPresetId,
        triggerHash: 'mode2-retry-test',
        conversation: [{ role: 'assistant', content: 'A girl stands near a window.' }],
        previousPrompts: [],
        extras: {},
    } });
    const job = await completed(fixture.runtime, created.id);

    assert.equal(job.status, 'completed', job.error);
    const attempts = fixture.requests.filter(item => item.target === '/api/backends/chat-completions/generate');
    assert.equal(attempts.length, 2);
    assert.equal(attempts[0].body.messages[0].content, customPrompt);
    assert.deepEqual(attempts[1].body.messages, attempts[0].body.messages);
    assert.equal((await fixture.runtime.handle('/config')).modes[2].promptTemplate, customPrompt);
});

test('browser Mode 2 reports a concise TLS error after retries', async () => {
    const reset = { status: 500, body: { error: { message: 'request to https://example.test/v1/chat/completions failed: Client network socket disconnected before secure TLS connection was established', code: 'ECONNRESET' } } };
    const fixture = runtimeFixture({ llmFailures: [reset, reset] });
    const profile = await fixture.runtime.handle('/llm-profiles', { method: 'POST', body: {
        name: 'Prompt LLM', baseUrl: 'https://example.test/v1', apiKey: 'private-test-key', model: 'prompt-model', maxOutputTokens: 2048,
    } });
    const config = await fixture.runtime.handle('/config');
    config.mode = 2;
    config.modes[2].profileId = profile.id;
    config.modes[2].promptTemplate = 'DO NOT MODIFY ME';
    await fixture.runtime.handle('/config', { method: 'PUT', body: config });
    const created = await fixture.runtime.handle('/jobs', { method: 'POST', body: {
        mode: 2,
        workflowId: config.selectedWorkflowId,
        presetId: config.selectedPresetId,
        triggerHash: 'mode2-retry-failure-test',
        conversation: [{ role: 'assistant', content: 'Current scene.' }],
        previousPrompts: [],
        extras: {},
    } });
    const job = await completed(fixture.runtime, created.id);

    assert.equal(job.status, 'failed');
    assert.match(job.error, /上游 TLS 连接被重置.*自动重试 1 次仍失败.*不是提示词错误/);
    assert.doesNotMatch(job.error, /^\{/);
    assert.equal((await fixture.runtime.handle('/config')).modes[2].promptTemplate, 'DO NOT MODIFY ME');
});

test('browser runtime migrates only built-in Mode 2 prompts and preserves user text', async () => {
    const legacy = 'Infer the scene to illustrate from the supplied recent roleplay conversation, current AI reply, and optional context. Convert it into one detailed Danbooru-style image-generation positive prompt; no image tag is required. Describe only visible content in one coherent composition. Never request a contact sheet, character sheet, collage, grid, panels, lineup, or multiple views. Output exactly one line containing only the final prompt, with no label, explanation, Markdown, JSON, or negative prompt.';
    const migrated = runtimeFixture();
    migrated.storage.config = { modes: { 2: { promptTemplate: legacy } } };
    assert.match((await migrated.runtime.handle('/config')).modes[2].promptTemplate, /You are an Anima prompt engineer/);

    const custom = runtimeFixture();
    custom.storage.config = { modes: { 2: { promptTemplate: 'my visible custom prompt' } } };
    assert.equal((await custom.runtime.handle('/config')).modes[2].promptTemplate, 'my visible custom prompt');
});

test('browser runtime repairs an existing single Profile that was not linked to Mode 2', async () => {
    const fixture = runtimeFixture();
    fixture.storage.config = {
        llmProfiles: [{
            id: 'llm_ocg', name: 'ocg', baseUrl: 'http://127.0.0.1:1234/v1', apiKey: 'private-test-key', model: 'prompt-model',
        }],
        modes: { 2: { profileId: '' } },
    };

    const config = await fixture.runtime.handle('/config');

    assert.equal(config.modes[2].profileId, 'llm_ocg');
    assert.equal(fixture.storage.config.modes[2].profileId, 'llm_ocg');
});

test('browser runtime migrates legacy mode 3 and rejects new mode-3 jobs', async () => {
    const fixture = runtimeFixture();
    fixture.storage.config = { mode: 3, modes: { 3: { profileId: 'legacy' } } };
    const config = await fixture.runtime.handle('/config');
    assert.equal(config.mode, 2);
    assert.deepEqual(Object.keys(config.modes), ['2']);
    await assert.rejects(fixture.runtime.handle('/jobs', { method: 'POST', body: { mode: 3 } }), /只支持模式 1 或模式 2/);
});
