import multer from 'multer';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeBudgetedContext } from '../shared/context.js';
import { ComfyClient } from './lib/comfy.js';
import { bool, normalizeComfySettings, normalizeModeSettings, profileFromBody, text } from './lib/config.js';
import { fetchWithTimeout, readResponseLimited, validateUrl } from './lib/http.js';
import { JobManager, publicJob } from './lib/jobs.js';
import { OpenAICompatibleClient } from './lib/llm.js';
import { writeJobToOriginalSwipe } from './lib/message-store.js';
import { PLUGIN_VERSION } from '../shared/version.js';
export { PLUGIN_VERSION } from '../shared/version.js';
import { readConfig, sanitizeConfig, updateConfig } from './lib/storage.js';
import {
    copyExistingWorkflow,
    deletePreset,
    deleteWorkflow,
    bundledWorkflowFile,
    importWorkflow,
    initializeBundledWorkflows,
    listExistingSillyTavernWorkflows,
    savePreset,
    scanWorkflowDirectories,
    workflowDetails,
} from './lib/workflows.js';

export const info = {
    id: 'comfy-prompt-agent',
    name: 'Comfy Prompt Agent',
    description: 'Independent OpenAI-compatible prompt and ComfyUI image-generation service.',
};

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 50 * 1024 * 1024, files: 1, fields: 20 },
});

function exposeConfig(directories, readSecret) {
    initializeBundledWorkflows(directories);
    const config = readConfig(directories);
    config.llmProfiles = config.llmProfiles.map(profile => ({ ...profile, hasApiKey: Boolean(readSecret(directories, profile.secretKey)) }));
    config.comfy.hasAuthSecret = Boolean(readSecret(directories, config.comfy.secretKey));
    return sanitizeConfig(config);
}

function asyncRoute(handler) {
    return (request, response) => Promise.resolve(handler(request, response)).catch(error => {
        console.error('[Comfy Prompt Agent]', error?.stack || error);
        if (!response.headersSent) response.status(400).json({ error: String(error?.message || error) });
    });
}

function directoriesOf(request) {
    if (!request.user?.directories) throw new Error('No SillyTavern user directory is available.');
    return request.user.directories;
}

