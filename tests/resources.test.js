import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createReference, initializeBundledResources, readReference, runSkillScript, scanSkills, searchReferences, setSkillTrust, skillCatalogue, updateReference } from '../server-plugin/lib/resources.js';
import { readConfig, updateConfig } from '../server-plugin/lib/storage.js';

function directories(root) { return { root, userImages: path.join(root, 'user', 'images'), comfyWorkflows: path.join(root, 'workflows') }; }

test('references are summarized, section-indexed, searched and read on demand', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cpa-ref-'));
    const dirs = directories(root);
    const ref = createReference(dirs, { title: 'Guide', content: 'preamble\n# Portrait\nface lighting '.repeat(20) + '\n# Landscape\nmountain fog '.repeat(20) });
    assert.ok(ref.sections.length >= 3);
    const matches = searchReferences(dirs, [ref.id], 'mountain');
    assert.equal(matches[0].id, ref.id);
    assert.match(readReference(dirs, ref.id, 1000, matches[0].section).content, /mountain/);
    const updated = updateReference(dirs, ref.id, { content: '# New\nupdated body' });
    assert.equal(updated.sections[0].title, 'New');
});

test('Skill scripts are denied until explicit trust, then execute without a shell', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cpa-skill-'));
    const dirs = directories(root);
    const skillRoot = path.join(root, 'comfy-prompt-agent', 'skills', 'test-skill');
    fs.mkdirSync(path.join(skillRoot, 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(skillRoot, 'references'), { recursive: true });
    fs.writeFileSync(path.join(skillRoot, 'SKILL.md'), '---\nname: test-skill\n---\nInstructions');
    fs.writeFileSync(path.join(skillRoot, 'references', 'guide.md'), '# Guide');
    fs.writeFileSync(path.join(skillRoot, 'scripts', 'echo.mjs'), 'console.log(JSON.stringify(process.argv.slice(2)))');
    assert.equal(scanSkills(dirs).length, 1);
    assert.deepEqual(skillCatalogue(dirs)[0].scripts, ['scripts/echo.mjs']);
    await assert.rejects(() => runSkillScript(dirs, 'test-skill', 'scripts/echo.mjs', ['a; echo injected']), /not trusted/);
    setSkillTrust(dirs, 'test-skill', true);
    const result = await runSkillScript(dirs, 'test-skill', 'scripts/echo.mjs', ['a; echo injected']);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /a; echo injected/);
    assert.doesNotMatch(result.stdout, /\ninjected\n/);
    await assert.rejects(() => runSkillScript(dirs, 'test-skill', '../outside.js', []), /unsafe path|scripts\//i);
    assert.equal(scanSkills(dirs)[0].trusted, true, 'unchanged trusted code stays trusted');
    fs.writeFileSync(path.join(skillRoot, 'scripts', 'echo.mjs'), 'console.log("changed")');
    assert.equal(scanSkills(dirs)[0].trusted, false, 'changed executable code revokes trust');
});

test('installer-supplied anima-prompt is discovered and selected only once', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cpa-seed-skill-'));
    const dirs = directories(root);
    const skillRoot = path.join(root, 'comfy-prompt-agent', 'skills', 'anima-prompt');
    fs.mkdirSync(path.join(skillRoot, 'references'), { recursive: true });
    fs.writeFileSync(path.join(skillRoot, 'SKILL.md'), '---\nname: anima-prompt\ndescription: Test\n---\nInstructions');
    fs.writeFileSync(path.join(skillRoot, 'references', 'guide.md'), '# Guide');

    const initialized = initializeBundledResources(dirs);
    assert.equal(initialized.resourceDiscovery.initialized, true);
    assert.deepEqual(initialized.modes[3].skillIds, ['anima-prompt']);
    assert.deepEqual(skillCatalogue(dirs, ['anima-prompt'])[0].references, ['references/guide.md']);

    updateConfig(dirs, config => { config.modes[3].skillIds = []; });
    initializeBundledResources(dirs);
    assert.deepEqual(readConfig(dirs).modes[3].skillIds, [], 'manual deselection must be preserved');
});
