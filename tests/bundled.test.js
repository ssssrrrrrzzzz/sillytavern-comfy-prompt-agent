import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { deleteSkill, initializeBundledResources, skillCatalogue } from '../server-plugin/lib/resources.js';
import { readConfig } from '../server-plugin/lib/storage.js';
import { bundledWorkflowFile, importWorkflow, initializeBundledWorkflows, loadWorkflow } from '../server-plugin/lib/workflows.js';
import { validateApiWorkflow } from '../shared/workflow.js';

const bundledSkill = path.resolve('server-plugin/bundled/anima-prompt');

function directories() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cpa-bundled-'));
    return { root, userImages: path.join(root, 'images'), comfyWorkflows: path.join(root, 'comfy-workflows') };
}

test('release contains the original Anima Skill and both workflow formats', () => {
    assert.ok(fs.existsSync(path.join(bundledSkill, 'SKILL.md')));
    assert.ok(fs.existsSync(path.join(bundledSkill, 'references', 'reference.md')));
    assert.ok(fs.existsSync(path.join(bundledSkill, 'scripts', 'check_prompt.py')));
    const api = JSON.parse(fs.readFileSync(bundledWorkflowFile('anima-api').path, 'utf8'));
    validateApiWorkflow(api);
    const ui = JSON.parse(fs.readFileSync(bundledWorkflowFile('anima-comfyui').path, 'utf8'));
    assert.ok(Array.isArray(ui.nodes) && ui.nodes.length > 0);
});

test('fresh user automatically gets selected Anima Skill and runnable API workflow preset', () => {
    const dirs = directories();
    initializeBundledResources(dirs);
    initializeBundledWorkflows(dirs);
    const config = readConfig(dirs);
    assert.ok(config.modes[3].skillIds.includes('anima-prompt'));
    assert.equal(skillCatalogue(dirs)[0].id, 'anima-prompt');
    assert.equal(config.workflows.length, 1);
    assert.equal(config.selectedWorkflowId, config.workflows[0].id);
    const preset = config.workflows[0].presets[0];
    assert.deepEqual(preset.positiveTargets.map(item => `${item.nodeId}/${item.inputName}`), ['161:165/value']);
    assert.deepEqual(preset.negativeTargets.map(item => `${item.nodeId}/${item.inputName}`), ['161:159/text']);
    assert.deepEqual(preset.outputNodeIds, ['163']);
    assert.ok(preset.visible['157'].includes('sampler_name'));
    assert.equal(preset.agentControllable['161:159'], undefined);
    validateApiWorkflow(loadWorkflow(dirs, config.workflows[0].id).workflow);

    initializeBundledResources(dirs);
    initializeBundledWorkflows(dirs);
    assert.equal(readConfig(dirs).workflows.length, 1);

    deleteSkill(dirs, 'anima-prompt');
    initializeBundledResources(dirs);
    assert.equal(readConfig(dirs).skills.length, 0, 'deleted bundled Skill must stay deleted');
});

test('bundled validator accepts a multi-character prompt without BREAK', () => {
    const output = execFileSync('python3', [path.join(bundledSkill, 'scripts', 'check_format.py'), '2girls, black hair, blonde hair, classroom', '--json'], { encoding: 'utf8' });
    assert.equal(JSON.parse(output).passed, true);
});

test('legacy bundled Anima workflow migrates in place without creating a duplicate', () => {
    const dirs = directories();
    const current = fs.readFileSync(bundledWorkflowFile('anima-api').path, 'utf8');
    const legacy = current.replace('anima-aesthetic-v1.1.safetensors', 'anima_baseV10.safetensors');
    const imported = importWorkflow(dirs, { name: 'AnimaApi', workflow: legacy, source: 'scan:legacy/AnimaApi.json' });
    assert.equal(imported.hash, '0503085043b22bbf2da8c21d4b08a9d291f20d5d53788f64b1bd49b9f229b27d');
    initializeBundledResources(dirs);
    initializeBundledWorkflows(dirs);
    const config = readConfig(dirs);
    assert.equal(config.workflows.length, 1);
    assert.equal(config.workflows[0].presets[0].values['156:153'].unet_name, 'anima-aesthetic-v1.1.safetensors');
    assert.equal(loadWorkflow(dirs, config.workflows[0].id).workflow['156:153'].inputs.unet_name, 'anima-aesthetic-v1.1.safetensors');
});