export async function init(router, services = {}) {
    const { readSecret, writeSecret, deleteSecret } = services.secrets || {};
    if (![readSecret, writeSecret, deleteSecret].every(value => typeof value === 'function')) {
        throw new Error('SillyTavern SecretManager services were not supplied by the plugin bootstrap.');
    }
    const jobs = new JobManager({ readSecret, onFinished: writeJobToOriginalSwipe });

    router.get('/config', asyncRoute(async (request, response) => response.json(exposeConfig(directoriesOf(request), readSecret))));
    router.put('/config', asyncRoute(async (request, response) => {
        const directories = directoriesOf(request);
        updateConfig(directories, config => {
            const body = request.body || {};
            config.enabled = bool(body.enabled, config.enabled);
            config.mode = [1, 2].includes(Number(body.mode)) ? Number(body.mode) : config.mode;
            config.selectedWorkflowId = text(body.selectedWorkflowId, config.selectedWorkflowId, 100);
            config.selectedPresetId = text(body.selectedPresetId, config.selectedPresetId, 100);
            config.comfy = normalizeComfySettings(body.comfy, config.comfy);
            config.modes[2] = normalizeModeSettings(body.modes?.[2], config.modes[2]);
        });
        response.json(exposeConfig(directories, readSecret));
    }));
    router.put('/config/mode', asyncRoute(async (request, response) => {
        const directories = directoriesOf(request);
        const mode = Number(request.body?.mode);
        if (![1, 2].includes(mode)) throw new Error('Mode must be 1 or 2.');
        updateConfig(directories, config => { config.mode = mode; });
        response.json({ mode });
    }));
    router.put('/config/comfy', asyncRoute(async (request, response) => {
        const directories = directoriesOf(request);
        updateConfig(directories, config => { config.comfy = normalizeComfySettings(request.body, config.comfy); });
        const config = readConfig(directories);
        if (typeof request.body?.secret === 'string' && request.body.secret) writeSecret(directories, config.comfy.secretKey, text(request.body.secret, '', 20000));
        response.json(exposeConfig(directories, readSecret));
    }));

    router.post('/llm-profiles', asyncRoute(async (request, response) => {
        const directories = directoriesOf(request);
        let saved;
        updateConfig(directories, config => {
            const requestedId = text(request.body?.id, '', 100);
            const index = config.llmProfiles.findIndex(item => item.id === requestedId);
            const current = index >= 0 ? config.llmProfiles[index] : {};
            saved = profileFromBody(request.body, current);
            if (request.body?.apiKey) {
                writeSecret(directories, saved.secretKey, text(request.body.apiKey, '', 20000));
                saved.hasApiKey = true;
            }
            if (index >= 0) config.llmProfiles[index] = saved;
            else config.llmProfiles.push(saved);
        });
        response.json({ ...saved, secretKey: undefined, hasApiKey: Boolean(readSecret(directories, saved.secretKey)) });
    }));
    router.post('/llm-profiles/test', asyncRoute(async (request, response) => {
        const directories = directoriesOf(request);
        const config = readConfig(directories);
        const current = config.llmProfiles.find(item => item.id === text(request.body?.id, '', 100)) || {};
        const profile = profileFromBody(request.body, current);
        const apiKey = request.body?.apiKey ? text(request.body.apiKey, '', 20000) : (current.secretKey ? readSecret(directories, current.secretKey) : '');
        const models = await new OpenAICompatibleClient(profile, apiKey).models();
        response.json({ ok: true, modelCount: models.length, models });
    }));
    router.delete('/llm-profiles/:id', asyncRoute(async (request, response) => {
        const directories = directoriesOf(request);
        const config = readConfig(directories);
        const profile = config.llmProfiles.find(item => item.id === request.params.id);
        if (!profile) throw new Error('LLM Profile not found.');
        deleteSecret(directories, profile.secretKey);
        updateConfig(directories, next => {
            next.llmProfiles = next.llmProfiles.filter(item => item.id !== profile.id);
            if (next.modes[2].profileId === profile.id) next.modes[2].profileId = '';
        });
        response.json({ ok: true });
    }));
    const llmClient = (directories, id) => {
        const profile = readConfig(directories).llmProfiles.find(item => item.id === id);
        if (!profile) throw new Error('LLM Profile not found.');
        return new OpenAICompatibleClient(profile, readSecret(directories, profile.secretKey));
    };
    router.post('/llm-profiles/:id/test', asyncRoute(async (request, response) => {
        const models = await llmClient(directoriesOf(request), request.params.id).models();
        response.json({ ok: true, modelCount: models.length, models });
    }));
    router.get('/llm-profiles/:id/models', asyncRoute(async (request, response) => {
        response.json({ models: await llmClient(directoriesOf(request), request.params.id).models() });
    }));

    router.post('/comfy/secret', asyncRoute(async (request, response) => {
        const directories = directoriesOf(request);
        const key = readConfig(directories).comfy.secretKey || 'api_key_comfy_prompt_agent_comfy';
        if (request.body?.secret) writeSecret(directories, key, text(request.body.secret, '', 20000));
        else deleteSecret(directories, key);
        response.json({ ok: true, hasAuthSecret: Boolean(readSecret(directories, key)) });
    }));
    const comfyClient = directories => {
        const config = readConfig(directories).comfy;
        return new ComfyClient(config, readSecret(directories, config.secretKey));
    };
    router.post('/comfy/test', asyncRoute(async (request, response) => response.json({ ok: true, stats: await comfyClient(directoriesOf(request)).probe() })));
    router.get('/comfy/object-info', asyncRoute(async (request, response) => response.json(await comfyClient(directoriesOf(request)).objectInfo())));

    router.get('/bundled/workflows', asyncRoute(async (_request, response) => response.json([
        { id: 'anima-api', name: 'Anima API', format: 'api' },
        { id: 'anima-comfyui', name: 'Anima ComfyUI 普通版', format: 'ui' },
    ])));
    router.get('/bundled/workflows/:name', asyncRoute(async (request, response) => {
        const item = bundledWorkflowFile(request.params.name);
        response.download(item.path, item.download);
    }));

    router.get('/workflows', asyncRoute(async (request, response) => response.json(readConfig(directoriesOf(request)).workflows)));
    router.post('/workflows', asyncRoute(async (request, response) => response.json(importWorkflow(directoriesOf(request), request.body || {}))));
    router.post('/workflows/scan', asyncRoute(async (request, response) => response.json(scanWorkflowDirectories(directoriesOf(request), [path.join(path.dirname(fileURLToPath(import.meta.url)), 'workflows')]))));
    router.post('/workflows/upload', upload.single('file'), asyncRoute(async (request, response) => {
        if (!request.file) throw new Error('Workflow file is required.');
        response.json(importWorkflow(directoriesOf(request), { name: request.body?.name || request.file.originalname.replace(/\.json$/i, ''), workflow: request.file.buffer.toString('utf8'), source: 'upload' }));
    }));
    router.post('/workflows/url', asyncRoute(async (request, response) => {
        const url = validateUrl(request.body?.url, { httpsOnly: true });
        const fetched = await fetchWithTimeout(url, {}, 30000);
        if (!fetched.ok) throw new Error(`Workflow download failed (${fetched.status}).`);
        const buffer = await readResponseLimited(fetched, 10 * 1024 * 1024);
        response.json(importWorkflow(directoriesOf(request), { name: request.body?.name || url.pathname.split('/').pop()?.replace(/\.json$/i, ''), workflow: buffer.toString('utf8'), source: url.toString() }));
    }));
    router.get('/workflows/sillytavern', asyncRoute(async (request, response) => response.json(listExistingSillyTavernWorkflows(directoriesOf(request)))));
    router.post('/workflows/sillytavern', asyncRoute(async (request, response) => response.json(copyExistingWorkflow(directoriesOf(request), request.body?.fileName))));
    router.get('/workflows/:id', asyncRoute(async (request, response) => {
        const directories = directoriesOf(request);
        let objectInfo = {};
        if (request.query.live === '1') objectInfo = await comfyClient(directories).objectInfo();
        response.json(workflowDetails(directories, request.params.id, objectInfo));
    }));
    router.delete('/workflows/:id', asyncRoute(async (request, response) => { deleteWorkflow(directoriesOf(request), request.params.id); response.json({ ok: true }); }));
    router.post('/workflows/:id/presets', asyncRoute(async (request, response) => response.json(savePreset(directoriesOf(request), request.params.id, request.body || {}))));
    router.delete('/workflows/:id/presets/:presetId', asyncRoute(async (request, response) => { deletePreset(directoriesOf(request), request.params.id, request.params.presetId); response.json({ ok: true }); }));

    router.get('/jobs', asyncRoute(async (request, response) => response.json(jobs.listForUser(directoriesOf(request).root))));
    router.post('/jobs/estimate', asyncRoute(async (request, response) => {
        const config = readConfig(directoriesOf(request));
        const mode = [1, 2].includes(Number(request.body?.mode)) ? Number(request.body.mode) : config.mode;
        const context = mode === 1 ? { messages: [], extras: {}, estimatedTokens: 0, dropped: { turns: 0, extras: [] } } : makeBudgetedContext(config, mode, request.body);
        response.json({ ...context, actualMessages: context.messages.length, actualTurns: context.messages.filter(item => item.role === 'assistant').length });
    }));
    router.post('/jobs', asyncRoute(async (request, response) => {
        const directories = directoriesOf(request);
        const config = readConfig(directories);
        const mode = [1, 2].includes(Number(request.body?.mode)) ? Number(request.body.mode) : config.mode;
        const context = mode === 1 ? { messages: [], extras: {}, estimatedTokens: 0, dropped: { turns: 0, extras: [] } } : makeBudgetedContext(config, mode, request.body);
        const created = jobs.create(directories, {
            mode,
            // Only Mode 1 consumes tag content. Discard it server-side for
            // Mode 2 even if a custom client attempts to submit it.
            directive: mode === 1 ? text(request.body?.directive, '', 1000000) : '',
            workflowId: text(request.body?.workflowId, config.selectedWorkflowId, 100),
            presetId: text(request.body?.presetId, config.selectedPresetId, 100),
            triggerHash: text(request.body?.triggerHash, '', 128),
            target: request.body?.target,
            context,
        });
        response.status(202).json(created);
    }));
    router.get('/jobs/:id', asyncRoute(async (request, response) => response.json(publicJob(jobs.get(directoriesOf(request).root, request.params.id)))));
    router.delete('/jobs/:id', asyncRoute(async (request, response) => response.json(jobs.cancel(directoriesOf(request).root, request.params.id))));
    return {
        canReload: () => jobs.isIdle(),
        shutdown: () => jobs.shutdown(),
    };
}

export default { info, init };
