import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fetchWithTimeout, joinUrl } from './http.js';

function headersFor(config, secret) {
    const headers = { 'Content-Type': 'application/json' };
    if (!secret) return headers;
    if (config.authType === 'bearer') headers.Authorization = `Bearer ${secret}`;
    if (config.authType === 'basic') headers.Authorization = `Basic ${Buffer.from(secret).toString('base64')}`;
    return headers;
}

async function expectOk(response, label) {
    if (!response.ok) throw new Error(`${label} failed (${response.status}): ${(await response.text()).slice(0, 3000)}`);
    return response;
}

export class ComfyClient {
    constructor(config, secret = '') {
        this.config = config;
        this.secret = secret;
        this.promptId = '';
    }

    async probe(signal) {
        const response = await fetchWithTimeout(joinUrl(this.config.url, 'system_stats'), { headers: headersFor(this.config, this.secret), signal }, 15000);
        return await (await expectOk(response, 'ComfyUI probe')).json();
    }

    async objectInfo(signal) {
        const response = await fetchWithTimeout(joinUrl(this.config.url, 'object_info'), { headers: headersFor(this.config, this.secret), signal }, 30000);
        return await (await expectOk(response, 'ComfyUI object_info')).json();
    }

    async cancel(signal) {
        if (this.promptId) {
            await fetchWithTimeout(joinUrl(this.config.url, 'queue'), { method: 'POST', headers: headersFor(this.config, this.secret), body: JSON.stringify({ delete: [this.promptId] }), signal }, 10000).catch(() => {});
        }
        await fetchWithTimeout(joinUrl(this.config.url, 'interrupt'), { method: 'POST', headers: headersFor(this.config, this.secret), signal }, 10000).catch(() => {});
    }

    async generate(workflow, outputNodeIds, directories, signal, onStatus = () => {}) {
        const clientId = crypto.randomUUID();
        const submit = await fetchWithTimeout(joinUrl(this.config.url, 'prompt'), {
            method: 'POST',
            headers: headersFor(this.config, this.secret),
            body: JSON.stringify({ prompt: workflow, client_id: clientId }),
            signal,
        }, 30000);
        const submitted = await (await expectOk(submit, 'ComfyUI prompt submission')).json();
        if (!submitted.prompt_id) throw new Error('ComfyUI returned no prompt_id.');
        this.promptId = submitted.prompt_id;
        onStatus('running', { promptId: this.promptId });

        const deadline = Date.now() + Math.max(10, Number(this.config.timeoutSeconds || 300)) * 1000;
        let item;
        while (Date.now() < deadline) {
            signal?.throwIfAborted?.();
            const historyResponse = await fetchWithTimeout(joinUrl(this.config.url, `history/${encodeURIComponent(this.promptId)}`), { headers: headersFor(this.config, this.secret), signal }, 15000);
            const history = await (await expectOk(historyResponse, 'ComfyUI history')).json();
            item = history[this.promptId];
            if (item) break;
            await new Promise(resolve => setTimeout(resolve, 300));
        }
        if (!item) {
            await this.cancel(signal);
            throw new Error('ComfyUI generation timed out.');
        }
        if (item.status?.status_str === 'error') {
            const details = item.status?.messages?.filter(value => value[0] === 'execution_error').map(value => `${value[1]?.node_type || 'node'} ${value[1]?.node_id || ''}: ${value[1]?.exception_message || 'error'}`).join('\n');
            throw new Error(details || 'ComfyUI workflow execution failed.');
        }

        const chosen = outputNodeIds?.length ? outputNodeIds.map(String) : Object.keys(item.outputs || {});
        const assets = [];
        for (const nodeId of chosen) {
            const output = item.outputs?.[nodeId] || {};
            for (const image of [...(output.images || []), ...(output.gifs || [])]) assets.push(image);
        }
        if (!assets.length) throw new Error('Selected ComfyUI output nodes returned no images.');

        const outputDir = path.join(directories.userImages, 'Comfy-Prompt-Agent');
        fs.mkdirSync(outputDir, { recursive: true });
        const saved = [];
        for (let index = 0; index < assets.length; index++) {
            const asset = assets[index];
            const view = joinUrl(this.config.url, 'view');
            view.searchParams.set('filename', asset.filename);
            view.searchParams.set('subfolder', asset.subfolder || '');
            view.searchParams.set('type', asset.type || 'output');
            const imageResponse = await fetchWithTimeout(view, { headers: headersFor(this.config, this.secret), signal }, 60000);
            await expectOk(imageResponse, 'ComfyUI image download');
            const buffer = Buffer.from(await imageResponse.arrayBuffer());
            if (buffer.length > 100 * 1024 * 1024) throw new Error('Generated image is too large.');
            const extension = ['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(path.extname(asset.filename).slice(1).toLowerCase()) ? path.extname(asset.filename).slice(1).toLowerCase() : 'png';
            const filename = `${Date.now()}_${this.promptId.slice(0, 8)}_${index}.${extension}`;
            const target = path.join(outputDir, filename);
            fs.writeFileSync(target, buffer);
            saved.push({ path: target.slice(directories.root.length).split(path.sep).join('/'), format: extension, source: asset });
        }
        return saved;
    }
}
