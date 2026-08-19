import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { writeJobToOriginalSwipe } from '../server-plugin/lib/message-store.js';
import { DEFAULT_MODE_PROMPT, readConfig } from '../server-plugin/lib/storage.js';

test('background result writes only to matching original swipe trigger', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cpa-chat-'));
    const dirs = { root, chats: path.join(root, 'chats'), groupChats: path.join(root, 'group chats') };
    const folder = path.join(dirs.chats, 'hero'); fs.mkdirSync(folder, { recursive: true });
    const file = path.join(folder, 'session.jsonl');
    const message = { mes: 'clean', swipe_id: 0, swipes: ['clean'], swipe_info: [{ extra: { comfy_prompt_agent: { trigger_hash: 'right', status: 'pending' }, media: [{ type: 'image', url: '/existing.png' }] } }], extra: {} };
    fs.writeFileSync(file, `${JSON.stringify({ chat_metadata: {} })}\n${JSON.stringify(message)}`);
    const job = { id: 'job1', mode: 1, status: 'completed', error: '', directories: dirs, spec: { triggerHash: 'right', directive: 'scene', target: { chatId: 'session', avatar: 'hero.png', isGroup: false, messageIndex: 0, swipeId: 0 } }, result: { positivePrompt: 'positive', negativePrompt: 'preset negative', workflow: { name: 'wf' }, preset: { name: 'p' }, parameters: {}, images: [{ path: '/user/images/a.png' }], context: {}, agentSteps: 0, toolLog: [] } };
    assert.equal(writeJobToOriginalSwipe(job), true);
    const saved = JSON.parse(fs.readFileSync(file, 'utf8').split('\n')[1]);
    assert.equal(saved.swipe_info[0].extra.comfy_prompt_agent.positive_prompt, 'positive');
    assert.deepEqual(saved.swipe_info[0].extra.media.map(item => item.url), ['/existing.png', '/user/images/a.png']);
    assert.deepEqual(saved.extra.media.map(item => item.url), ['/existing.png', '/user/images/a.png']);
    job.spec.triggerHash = 'stale';
    assert.equal(writeJobToOriginalSwipe(job), false);
});

test('installer lays out both halves and enables server plugins with backup', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cpa-install-'));
    fs.writeFileSync(path.join(root, 'package.json'), '{"name":"sillytavern"}');
    fs.writeFileSync(path.join(root, 'config.yaml'), 'port: 8000\nenableServerPlugins: false\n');
    const userData = path.join(root, 'data/default-user/comfy-prompt-agent');
    fs.mkdirSync(userData, { recursive: true });
    const preserved = '{"mode":2,"sentinel":"keep-current-user-config"}';
    fs.writeFileSync(path.join(userData, 'config.json'), preserved);
    execFileSync(process.execPath, [path.resolve('install.mjs'), '--st', root], { cwd: path.resolve('.') });
    assert.ok(fs.existsSync(path.join(root, 'data/default-user/extensions/Comfy-Prompt-Agent/index.js')));
    assert.ok(fs.existsSync(path.join(root, 'data/default-user/extensions/Comfy-Prompt-Agent/browser-runtime.js')));
    assert.ok(fs.existsSync(path.join(root, 'data/default-user/extensions/Comfy-Prompt-Agent/server-plugin/lib/jobs.js')));
    assert.ok(fs.existsSync(path.join(root, 'data/default-user/extensions/Comfy-Prompt-Agent/server-plugin/bundled/workflows/Anima-ComfyUI.json')));
    assert.ok(fs.existsSync(path.join(root, 'plugins/comfy-prompt-agent/releases/0.5.10/server-plugin/lib/jobs.js')));
    assert.ok(fs.existsSync(path.join(root, 'plugins/comfy-prompt-agent/releases/0.5.10/shared/context.js')));
    assert.ok(fs.existsSync(path.join(root, 'plugins/comfy-prompt-agent/releases/0.5.10/shared/mode1-display.js')));
    assert.ok(fs.existsSync(path.join(root, 'plugins/comfy-prompt-agent/releases/0.5.10/shared/mode2-prompt.js')));
    assert.ok(fs.existsSync(path.join(root, 'plugins/comfy-prompt-agent/releases/0.5.10/shared/network-error.js')));
    assert.ok(fs.existsSync(path.join(root, 'plugins/comfy-prompt-agent/releases/0.5.10/shared/swipe-state.js')));
    assert.ok(fs.existsSync(path.join(root, 'plugins/comfy-prompt-agent/releases/0.5.10/shared/version.js')));
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'plugins/comfy-prompt-agent/active-version.json'), 'utf8')).version, '0.5.10');
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'plugins/comfy-prompt-agent/package.json'), 'utf8')).type, 'module');
    assert.match(fs.readFileSync(path.join(root, 'config.yaml'), 'utf8'), /enableServerPlugins: true/);
    assert.ok(fs.existsSync(path.join(root, 'config.yaml.before-comfy-prompt-agent')));
    assert.equal(fs.readFileSync(path.join(userData, 'config.json'), 'utf8'), preserved);
});

