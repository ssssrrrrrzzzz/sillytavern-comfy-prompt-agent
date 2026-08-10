import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { BrowserRuntime } from '../browser-runtime.js';

const bundledWorkflow = JSON.parse(fs.readFileSync(new URL('../server-plugin/bundled/workflows/Anima-API.json', import.meta.url), 'utf8'));

function json(value, status = 200) {
    return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
}

function runtimeFixture({ llmResponses = ['1girl, solo, black_hair, blue_eyes'] } = {}) {
    const requests = [];
    const storage = {};
    let saves = 0;
    const fetchImpl = async (url, options = {}) => {
        const target = String(url);
        const body = typeof options.body === 'string' ? JSON.parse(options.body) : options.body;
        requests.push({ target, body, options });
        if (target === 'asset:server-plugin/bundled/workflows/Anima-API.json') return json(bundledWorkflow);
        if (target.includes('server-plugin/bundled/anima-prompt/SKILL.md')) return new Response('---\nname: anima-prompt\n---\nAnima instructions');
        if (target.includes('server-plugin/bundled/anima-prompt/references/')) return new Response('# Reference\nvisible scene tags');
        if (target.startsWith('http://127.0.0.1:8188/')) throw new TypeError('CORS blocked direct browser request');
        if (target === '/api/sd/comfy/ping') return new Response('', { status: 200 });
        if (target === '/api/sd/comfy/models') return json([{ value: 'anima-aesthetic-v1.1.safetensors', text: 'Anima' }]);
        if (target === '/api/sd/comfy/samplers') return json(['er_sde']);
        if (target === '/api/sd/comfy/schedulers') return json(['simple']);
        if (target === '/api/sd/comfy/vaes') return json(['qwen_image_vae.safetensors']);
        if (target === '/api/sd/comfy/generate') return json({ format: 'png', data: 'aW1hZ2U=' });
        if (target === '/api/images/upload') return json({ path: '/user/images/Comfy-Prompt-Agent/test.png' });
        if (target === '/api/backends/chat-completions/status') return json({ data: [{ id: 'prompt-model' }] });
        if (target === '/api/backends/chat-completions/generate') return json({ choices: [{ message: { role: 'assistant', content: llmResponses.shift() ?? '1girl, solo, black_hair, blue_eyes' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10 } });
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
    for (let attempt = 0; attempt < 100; attempt++) {
        const job = await runtime.handle(`/jobs/${id}`);
        if (['completed', 'failed', 'cancelled'].includes(job.status)) return job;
        await new Promise(resolve => setTimeout(resolve, 5));
    }
    throw new Error('Browser job did not finish.');
}

test('browser runtime seeds Anima workflow and Skill without a server plugin', async () => {
    const fixture = runtimeFixture();
    const health = await fixture.runtime.handle('/health');
    const config = await fixture.runtime.handle('/config');

    assert.equal(health.browserRuntime, true);
    assert.equal(config.workflows.length, 1);
    assert.equal(config.workflows[0].name, 'Anima · API（内置）');
    assert.equal(config.workflows[0].presets[0].positiveTargets[0].nodeId, '161:165');
    assert.equal(config.skills[0].id, 'anima-prompt');
    assert.equal(config.skills[0].references.length, 5);
    assert.equal(config.skills[0].scripts.length, 13);
    assert.equal(config.modes[3].skillIds[0], 'anima-prompt');
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
    await assert.rejects(runtime.handle('/references/url', { method: 'POST', body: { url: 'http://example.com/reference.md' } }), /必须使用 HTTPS/);
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
    await fixture.runtime.handle('/config', { method: 'PUT', body: { mode: 2, modes: { 2: { ...config.modes[2], profileId: saved.id } } } });
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
    assert.equal(JSON.stringify(llmRequest.body.messages).includes('secret tag body'), false);
    assert.match(llmRequest.body.custom_include_headers, /private-test-key/);
});

test('browser Mode 3 reads the bundled Skill through bounded Agent steps', async () => {
    const fixture = runtimeFixture({ llmResponses: [
        '{"action":"read_skill_file","arguments":{"skill_id":"anima-prompt","path":"SKILL.md"}}',
        '{"action":"final","positive_prompt":"1girl, solo, black_hair, blue_eyes"}',
    ] });
    const profile = await fixture.runtime.handle('/llm-profiles', { method: 'POST', body: {
        name: 'Agent LLM', baseUrl: 'http://127.0.0.1:1234/v1', apiKey: 'agent-key', model: 'prompt-model', maxOutputTokens: 2048, timeoutSeconds: 120,
    } });
    const config = await fixture.runtime.handle('/config');
    await fixture.runtime.handle('/config', { method: 'PUT', body: { mode: 3, modes: { 3: { ...config.modes[3], profileId: profile.id, maxSteps: 3 } } } });
    const created = await fixture.runtime.handle('/jobs', { method: 'POST', body: {
        mode: 3,
        workflowId: config.selectedWorkflowId,
        presetId: config.selectedPresetId,
        triggerHash: 'mode3-test',
        conversation: [{ role: 'user', content: 'Show the heroine' }, { role: 'assistant', content: 'She looks out of the window.' }],
        previousPrompts: [],
        extras: {},
    } });
    const job = await completed(fixture.runtime, created.id);

    assert.equal(job.status, 'completed', job.error);
    assert.equal(job.result.agentSteps, 2);
    assert.equal(job.result.toolLog[0].tool, 'read_skill_file');
    assert.equal(job.result.positivePrompt, '1girl, solo, black hair, blue eyes');
});

test('browser Mode 3 revalidates Agent parameters before submitting ComfyUI', async () => {
    const fixture = runtimeFixture({ llmResponses: [
        '{"action":"final","positive_prompt":"1girl, solo","parameters":{"157":{"steps":"not an integer"}}}',
    ] });
    const profile = await fixture.runtime.handle('/llm-profiles', { method: 'POST', body: {
        name: 'Agent LLM', baseUrl: 'http://127.0.0.1:1234/v1', apiKey: 'agent-key', model: 'prompt-model', maxOutputTokens: 2048, timeoutSeconds: 120,
    } });
    const config = await fixture.runtime.handle('/config');
    await fixture.runtime.handle('/config', { method: 'PUT', body: { mode: 3, modes: { 3: { ...config.modes[3], profileId: profile.id, maxSteps: 2, allowParameterChanges: true } } } });
    const created = await fixture.runtime.handle('/jobs', { method: 'POST', body: {
        mode: 3,
        workflowId: config.selectedWorkflowId,
        presetId: config.selectedPresetId,
        triggerHash: 'mode3-invalid-parameter',
        conversation: [{ role: 'assistant', content: 'She looks out of the window.' }],
        extras: {},
    } });
    const job = await completed(fixture.runtime, created.id);

    assert.equal(job.status, 'failed');
    assert.match(job.error, /157\/steps must be an integer/);
    assert.equal(fixture.requests.some(item => item.target === '/api/sd/comfy/generate'), false);
});
