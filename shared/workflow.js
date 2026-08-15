export const PROMPT_MARKERS = ['%prompt%', '__PROMPT__'];

export function isLink(value) {
    return Array.isArray(value) && value.length === 2 && typeof value[0] === 'string' && Number.isInteger(Number(value[1]));
}

export function validateApiWorkflow(workflow) {
    if (!workflow || typeof workflow !== 'object' || Array.isArray(workflow)) throw new Error('Workflow must be a JSON object.');
    const entries = Object.entries(workflow);
    if (!entries.length) throw new Error('Workflow is empty.');
    for (const [nodeId, node] of entries) {
        if (!node || typeof node !== 'object' || typeof node.class_type !== 'string' || !node.inputs || typeof node.inputs !== 'object') {
            throw new Error(`Node ${nodeId} is not a ComfyUI API-format node.`);
        }
    }
    return workflow;
}

export function discoverWorkflow(workflow) {
    validateApiWorkflow(workflow);
    const promptCandidates = [];
    const negativeCandidates = [];
    const outputNodes = [];
    for (const [nodeId, node] of Object.entries(workflow)) {
        const title = String(node._meta?.title || node.class_type || '').toLowerCase();
        if (['SaveImage', 'PreviewImage'].includes(node.class_type)) outputNodes.push(nodeId);
        for (const [inputName, value] of Object.entries(node.inputs)) {
            if (typeof value !== 'string') continue;
            const target = { nodeId, inputName, title: node._meta?.title || node.class_type };
            const lower = value.toLowerCase();
            const isNegative = /negative|负面/.test(title);
            if (!isNegative && (PROMPT_MARKERS.some(marker => lower.includes(marker.toLowerCase()))
                || node.class_type === 'CLIPTextEncode'
                || /PrimitiveString/i.test(node.class_type)
                || /positive|正面|内容提示/.test(title))) promptCandidates.push(target);
            if (isNegative) negativeCandidates.push(target);
        }
    }
    return { promptCandidates, negativeCandidates, outputNodes };
}

export function setNodeInput(workflow, target, value) {
    const nodeId = String(target?.nodeId);
    const node = Object.hasOwn(workflow || {}, nodeId) ? workflow[nodeId] : null;
    if (!node || !Object.hasOwn(node.inputs || {}, target?.inputName)) throw new Error(`Unknown workflow input ${target?.nodeId}/${target?.inputName}`);
    if (isLink(node.inputs[target.inputName])) throw new Error(`Cannot overwrite linked input ${target.nodeId}/${target.inputName}`);
    node.inputs[target.inputName] = value;
}

export function normalizeArtistPrompt(value) {
    const tags = String(value || '')
        .split(/[,\n]+/)
        .map(item => item.trim())
        .filter(Boolean)
        .map(item => item.replace(/^artist\s*:\s*/i, '').replace(/^@+/, '').replaceAll('_', ' ').trim())
        .filter(Boolean)
        .map(item => `@${item}`);
    return [...new Map(tags.map(tag => [tag.toLocaleLowerCase(), tag])).values()].join(', ');
}

export function composePositivePrompt(positivePrompt, artistPrompt = '') {
    const prompt = String(positivePrompt || '').trim().replace(/^,\s*|,\s*$/g, '');
    const artists = normalizeArtistPrompt(artistPrompt).split(', ').filter(Boolean);
    if (!artists.length) return prompt;
    const existing = new Set(prompt.split(',').map(tag => tag.trim().toLocaleLowerCase()).filter(Boolean));
    const missing = artists.filter(tag => !existing.has(tag.toLocaleLowerCase()));
    return [missing.join(', '), prompt].filter(Boolean).join(', ');
}

export function randomWorkflowSeed() {
    // A 31-bit non-negative seed remains valid for standard ComfyUI samplers
    // and conservative custom nodes while still providing ample variation.
    return Math.floor(Math.random() * 0x80000000);
}