test('Git-installed extension is reused in place and never creates a duplicate frontend', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cpa-git-install-'));
    fs.writeFileSync(path.join(root, 'package.json'), '{"name":"sillytavern"}');
    fs.writeFileSync(path.join(root, 'config.yaml'), 'enableServerPlugins: true\n');
    const clone = path.join(root, 'data/default-user/extensions/sillytavern-comfy-prompt-agent');
    fs.cpSync(path.resolve('.'), clone, {
        recursive: true,
        filter: source => !source.includes(`${path.sep}.git`) && !source.includes(`${path.sep}node_modules`),
    });
    execFileSync(process.execPath, [path.join(clone, 'install.mjs')], { cwd: clone });
    assert.ok(fs.existsSync(path.join(clone, 'manifest.json')));
    assert.equal(fs.existsSync(path.join(root, 'data/default-user/extensions/Comfy-Prompt-Agent')), false);
    assert.ok(fs.existsSync(path.join(root, 'plugins/comfy-prompt-agent/index.js')));
});

test('legacy built-in mode 2 prompt migrates without replacing custom prompts', () => {
    const legacy = 'Convert the tagged scene request and recent roleplay context into one detailed image-generation positive prompt. Describe only visible content. Return JSON only: {"positive_prompt":"..."}.';
    const previous = 'Infer the scene to illustrate from the supplied recent roleplay conversation and optional context. Convert it into one detailed Danbooru-style image-generation positive prompt. The image tag is only a trigger and its body is not provided. Describe only visible content. Return JSON only: {"positive_prompt":"..."}.';
    const previousPlain = 'Infer the scene to illustrate from the supplied recent roleplay conversation and optional context. Convert it into one detailed Danbooru-style image-generation positive prompt. The image tag is only a trigger and its body is not provided. Describe only visible content. Output exactly one line containing only the final prompt, with no label, explanation, Markdown, JSON, or negative prompt.';
    const previousVisibleDefault = 'Infer the scene to illustrate from the supplied recent roleplay conversation, current AI reply, and optional context. Convert it into one detailed Danbooru-style image-generation positive prompt; no image tag is required. Describe only visible content in one coherent composition. Never request a contact sheet, character sheet, collage, grid, panels, lineup, or multiple views. Output exactly one line containing only the final prompt, with no label, explanation, Markdown, JSON, or negative prompt.';
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cpa-config-'));
    const dataRoot = path.join(root, 'comfy-prompt-agent');
    fs.mkdirSync(dataRoot, { recursive: true });
    fs.writeFileSync(path.join(dataRoot, 'config.json'), JSON.stringify({ modes: { 2: { promptTemplate: legacy } } }));
    assert.equal(readConfig({ root }).modes[2].promptTemplate, DEFAULT_MODE_PROMPT);

    fs.writeFileSync(path.join(dataRoot, 'config.json'), JSON.stringify({ modes: { 2: { promptTemplate: previousPlain } } }));
    assert.equal(readConfig({ root }).modes[2].promptTemplate, DEFAULT_MODE_PROMPT);

    fs.writeFileSync(path.join(dataRoot, 'config.json'), JSON.stringify({ modes: { 2: { promptTemplate: previous } } }));
    assert.equal(readConfig({ root }).modes[2].promptTemplate, DEFAULT_MODE_PROMPT);

    fs.writeFileSync(path.join(dataRoot, 'config.json'), JSON.stringify({ modes: { 2: { promptTemplate: previousVisibleDefault } } }));
    assert.equal(readConfig({ root }).modes[2].promptTemplate, DEFAULT_MODE_PROMPT);

    fs.writeFileSync(path.join(dataRoot, 'config.json'), JSON.stringify({ modes: { 2: { promptTemplate: 'my custom prompt' } } }));
    assert.equal(readConfig({ root }).modes[2].promptTemplate, 'my custom prompt');
});
