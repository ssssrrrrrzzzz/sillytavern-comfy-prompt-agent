import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { JobManager } from '../server-plugin/lib/jobs.js';
import { readConfig, updateConfig } from '../server-plugin/lib/storage.js';
import { importWorkflow, savePreset } from '../server-plugin/lib/workflows.js';

async function mockComfy() {
    const received = [];
    const objectInfo = {
        CLIPTextEncode: { input: { required: { text: ['STRING'], clip: ['CLIP'] } } },
        KSampler: { input: { required: { steps: ['INT', { min: 1, max: 100 }] } } },
        SaveImage: { input: { required: { images: ['IMAGE'] } } },
    };
    const server = http.createServer(async (request, response) => {
        response.setHeader('content-type', request.url.startsWith('/view') ? 'image/png' : 'application/json');
        if (request.url === '/object_info') return response.end(JSON.stringify(objectInfo));
        if (request.url === '/prompt') {
            let body = ''; for await (const chunk of request) body += chunk;
            received.push(JSON.parse(body)); return response.end(JSON.stringify({ prompt_id: 'prompt-1' }));
        }
        if (request.url === '/history/prompt-1') return response.end(JSON.stringify({ 'prompt-1': { status: { status_str: 'success' }, outputs: { 4: { images: [{ filename: 'x.png', subfolder: '', type: 'output' }] } } } }));
        if (request.url.startsWith('/view')) return response.end(Buffer.from([137, 80, 78, 71]));
        response.statusCode = 404; response.end('{}');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    return { server, received, url: `http://127.0.0.1:${server.address().port}` };
}

test('mode 1 job injects preset negative prompt and downloads every output image', async t => {
    const mock = await mockComfy(); t.after(() => mock.server.close());
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cpa-job-'));
    const dirs = { root, userImages: path.join(root, 'user', 'images'), comfyWorkflows: path.join(root, 'workflows') };
    fs.mkdirSync(dirs.userImages, { recursive: true }); fs.mkdirSync(dirs.comfyWorkflows, { recursive: true });
    const metadata = importWorkflow(dirs, { name: 'Test', workflow: {
        1: { class_type: 'CLIPTextEncode', _meta: { title: 'Positive' }, inputs: { text: '__PROMPT__', clip: ['5', 0] } },
        2: { class_type: 'CLIPTextEncode', _meta: { title: 'Negative' }, inputs: { text: 'old', clip: ['5', 0] } },
        3: { class_type: 'KSampler', inputs: { steps: 20 } },
        4: { class_type: 'SaveImage', inputs: { images: ['3', 0] } },
    } });
    const preset = savePreset(dirs, metadata.id, { ...metadata.presets[0], artistPrompt: 'foo_bar', negativePrompt: 'bad hands', positiveTargets: [{ nodeId: '1', inputName: 'text' }], negativeTargets: [{ nodeId: '2', inputName: 'text' }], outputNodeIds: ['4'] });
    updateConfig(dirs, config => { config.comfy.url = mock.url; config.selectedWorkflowId = metadata.id; config.selectedPresetId = preset.id; });
    const manager = new JobManager({ readSecret: () => '' });
    const created = manager.create(dirs, { mode: 1, directive: 'sunset portrait', triggerHash: 'hash', context: { messages: [], estimatedTokens: 0 } });
    let job;
    for (let i = 0; i < 100; i++) {
        job = manager.get(root, created.id);
        if (['completed', 'failed'].includes(job.status)) break;
        await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(job.status, 'completed', job.error);
    assert.equal(job.result.positivePrompt, '@foo bar, sunset portrait');
    assert.equal(job.result.negativePrompt, 'bad hands');
    assert.equal(mock.received[0].prompt[1].inputs.text, '@foo bar, sunset portrait');
    assert.equal(mock.received[0].prompt[2].inputs.text, 'bad hands');
    assert.equal(job.result.images.length, 1);
    assert.ok(fs.existsSync(path.join(root, job.result.images[0].path)));
    assert.equal(manager.create(dirs, { mode: 1, directive: 'duplicate', triggerHash: 'hash' }).id, created.id, 'same trigger is idempotent');
    assert.equal(readConfig(dirs).comfy.url, mock.url);
});
