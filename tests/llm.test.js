import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import { generatePositivePrompt, normalizeAnimaPromptText, OpenAICompatibleClient, parseJsonObject, parsePositivePromptText } from '../server-plugin/lib/llm.js';

async function mockOpenAI(responses) {
    const requests = [];
    const server = http.createServer(async (request, response) => {
        if (request.url === '/v1/models') {
            response.setHeader('content-type', 'application/json');
            return response.end(JSON.stringify({ data: [{ id: 'z' }, { id: 'a' }] }));
        }
        let body = '';
        for await (const chunk of request) body += chunk;
        requests.push(JSON.parse(body));
        response.setHeader('content-type', 'application/json');
        const next = responses.shift();
        response.end(JSON.stringify(typeof next === 'string'
            ? { choices: [{ message: { role: 'assistant', content: next } }], usage: { prompt_tokens: 10 } }
            : next));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    return { server, requests, url: `http://127.0.0.1:${server.address().port}` };
}

test('OpenAI-compatible models and direct Mode 2 prompts work without JSON', async t => {
    const mock = await mockOpenAI(['1girl, solo, blue eyes']);
    t.after(() => mock.server.close());
    const client = new OpenAICompatibleClient({ baseUrl: mock.url, model: 'mock', temperature: 0.2, topP: 1, timeoutSeconds: 2 }, 'secret');
    assert.deepEqual(await client.models(), ['a', 'z']);
    const result = await generatePositivePrompt(client, [{ role: 'user', content: 'scene' }], 77);
    assert.equal(result.positivePrompt, '1girl, solo, blue eyes');
    assert.equal(result.repairs, 0);
    assert.equal(mock.requests.length, 1);
    assert.equal(mock.requests[0].max_tokens, 77);
});

test('Mode 2 repairs non-plain envelopes once and still rejects negative prompt output', async t => {
    const repaired = await mockOpenAI(['{"positive_prompt":"x"}', '1girl, solo']);
    const repairedClient = new OpenAICompatibleClient({ baseUrl: repaired.url, model: 'mock', timeoutSeconds: 2 }, '');
    assert.equal((await generatePositivePrompt(repairedClient, [], 30, undefined, { promptTemplate: 'visible user prompt' })).positivePrompt, '1girl, solo');
    assert.equal(repaired.requests.length, 2);
    assert.match(repaired.requests[1].messages[0].content, /visible user prompt/);
    assert.doesNotMatch(repaired.requests[1].messages[0].content, /The selected workflow uses Anima/);
    repaired.server.close();

    const mock = await mockOpenAI(['negative_prompt: bad hands', 'negative_prompt: forbidden']);
    t.after(() => mock.server.close());
    const client = new OpenAICompatibleClient({ baseUrl: mock.url, model: 'mock', timeoutSeconds: 2 }, '');
    await assert.rejects(() => generatePositivePrompt(client, [], 30), /negative_prompt/);
    assert.equal(parsePositivePromptText('1girl, solo'), '1girl, solo');
    assert.deepEqual(parseJsonObject('```json\n{"x":1}\n```'), { x: 1 });
});

test('Mode 2 reports thinking token exhaustion without a pointless repair request', async t => {
    const mock = await mockOpenAI([{
        choices: [{ finish_reason: 'length', message: { role: 'assistant', content: '', reasoning_content: 'thinking' } }],
        usage: { completion_tokens: 64, completion_tokens_details: { reasoning_tokens: 64 } },
    }]);
    t.after(() => mock.server.close());
    const client = new OpenAICompatibleClient({ baseUrl: mock.url, model: 'mock', timeoutSeconds: 2 }, '');
    await assert.rejects(() => generatePositivePrompt(client, [], 64), /finish_reason=length.*reasoning_tokens=64.*max_tokens=64/);
    assert.equal(mock.requests.length, 1);
});

test('Mode 2 never uses reasoning content as the image prompt', async t => {
    const mock = await mockOpenAI([{
        choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '1girl, solo', reasoning_content: 'private chain of thought' } }],
        usage: { completion_tokens: 20, completion_tokens_details: { reasoning_tokens: 16 } },
    }]);
    t.after(() => mock.server.close());
    const client = new OpenAICompatibleClient({ baseUrl: mock.url, model: 'mock', timeoutSeconds: 2 }, '');
    const result = await generatePositivePrompt(client, [], 128);
    assert.equal(result.positivePrompt, '1girl, solo');
    assert.doesNotMatch(result.positivePrompt, /private chain of thought/);
});

test('Anima mode normalizes tags and accepts multi-character prompts without BREAK', async t => {
    assert.equal(normalizeAnimaPromptText('masterpiece, 1girl, blue_hair, @foo_artist'), '1girl, blue hair');
    const mock = await mockOpenAI([
        'best_quality, 2girls, twin_sisters, blue_hair, white_hair, glass_room',
    ]);
    t.after(() => mock.server.close());
    const client = new OpenAICompatibleClient({ baseUrl: mock.url, model: 'mock', timeoutSeconds: 2 }, '');
    const result = await generatePositivePrompt(client, [], 256, undefined, { dialect: 'anima' });
    assert.equal(result.positivePrompt, '2girls, twin sisters, blue hair, white hair, glass room');
    assert.equal(result.repairs, 0);
    assert.equal(mock.requests.length, 1);
});

test('Anima mode preserves optional BREAK separators without validating their count or position', async t => {
    const mock = await mockOpenAI([
        'BREAK, 1boy, 2girls, man standing, BREAK, BREAK, first girl sitting, second girl kneeling',
    ]);
    t.after(() => mock.server.close());
    const client = new OpenAICompatibleClient({ baseUrl: mock.url, model: 'mock', timeoutSeconds: 2 }, '');
    const result = await generatePositivePrompt(client, [], 256, undefined, { dialect: 'anima' });
    assert.equal(result.repairs, 0);
    assert.equal(result.positivePrompt, 'BREAK, 1boy, 2girls, man standing, BREAK, BREAK, first girl sitting, second girl kneeling');
    assert.equal(mock.requests.length, 1);
});

test('Anima mode repairs CJK tag output into English instead of sending it to ComfyUI', async t => {
    const mock = await mockOpenAI([
        '少女，黑发，蓝眼，窗边，晨光',
        '1girl, black hair, blue eyes, standing by window, morning light',
    ]);
    t.after(() => mock.server.close());
    const client = new OpenAICompatibleClient({ baseUrl: mock.url, model: 'mock', timeoutSeconds: 2 }, '');
    const result = await generatePositivePrompt(client, [], 256, undefined, { dialect: 'anima', promptTemplate: 'visible Anima prompt requiring English tags' });
    assert.equal(result.repairs, 1);
    assert.equal(result.positivePrompt, '1girl, black hair, blue eyes, standing by window, morning light');
    assert.equal(mock.requests.length, 2);
    assert.match(mock.requests[1].messages[0].content, /visible Anima prompt requiring English tags/);
});
