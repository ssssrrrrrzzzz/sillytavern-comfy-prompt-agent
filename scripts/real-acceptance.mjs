#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { ComfyClient } from '../server-plugin/lib/comfy.js';
import { applyWorkflowPreset, describeEditableInputs, discoverWorkflow, isLink, validateApiWorkflow } from '../shared/workflow.js';
import { validateRuntimeWorkflow } from '../server-plugin/lib/workflows.js';

const args = new Map();
for (let index = 2; index < process.argv.length; index++) {
    const key = process.argv[index];
    if (key.startsWith('--')) args.set(key.slice(2), process.argv[index + 1]?.startsWith('--') ? true : process.argv[++index]);
}

const workflowFile = path.resolve(String(args.get('workflow') || 'server-plugin/bundled/workflows/Anima-API.json'));
const userRoot = path.resolve(String(args.get('user-root') || process.env.SILLYTAVERN_USER_ROOT || '.acceptance-user'));
const url = String(args.get('url') || 'http://127.0.0.1:8188');
const prompt = String(args.get('prompt') || '1girl, solo, black hair, blue eyes, white shirt, upper body, looking at viewer, gentle smile, indoors, soft lighting');
const shouldGenerate = args.get('generate') === true || args.get('generate') === 'true';
const unetOverride = args.has('unet') ? String(args.get('unet')) : '';

const workflow = JSON.parse(fs.readFileSync(workflowFile, 'utf8'));
validateApiWorkflow(workflow);
const discovery = discoverWorkflow(workflow);
const markerTarget = discovery.promptCandidates.find(target => {
    const value = workflow[String(target.nodeId)]?.inputs?.[target.inputName];
    return typeof value === 'string' && /__PROMPT__|%prompt%/i.test(value);
}) || discovery.promptCandidates[0];
if (!markerTarget) throw new Error('No positive prompt candidate was found.');

const negativeTarget = discovery.negativeCandidates[0];
const negativePrompt = negativeTarget ? String(workflow[String(negativeTarget.nodeId)]?.inputs?.[negativeTarget.inputName] || '') : '';
const values = {};
for (const [nodeId, node] of Object.entries(workflow)) {
    for (const [inputName, value] of Object.entries(node.inputs || {})) {
        if (isLink(value)) continue;
        (values[nodeId] ||= {})[inputName] = value;
    }
}
const preset = {
    positiveTargets: [markerTarget],
    negativeTargets: negativeTarget ? [negativeTarget] : [],
    negativePrompt,
    outputNodeIds: discovery.outputNodes,
    values,
    agentControllable: {},
};
const runtime = applyWorkflowPreset(workflow, preset, prompt);
if (unetOverride) {
    const unetEntry = Object.entries(runtime).find(([, node]) => node.class_type === 'UNETLoader' && typeof node.inputs?.unet_name === 'string');
    if (!unetEntry) throw new Error('The workflow has no editable UNETLoader.unet_name input.');
    unetEntry[1].inputs.unet_name = unetOverride;
}
const client = new ComfyClient({ url, authType: 'none', timeoutSeconds: Number(args.get('timeout') || 600) });
const stats = await client.probe();
const objectInfo = await client.objectInfo();
validateRuntimeWorkflow(runtime, objectInfo);
const dynamicInputs = describeEditableInputs(runtime, objectInfo);
const interesting = dynamicInputs.filter(input => /model|unet|clip|vae|sampler|scheduler|seed|steps|cfg|width|height/i.test(`${input.classType} ${input.inputName}`));

const report = {
    ok: true,
    comfyuiVersion: stats.system?.comfyui_version,
    device: stats.devices?.[0]?.name,
    objectTypes: Object.keys(objectInfo).length,
    workflowNodes: Object.keys(workflow).length,
    runtimeOverrides: unetOverride ? { unet: unetOverride } : {},
    positiveTarget: markerTarget,
    negativeTarget: negativeTarget || null,
    negativePromptLength: negativePrompt.length,
    outputNodeIds: preset.outputNodeIds,
    dynamicInputs: interesting.map(input => ({ nodeId: input.nodeId, inputName: input.inputName, type: input.type, value: input.value, optionCount: input.options?.length || 0, metadata: input.metadata })),
};
console.log(JSON.stringify(report, null, 2));

if (shouldGenerate) {
    const directories = { root: userRoot, userImages: path.join(userRoot, 'user', 'images') };
    const controller = new AbortController();
    const images = await client.generate(runtime, preset.outputNodeIds, directories, controller.signal, (stage, detail) => {
        console.log(JSON.stringify({ stage, ...detail }));
    });
    console.log(JSON.stringify({ completed: true, promptId: client.promptId, images }, null, 2));
}
