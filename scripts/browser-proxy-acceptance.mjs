#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { BrowserRuntime } from '../browser-runtime.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = new Map();
for (let index = 2; index < process.argv.length; index++) {
    const key = process.argv[index];
    if (key.startsWith('--')) args.set(key.slice(2), process.argv[index + 1]?.startsWith('--') ? true : process.argv[++index]);
}
const stUrl = new URL(String(args.get('st') || 'http://127.0.0.1:8000'));
const comfyUrl = String(args.get('comfy') || 'http://127.0.0.1:8188');
const generate = args.has('generate');

function responseCookies(response) {
    const raw = typeof response.headers.getSetCookie === 'function'
        ? response.headers.getSetCookie()
        : [response.headers.get('set-cookie') || ''];
    return raw.flatMap(value => value.split(/,(?=\s*[^;,=\s]+=[^;,]+)/)).map(value => value.trim().split(';')[0]).filter(Boolean).join('; ');
}

const csrfResponse = await fetch(new URL('/csrf-token', stUrl));
if (!csrfResponse.ok) throw new Error(`SillyTavern CSRF endpoint returned ${csrfResponse.status}.`);
const cookie = responseCookies(csrfResponse);
const { token } = await csrfResponse.json();
if (!token || !cookie) throw new Error('Could not establish a SillyTavern session.');

const assetPrefix = 'asset:';
const fetchImpl = async (input, init = {}) => {
    const target = String(input);
    if (target.startsWith(assetPrefix)) {
        const relative = target.slice(assetPrefix.length);
        const file = path.resolve(root, relative);
        if (!file.startsWith(`${root}${path.sep}`)) return new Response('Forbidden', { status: 403 });
        try {
            return new Response(await fs.readFile(file), { status: 200 });
        } catch {
            return new Response('Not found', { status: 404 });
        }
    }
    if (/^https?:\/\//i.test(target) && new URL(target).origin === new URL(comfyUrl).origin) {
        throw new TypeError('Simulated browser CORS block; the acceptance must use SillyTavern proxies.');
    }
    const headers = new Headers(init.headers || {});
    headers.set('Cookie', cookie);
    return await fetch(new URL(target, stUrl), { ...init, headers });
};

const runtime = new BrowserRuntime({
    storage: {},
    save: () => {},
    headers: () => ({ 'Content-Type': 'application/json', 'X-CSRF-Token': token }),
    assetUrl: relative => `${assetPrefix}${relative}`,
    fetchImpl,
});
await runtime.ready();
await runtime.handle('/config/comfy', { method: 'PUT', body: { url: comfyUrl, authType: 'none', concurrency: 1, maxQueue: 2, timeoutSeconds: 300 } });
await runtime.handle('/comfy/test', { method: 'POST', body: {} });
const objectInfo = await runtime.handle('/comfy/object-info');
const config = await runtime.handle('/config');
const models = objectInfo.UNETLoader?.input?.required?.unet_name?.[0] || [];
console.log(`Browser proxy ready: ${models.length} UNet model(s); default workflow ${config.selectedWorkflowId}.`);

if (generate) {
    const created = await runtime.handle('/jobs', { method: 'POST', body: {
        mode: 1,
        directive: '1girl, solo, blue eyes, black hair, upper body, looking at viewer, simple background',
        workflowId: config.selectedWorkflowId,
        presetId: config.selectedPresetId,
        triggerHash: `browser-acceptance-${Date.now()}`,
    } });
    const deadline = Date.now() + 360000;
    while (Date.now() < deadline) {
        const job = await runtime.handle(`/jobs/${created.id}`);
        if (job.status === 'completed') {
            console.log(`Browser proxy generation completed: ${job.result.images.map(item => item.path).join(', ')}`);
            process.exit(0);
        }
        if (job.status === 'failed' || job.status === 'cancelled') throw new Error(job.error || `Job ${job.status}.`);
        await new Promise(resolve => setTimeout(resolve, 500));
    }
    throw new Error('Browser proxy generation timed out.');
}