export function applyWorkflowPreset(template, preset, positivePrompt, parameterOverrides = {}, options = {}) {
    const workflow = structuredClone(template);
    const values = structuredClone(preset.values || {});
    for (const [nodeId, inputs] of Object.entries(parameterOverrides || {})) {
        for (const [inputName, value] of Object.entries(inputs || {})) {
            const allowed = Object.hasOwn(preset.agentControllable || {}, nodeId) ? preset.agentControllable[nodeId] : null;
            if (!Array.isArray(allowed) || !allowed.includes(inputName)) throw new Error(`Parameter override is not allowed for ${nodeId}/${inputName}`);
            values[nodeId] ||= {};
            values[nodeId][inputName] = value;
        }
    }
    for (const [nodeId, inputs] of Object.entries(values)) {
        for (const [inputName, value] of Object.entries(inputs || {})) setNodeInput(workflow, { nodeId, inputName }, value);
    }
    // API-format workflows only contain the current numeric seed; unlike the
    // ComfyUI browser, they do not preserve the widget's "randomize after run"
    // state. Randomize by default, while allowing a preset to opt into an exact
    // reproducible seed. An explicit, allowlisted seed remains authoritative.
    if (preset.randomizeSeed !== false) {
        const nextSeed = options.seedFactory || randomWorkflowSeed;
        for (const [nodeId, node] of Object.entries(workflow)) {
            for (const [inputName, value] of Object.entries(node.inputs || {})) {
                if (!/^(?:noise_)?seed$/i.test(inputName) || !Number.isFinite(Number(value))) continue;
                if (Object.hasOwn(parameterOverrides?.[nodeId] || {}, inputName)) continue;
                node.inputs[inputName] = nextSeed();
            }
        }
    }
    // Prompt targets are applied last. Preset scalar snapshots often contain the
    // imported prompt text, and must never overwrite the runtime prompts.
    const finalPositivePrompt = composePositivePrompt(positivePrompt, preset.artistPrompt);
    for (const target of preset.positiveTargets || []) setNodeInput(workflow, target, finalPositivePrompt);
    for (const target of preset.negativeTargets || []) setNodeInput(workflow, target, preset.negativePrompt || '');
    return workflow;
}

export function describeEditableInputs(workflow, objectInfo = {}) {
    const result = [];
    for (const [nodeId, node] of Object.entries(workflow)) {
        const schema = objectInfo[node.class_type]?.input || {};
        const definitions = { ...(schema.required || {}), ...(schema.optional || {}) };
        for (const [inputName, value] of Object.entries(node.inputs || {})) {
            if (isLink(value)) continue;
            const definition = definitions[inputName];
            const type = Array.isArray(definition) ? definition[0] : typeof value;
            const options = Array.isArray(type) ? type : null;
            const metadata = Array.isArray(definition) && definition[1] && typeof definition[1] === 'object' ? definition[1] : {};
            result.push({ nodeId, classType: node.class_type, title: node._meta?.title || node.class_type, inputName, value, type: options ? 'COMBO' : type, options, metadata });
        }
    }
    return result;
}

export function validateRuntimeWorkflow(workflow, objectInfo) {
    const missing = [];
    for (const [nodeId, node] of Object.entries(workflow)) {
        const nodeInfo = objectInfo?.[node.class_type];
        if (!nodeInfo) { missing.push(`${node.class_type} (${nodeId})`); continue; }
        const definitions = { ...(nodeInfo.input?.required || {}), ...(nodeInfo.input?.optional || {}) };
        for (const [inputName, value] of Object.entries(node.inputs || {})) {
            if (isLink(value)) continue;
            const definition = definitions[inputName];
            if (!Array.isArray(definition)) continue;
            const type = definition[0];
            const metadata = definition[1] || {};
            if (Array.isArray(type) && !type.some(option => Object.is(option, value))) throw new Error(`${nodeId}/${inputName} is not an available ComfyUI option.`);
            if (type === 'INT' && !Number.isInteger(Number(value))) throw new Error(`${nodeId}/${inputName} must be an integer.`);
            if (type === 'FLOAT' && !Number.isFinite(Number(value))) throw new Error(`${nodeId}/${inputName} must be numeric.`);
            if (['INT', 'FLOAT'].includes(type)) {
                if (metadata.min !== undefined && Number(value) < Number(metadata.min)) throw new Error(`${nodeId}/${inputName} is below the minimum.`);
                if (metadata.max !== undefined && Number(value) > Number(metadata.max)) throw new Error(`${nodeId}/${inputName} is above the maximum.`);
            }
            if (type === 'BOOLEAN' && typeof value !== 'boolean') throw new Error(`${nodeId}/${inputName} must be boolean.`);
            if (type === 'STRING' && typeof value !== 'string') throw new Error(`${nodeId}/${inputName} must be text.`);
        }
    }
    if (missing.length) throw new Error(`ComfyUI is missing these node types: ${missing.join(', ')}.`);
    return workflow;
}
