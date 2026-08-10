import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyWorkflowPreset, composePositivePrompt, describeEditableInputs, discoverWorkflow, isLink, normalizeArtistPrompt, validateApiWorkflow, validateRuntimeWorkflow as validateSharedRuntimeWorkflow } from '../../shared/workflow.js';
import { newId, readConfig, safeItemPath, sha256, updateConfig } from './storage.js';

const BUNDLED_DEFAULTS_VERSION = 1;
const BUNDLED_WORKFLOW_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bundled', 'workflows');
const LEGACY_BUNDLED_ANIMA_HASHES = new Set(['0503085043b22bbf2da8c21d4b08a9d291f20d5d53788f64b1bd49b9f229b27d']);

function normalizeName(name) {
    return String(name || 'Workflow').replace(/[\x00-\x1f<>:"/\\|?*]/g, '_').slice(0, 120) || 'Workflow';
}

function presetFromWorkflow(workflow, discovery) {
    const values = {};
    for (const [nodeId, node] of Object.entries(workflow)) {
        for (const [inputName, value] of Object.entries(node.inputs || {})) {
            if (Array.isArray(value) && value.length === 2) continue;
            values[nodeId] ||= {};
            values[nodeId][inputName] = value;
        }
    }
    const negativeTarget = discovery.negativeCandidates[0];
    const importedNegative = negativeTarget ? workflow[String(negativeTarget.nodeId)]?.inputs?.[negativeTarget.inputName] : '';
    return {
        id: newId('preset'),
        name: 'Default',
        artistPrompt: '',
        randomizeSeed: true,
        negativePrompt: typeof importedNegative === 'string' ? importedNegative : '',
        // Candidates are suggestions only. A user must explicitly confirm the
        // positive target before this preset can run.
        positiveTargets: [],
        negativeTargets: discovery.negativeCandidates.slice(0, 1),
        outputNodeIds: discovery.outputNodes.slice(-1),
        values,
        visible: {},
        agentControllable: {},
    };
}

export function importWorkflow(directories, { name, workflow, source = 'upload' }) {
    const parsed = typeof workflow === 'string' ? JSON.parse(workflow) : workflow;
    validateApiWorkflow(parsed);
    const serialized = JSON.stringify(parsed, null, 2);
    const discovery = discoverWorkflow(parsed);
    const id = newId('workflow');
    fs.writeFileSync(safeItemPath(directories, 'workflows', id, '.json'), serialized, 'utf8');
    const metadata = {
        id,
        name: normalizeName(name),
        source,
        hash: sha256(serialized),
        importedAt: Date.now(),
        discovery,
        presets: [presetFromWorkflow(parsed, discovery)],
    };
    updateConfig(directories, config => {
        config.workflows.push(metadata);
        if (!config.selectedWorkflowId) {
            config.selectedWorkflowId = id;
            config.selectedPresetId = metadata.presets[0].id;
        }
    });
    return metadata;
}

export function initializeBundledWorkflows(directories) {
    let config = readConfig(directories);
    if (Number(config.resourceDiscovery?.bundledDefaultsVersion || 0) >= BUNDLED_DEFAULTS_VERSION) return config;
    const file = path.join(BUNDLED_WORKFLOW_ROOT, 'Anima-API.json');
    if (!fs.existsSync(file)) return config;
    const serialized = JSON.stringify(JSON.parse(fs.readFileSync(file, 'utf8')), null, 2);
    const bundledHash = sha256(serialized);
    let metadata = config.workflows.find(item => item.hash === bundledHash || LEGACY_BUNDLED_ANIMA_HASHES.has(item.hash));
    let imported = false;
    if (!metadata) {
        metadata = importWorkflow(directories, {
            name: 'Anima · API（内置）',
            workflow: serialized,
            source: 'bundled:anima-api:v1',
        });
        imported = true;
    }
    if (!imported && LEGACY_BUNDLED_ANIMA_HASHES.has(metadata.hash)) {
        fs.writeFileSync(safeItemPath(directories, 'workflows', metadata.id, '.json'), serialized, 'utf8');
        config = updateConfig(directories, current => {
            const item = current.workflows.find(value => value.id === metadata.id);
            item.hash = bundledHash;
            item.discovery = discoverWorkflow(JSON.parse(serialized));
            for (const preset of item.presets || []) {
                if (preset.values?.['156:153']?.unet_name === 'anima_baseV10.safetensors') {
                    preset.values['156:153'].unet_name = 'anima-aesthetic-v1.1.safetensors';
                }
            }
        });
        metadata = config.workflows.find(item => item.id === metadata.id);
    }
    if (imported) {
        const { workflow } = loadWorkflow(directories, metadata.id);
        const preset = metadata.presets[0];
        const markerTarget = metadata.discovery.promptCandidates.find(target => {
            const value = workflow[String(target.nodeId)]?.inputs?.[target.inputName];
            return typeof value === 'string' && /__PROMPT__|%prompt%/i.test(value);
        }) || metadata.discovery.promptCandidates[0];
        if (!markerTarget) throw new Error('Bundled Anima workflow has no positive prompt target.');
        preset.name = 'Anima 默认';
        preset.positiveTargets = [markerTarget];
        preset.negativeTargets = metadata.discovery.negativeCandidates.slice(0, 1);
        preset.outputNodeIds = metadata.discovery.outputNodes.slice(-1);
        preset.visible = {
            '156:153': ['unet_name'],
            '156:154': ['clip_name'],
            '156:155': ['vae_name'],
            '157': ['seed', 'steps', 'cfg', 'sampler_name', 'scheduler'],
            '161:160': ['width', 'height', 'batch_size'],
        };
        preset.agentControllable = {
            '157': ['seed', 'steps', 'cfg', 'sampler_name', 'scheduler'],
            '161:160': ['width', 'height', 'batch_size'],
        };
        savePreset(directories, metadata.id, preset);
    }
    config = updateConfig(directories, current => {
        current.resourceDiscovery = { ...(current.resourceDiscovery || {}), bundledDefaultsVersion: BUNDLED_DEFAULTS_VERSION };
        if (!current.selectedWorkflowId && metadata) {
            current.selectedWorkflowId = metadata.id;
            current.selectedPresetId = metadata.presets[0]?.id || '';
        }
    });
    return config;
}

export function bundledWorkflowFile(name) {
    const files = {
        'anima-api': { file: 'Anima-API.json', download: 'Anima-API.json', format: 'api' },
        'anima-comfyui': { file: 'Anima-ComfyUI.json', download: 'Anima-ComfyUI.json', format: 'ui' },
    };
    const selected = files[String(name || '')];
    if (!selected) throw new Error('Bundled workflow not found.');
    const target = path.join(BUNDLED_WORKFLOW_ROOT, selected.file);
    if (!fs.existsSync(target)) throw new Error('Bundled workflow file is missing.');
    return { ...selected, path: target };
}

export function scanWorkflowDirectories(directories, additionalRoots = []) {
    const roots = [path.join(directories.root, 'comfy-prompt-agent', 'workflow-imports'), ...additionalRoots];
    const knownSources = new Set(readConfig(directories).workflows.map(item => item.source));
    const imported = [];
    const errors = [];
    for (const root of roots) {
        if (!root || !fs.existsSync(root)) continue;
        for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
            if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.json')) continue;
            const source = `scan:${path.resolve(root, entry.name)}`;
            if (knownSources.has(source)) continue;
            try {
                imported.push(importWorkflow(directories, { name: path.parse(entry.name).name, workflow: fs.readFileSync(path.join(root, entry.name), 'utf8'), source }));
                knownSources.add(source);
            } catch (error) {
                errors.push({ file: entry.name, error: error.message });
            }
        }
    }
    return { imported, errors };
}

export function loadWorkflow(directories, id) {
    const metadata = readConfig(directories).workflows.find(item => item.id === id);
    if (!metadata) throw new Error('Workflow not found.');
    const workflow = JSON.parse(fs.readFileSync(safeItemPath(directories, 'workflows', id, '.json'), 'utf8'));
    validateApiWorkflow(workflow);
    return { metadata, workflow };
}

export function deleteWorkflow(directories, id) {
    const file = safeItemPath(directories, 'workflows', id, '.json');
    if (fs.existsSync(file)) fs.unlinkSync(file);
    return updateConfig(directories, config => {
        config.workflows = config.workflows.filter(item => item.id !== id);
        if (config.selectedWorkflowId === id) {
            config.selectedWorkflowId = config.workflows[0]?.id || '';
            config.selectedPresetId = config.workflows[0]?.presets?.[0]?.id || '';
        }
    });
}

export function savePreset(directories, workflowId, preset) {
    let saved;
    updateConfig(directories, config => {
        const workflow = config.workflows.find(item => item.id === workflowId);
        if (!workflow) throw new Error('Workflow not found.');
        const negativeKeys = new Set((Array.isArray(preset.negativeTargets) ? preset.negativeTargets : [])
            .map(target => `${target.nodeId}/${target.inputName}`));
        const requestedAgentControls = preset.agentControllable && typeof preset.agentControllable === 'object' ? preset.agentControllable : {};
        const agentControllable = {};
        for (const [nodeId, names] of Object.entries(requestedAgentControls)) {
            if (!Array.isArray(names)) continue;
            agentControllable[nodeId] = names.map(String).filter(inputName => !negativeKeys.has(`${nodeId}/${inputName}`));
        }
        const normalized = {
            id: preset.id || newId('preset'),
            name: normalizeName(preset.name || 'Preset'),
            artistPrompt: normalizeArtistPrompt(String(preset.artistPrompt || '').slice(0, 4000)),
            randomizeSeed: preset.randomizeSeed !== false,
            negativePrompt: String(preset.negativePrompt || ''),
            positiveTargets: Array.isArray(preset.positiveTargets) ? preset.positiveTargets : [],
            negativeTargets: Array.isArray(preset.negativeTargets) ? preset.negativeTargets : [],
            outputNodeIds: Array.isArray(preset.outputNodeIds) ? preset.outputNodeIds.map(String) : [],
            values: preset.values && typeof preset.values === 'object' ? preset.values : {},
            visible: preset.visible && typeof preset.visible === 'object' ? preset.visible : {},
            // A negative target can never be delegated to the Agent, even if a
            // malicious or stale client sends it in the allowlist.
            agentControllable,
        };
        if (!normalized.positiveTargets.length) throw new Error('At least one positive prompt target is required.');
        const index = workflow.presets.findIndex(item => item.id === normalized.id);
        if (index >= 0) workflow.presets[index] = normalized;
        else workflow.presets.push(normalized);
        config.selectedWorkflowId = workflowId;
        config.selectedPresetId = normalized.id;
        saved = normalized;
    });
    return saved;
}

export function workflowPromptDialect(metadata, preset) {
    const signature = JSON.stringify({ name: metadata?.name || '', values: preset?.values || {} }).toLowerCase();
    return signature.includes('anima') ? 'anima' : 'generic';
}

export function deletePreset(directories, workflowId, presetId) {
    return updateConfig(directories, config => {
        const workflow = config.workflows.find(item => item.id === workflowId);
        if (!workflow) throw new Error('Workflow not found.');
        if (workflow.presets.length <= 1) throw new Error('A workflow must keep at least one preset.');
        workflow.presets = workflow.presets.filter(item => item.id !== presetId);
        if (config.selectedPresetId === presetId) config.selectedPresetId = workflow.presets[0].id;
    });
}

export function workflowDetails(directories, workflowId, objectInfo = {}) {
    const { metadata, workflow } = loadWorkflow(directories, workflowId);
    return { metadata, workflow, inputs: describeEditableInputs(workflow, objectInfo) };
}

export function buildWorkflow(directories, workflowId, presetId, positivePrompt, agentParameters = {}) {
    const { metadata, workflow } = loadWorkflow(directories, workflowId);
    const preset = metadata.presets.find(item => item.id === presetId) || metadata.presets[0];
    if (!preset) throw new Error('Workflow preset not found.');
    if (!preset.positiveTargets?.length) throw new Error('Workflow has no confirmed positive prompt target.');
    return {
        workflow: applyWorkflowPreset(workflow, preset, positivePrompt, agentParameters),
        positivePrompt: composePositivePrompt(positivePrompt, preset.artistPrompt),
        metadata,
        preset,
    };
}

export const validateRuntimeWorkflow = validateSharedRuntimeWorkflow;

export function listExistingSillyTavernWorkflows(directories) {
    return fs.readdirSync(directories.comfyWorkflows)
        .filter(file => file.toLowerCase().endsWith('.json'))
        .map(file => ({ name: file, path: path.join(directories.comfyWorkflows, file) }));
}

export function copyExistingWorkflow(directories, fileName) {
    const safeName = path.basename(String(fileName));
    const source = path.join(directories.comfyWorkflows, safeName);
    if (!source.startsWith(`${path.resolve(directories.comfyWorkflows)}${path.sep}`) || !fs.existsSync(source)) throw new Error('SillyTavern workflow not found.');
    return importWorkflow(directories, { name: path.parse(safeName).name, workflow: fs.readFileSync(source, 'utf8'), source: `sillytavern:${safeName}` });
}
