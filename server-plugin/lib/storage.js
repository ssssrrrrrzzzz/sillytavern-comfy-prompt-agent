import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const LEGACY_DEFAULT_MODE_PROMPTS = [
    'Convert the tagged scene request and recent roleplay context into one detailed image-generation positive prompt. Describe only visible content. Return JSON only: {"positive_prompt":"..."}.',
    'Infer the scene to illustrate from the supplied recent roleplay conversation and optional context. Convert it into one detailed Danbooru-style image-generation positive prompt. The image tag is only a trigger and its body is not provided. Describe only visible content. Return JSON only: {"positive_prompt":"..."}.',
    'Infer the scene to illustrate from the supplied recent roleplay conversation and optional context. Convert it into one detailed Danbooru-style image-generation positive prompt. The image tag is only a trigger and its body is not provided. Describe only visible content. Output exactly one line containing only the final prompt, with no label, explanation, Markdown, JSON, or negative prompt.',
];
export const DEFAULT_MODE_PROMPT = 'Infer the scene to illustrate from the supplied recent roleplay conversation, current AI reply, and optional context. Convert it into one detailed Danbooru-style image-generation positive prompt; no image tag is required. Describe only visible content in one coherent composition. Never request a contact sheet, character sheet, collage, grid, panels, lineup, or multiple views. Output exactly one line containing only the final prompt, with no label, explanation, Markdown, JSON, or negative prompt.';

export const defaultConfig = Object.freeze({
    version: 1,
    enabled: true,
    mode: 1,
    comfy: { url: 'http://127.0.0.1:8188', authType: 'none', concurrency: 1, maxQueue: 20, timeoutSeconds: 300 },
    llmProfiles: [],
    modes: {
        2: { profileId: '', historyTurns: 4, promptHistoryCount: 4, maxInputTokens: 8000, maxOutputTokens: 1024, timeoutSeconds: 120, includeCharacterCard: false, includePersona: false, includeSystemPrompt: false, includeWorldBook: false, worldBooks: [], promptTemplate: DEFAULT_MODE_PROMPT },
    },
    selectedWorkflowId: '',
    selectedPresetId: '',
    workflows: [],
    resourceDiscovery: { initialized: false },
});

function mergeDefaults(value, defaults) {
    if (Array.isArray(defaults)) return Array.isArray(value) ? value : structuredClone(defaults);
    if (!defaults || typeof defaults !== 'object') return value === undefined ? defaults : value;
    const output = { ...structuredClone(defaults), ...(value && typeof value === 'object' ? value : {}) };
    for (const [key, nested] of Object.entries(defaults)) output[key] = mergeDefaults(value?.[key], nested);
    return output;
}

export function getDataRoot(directories) {
    return path.join(directories.root, 'comfy-prompt-agent');
}

export function ensureDataLayout(directories) {
    const root = getDataRoot(directories);
    for (const relative of ['workflows', 'workflow-imports', 'skills', 'references', 'cache']) fs.mkdirSync(path.join(root, relative), { recursive: true });
    return root;
}

export function readConfig(directories) {
    const root = ensureDataLayout(directories);
    const file = path.join(root, 'config.json');
    if (!fs.existsSync(file)) return structuredClone(defaultConfig);
    try {
        const config = mergeDefaults(JSON.parse(fs.readFileSync(file, 'utf8')), defaultConfig);
        // Migrate only the exact old built-in template. User-customized prompts
        // are never rewritten.
        if (LEGACY_DEFAULT_MODE_PROMPTS.includes(config.modes?.[2]?.promptTemplate)) {
            config.modes[2].promptTemplate = DEFAULT_MODE_PROMPT;
        }
        if (Number(config.mode) === 3) config.mode = 2;
        delete config.modes[3];
        const selectedProfileExists = config.llmProfiles.some(profile => profile.id === config.modes[2].profileId);
        if (!selectedProfileExists && config.llmProfiles.length === 1) {
            config.modes[2].profileId = config.llmProfiles[0].id;
        }
        for (const workflow of config.workflows || []) {
            for (const preset of workflow.presets || []) preset.agentControllable = {};
        }
        return config;
    } catch (error) {
        throw new Error(`Could not read Comfy Prompt Agent config: ${error.message}`);
    }
}

export function writeConfig(directories, config) {
    const root = ensureDataLayout(directories);
    const file = path.join(root, 'config.json');
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(mergeDefaults(config, defaultConfig), null, 2), 'utf8');
    fs.renameSync(temp, file);
}

export function updateConfig(directories, updater) {
    const config = readConfig(directories);
    const candidate = updater(config);
    // Mutation callbacks commonly return Array#push lengths or assignment
    // values. Only an explicit config object replaces the mutated original.
    const result = candidate && typeof candidate === 'object' && !Array.isArray(candidate) ? candidate : config;
    writeConfig(directories, result);
    return result;
}

export function newId(prefix = 'item') {
    return `${prefix}_${crypto.randomUUID()}`;
}

export function sha256(value) {
    return crypto.createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
}

export function safeItemPath(directories, bucket, id, extension = '') {
    if (!/^[a-zA-Z0-9_-]+$/.test(String(id))) throw new Error('Invalid item ID.');
    const root = path.join(ensureDataLayout(directories), bucket);
    const target = path.resolve(root, `${id}${extension}`);
    if (target !== root && !target.startsWith(`${path.resolve(root)}${path.sep}`)) throw new Error('Invalid item path.');
    return target;
}

export function sanitizeConfig(config) {
    const output = structuredClone(config);
    output.mode = Number(output.mode) === 1 ? 1 : 2;
    output.modes = { 2: output.modes[2] };
    delete output.skills;
    delete output.references;
    output.llmProfiles = output.llmProfiles.map(profile => ({ ...profile, hasApiKey: Boolean(profile.hasApiKey), secretKey: undefined }));
    output.comfy = { ...output.comfy, hasAuthSecret: Boolean(output.comfy.hasAuthSecret), secretKey: undefined };
    return output;
}
