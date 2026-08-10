import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { readSkillFile, runSkillScript, scanSkills, setSkillTrust, skillCatalogue } from '../server-plugin/lib/resources.js';
import { discoverWorkflow, validateApiWorkflow } from '../shared/workflow.js';

const animaRoot = path.resolve('server-plugin/bundled/anima-prompt');

test('bundled anima-prompt can be read and its validator invoked after trust', { skip: spawnSync('uv', ['--version']).status !== 0, timeout: 120000 }, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cpa-anima-'));
    const target = path.join(root, 'comfy-prompt-agent', 'skills', 'anima-prompt');
    fs.cpSync(animaRoot, target, { recursive: true, filter: source => !source.includes(`${path.sep}.git`) && !source.includes(`${path.sep}.venv`) });
    const dirs = { root, userImages: path.join(root, 'images'), comfyWorkflows: path.join(root, 'workflows') };
    assert.equal(scanSkills(dirs)[0].name, 'anima-prompt');
    const catalogue = skillCatalogue(dirs)[0];
    assert.ok(catalogue.references.includes('references/reference.md'));
    assert.ok(catalogue.scripts.includes('scripts/check_prompt.py'));
    assert.match(readSkillFile(dirs, 'anima-prompt', 'SKILL.md'), /Anima Prompt Engineer/);
    setSkillTrust(dirs, 'anima-prompt', true);
    const result = await runSkillScript(dirs, 'anima-prompt', 'scripts/check_prompt.py', ['1girl, solo, black hair, blue eyes'], { timeoutSeconds: 90, maxOutputChars: 20000 });
    assert.notEqual(result.timedOut, true);
    assert.match(`${result.stdout}${result.stderr}`, /passed|warning|error/i);
    const workflow = JSON.parse(fs.readFileSync(path.join(animaRoot, 'workflows/t2i/AnimaApi.json'), 'utf8'));
    validateApiWorkflow(workflow);
    assert.ok(discoverWorkflow(workflow).promptCandidates.length > 0);
});
