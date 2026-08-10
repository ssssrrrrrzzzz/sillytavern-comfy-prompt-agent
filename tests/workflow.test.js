import assert from 'node:assert/strict';
import test from 'node:test';

import { applyWorkflowPreset, composePositivePrompt, describeEditableInputs, discoverWorkflow, normalizeArtistPrompt, validateApiWorkflow } from '../shared/workflow.js';

const template = {
    1: { class_type: 'CLIPTextEncode', _meta: { title: 'Positive' }, inputs: { text: '__PROMPT__', clip: ['9', 0] } },
    2: { class_type: 'CLIPTextEncode', _meta: { title: 'Negative' }, inputs: { text: 'old negative', clip: ['9', 0] } },
    3: { class_type: 'KSampler', inputs: { seed: 1, steps: 20, cfg: 7, sampler_name: 'euler', model: ['9', 0] } },
    4: { class_type: 'SaveImage', inputs: { images: ['3', 0], filename_prefix: 'test' } },
    9: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'model.safetensors' } },
};

const preset = {
    positiveTargets: [{ nodeId: '1', inputName: 'text' }],
    negativeTargets: [{ nodeId: '2', inputName: 'text' }],
    artistPrompt: 'artist:foo_bar, @second artist, foo_bar',
    negativePrompt: 'preset bad anatomy',
    values: { 1: { text: 'stale positive' }, 2: { text: 'stale negative' }, 3: { steps: 24, cfg: 6.5 } },
    agentControllable: { 3: ['steps'] },
};

test('workflow discovery finds prompt and output candidates', () => {
    const found = discoverWorkflow(template);
    assert.ok(found.promptCandidates.some(item => item.nodeId === '1'));
    assert.deepEqual(found.negativeCandidates.map(item => item.nodeId), ['2']);
    assert.deepEqual(found.outputNodes, ['4']);
});

test('runtime prompts are applied after preset snapshots and Agent cannot touch negatives', () => {
    const result = applyWorkflowPreset(template, preset, 'fresh positive', { 3: { steps: 30 } }, { seedFactory: () => 987654321 });
    assert.equal(result[1].inputs.text, '@foo bar, @second artist, fresh positive');
    assert.equal(result[2].inputs.text, 'preset bad anatomy');
    assert.equal(result[3].inputs.steps, 30);
    assert.equal(result[3].inputs.seed, 987654321, 'API workflow seeds randomize by default');
    assert.equal(template[1].inputs.text, '__PROMPT__', 'template remains immutable');
    assert.throws(() => applyWorkflowPreset(template, preset, 'x', { 2: { text: 'LLM negative' } }), /cannot control/);
});

test('preset can keep a fixed seed and an allowlisted Agent seed wins over randomization', () => {
    const fixed = applyWorkflowPreset(template, { ...preset, randomizeSeed: false }, 'x');
    assert.equal(fixed[3].inputs.seed, 1);
    const controlled = applyWorkflowPreset(template, { ...preset, agentControllable: { 3: ['seed'] } }, 'x', { 3: { seed: 42 } }, { seedFactory: () => 99 });
    assert.equal(controlled[3].inputs.seed, 42);
});

test('Anima artist strings gain @ prefixes, use spaces and do not duplicate prompt tags', () => {
    assert.equal(normalizeArtistPrompt('foo_bar\n@Second Artist, artist:foo_bar'), '@foo bar, @Second Artist');
    assert.equal(composePositivePrompt('@foo bar, 1girl, solo', 'foo_bar, second_artist'), '@second artist, @foo bar, 1girl, solo');
});

test('dynamic input descriptions preserve enums, numeric metadata and hide links', () => {
    const objectInfo = {
        KSampler: { input: { required: { seed: ['INT', { min: 0, max: 100 }], steps: ['INT', { min: 1, max: 100 }], sampler_name: [['euler', 'dpmpp_2m']] } } },
    };
    const inputs = describeEditableInputs(template, objectInfo);
    assert.ok(!inputs.some(input => input.inputName === 'model'));
    assert.deepEqual(inputs.find(input => input.inputName === 'sampler_name').options, ['euler', 'dpmpp_2m']);
    assert.equal(inputs.find(input => input.inputName === 'steps').metadata.max, 100);
    assert.throws(() => validateApiWorkflow({ bad: { class_type: 'X' } }), /not a ComfyUI API-format/);
});
