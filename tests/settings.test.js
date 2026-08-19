import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { normalizeComfySettings, normalizeModeSettings, profileFromBody } from '../server-plugin/lib/config.js';
import { effectiveLlmSettings } from '../server-plugin/lib/jobs.js';
import { defaultConfig, sanitizeConfig } from '../server-plugin/lib/storage.js';

test('settings template has unique controls and every static button is wired once', () => {
    const html = fs.readFileSync('settings.html', 'utf8');
    const source = fs.readFileSync('index.js', 'utf8');
    const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
    assert.equal(new Set(ids).size, ids.length, 'settings.html contains duplicate IDs');
    const buttons = [...html.matchAll(/<button\b[^>]*\bid="([^"]+)"/g)].map(match => match[1]);
    for (const id of buttons) assert.match(source, new RegExp(`\\$id\\('${id}'\\)\\.addEventListener`), `${id} has no event handler`);
    assert.equal((source.match(/function mountSettings\(html\)/g) || []).length, 1);
    assert.equal((source.match(/^\s*mountSettings\(html\);/gm) || []).length, 1);
    assert.match(source, /if \(\$id\('cpa-settings-shell'\)\) return/);
    assert.match(source, /new BrowserRuntime\(/, 'frontend must provide a no-restart browser runtime');
    assert.match(source, /export async function installExtension\(\)[\s\S]*?location\.reload\(\)/, 'Git install hook must automatically reload the page');
    const manifest = JSON.parse(fs.readFileSync('manifest.json', 'utf8'));
    assert.equal(manifest.hooks.install, 'installExtension');
    assert.doesNotMatch(html, /value="3"|cpa-mode3|Skills -|Agent step/i);
    assert.match(html, /模式 2 系统提示词（完整发送，可编辑）/);
    assert.match(html, /不会再附加不可见的 Anima 提示词/);
    assert.match(html, /宝宝配置教程/);
    assert.match(source, /if \(!tutorialIsComplete\(\)\) openTutorial\(\)/);
});

test('all numeric mode and ComfyUI settings clamp and boolean settings survive partial updates', () => {
    const mode = normalizeModeSettings({ historyTurns: 999, maxInputTokens: 1, maxOutputTokens: 999999, timeoutSeconds: 0 }, defaultConfig.modes[2]);
    assert.equal(mode.historyTurns, 100);
    assert.equal(mode.maxInputTokens, 256);
    assert.equal(mode.maxOutputTokens, 131072);
    assert.equal(mode.timeoutSeconds, 1);
    assert.equal(mode.includePersona, defaultConfig.modes[2].includePersona);

    const comfy = normalizeComfySettings({ url: 'http://127.0.0.1:8188/', concurrency: 99, maxQueue: 0, timeoutSeconds: 1 }, defaultConfig.comfy);
    assert.equal(comfy.url, 'http://127.0.0.1:8188');
    assert.equal(comfy.concurrency, 8);
    assert.equal(comfy.maxQueue, 1);
    assert.equal(comfy.timeoutSeconds, 10);
});

test('Profile and mode token/timeout limits both affect the effective request', () => {
    const profile = profileFromBody({ baseUrl: 'http://127.0.0.1:1234/v1', maxOutputTokens: 4096, timeoutSeconds: 90 });
    assert.deepEqual(effectiveLlmSettings(profile, { maxOutputTokens: 8192, timeoutSeconds: 120 }), { maxOutputTokens: 4096, timeoutSeconds: 90 });
    assert.deepEqual(effectiveLlmSettings(profile, { maxOutputTokens: 2048, timeoutSeconds: 30 }), { maxOutputTokens: 2048, timeoutSeconds: 30 });
});

test('Profile accepts a 64000 token output limit', () => {
    const profile = profileFromBody({ baseUrl: 'http://127.0.0.1:1234/v1', maxOutputTokens: 64000 });
    assert.equal(profile.maxOutputTokens, 64000);
});

test('sanitized configuration never exposes SecretManager key names', () => {
    const config = structuredClone(defaultConfig);
    config.comfy.secretKey = 'internal_comfy_secret_name';
    config.comfy.hasAuthSecret = true;
    config.llmProfiles = [{ id: 'one', secretKey: 'internal_llm_secret_name', hasApiKey: true }];
    const safe = JSON.parse(JSON.stringify(sanitizeConfig(config)));
    assert.equal(safe.comfy.secretKey, undefined);
    assert.equal(safe.comfy.hasAuthSecret, true);
    assert.equal(safe.llmProfiles[0].secretKey, undefined);
    assert.equal(safe.llmProfiles[0].hasApiKey, true);
});
