import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runPromptAgent } from '../server-plugin/lib/agent.js';
import { scanSkills } from '../server-plugin/lib/resources.js';
import { updateConfig } from '../server-plugin/lib/storage.js';

test('Mode 3 automatically includes the selected full SKILL.md up to its configured limit', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cpa-agent-skill-'));
    const directories = { root };
    const skillRoot = path.join(root, 'comfy-prompt-agent', 'skills', 'long-skill');
    fs.mkdirSync(skillRoot, { recursive: true });
    fs.writeFileSync(path.join(skillRoot, 'SKILL.md'), `---\nname: long-skill\ndescription: Test\n---\n${'x'.repeat(2500)}FULL_SKILL_MARKER`);
    scanSkills(directories);
    updateConfig(directories, config => { config.modes[3].skillIds = ['long-skill']; });

    const client = {
        async complete(messages) {
            const catalogue = messages.find(message => message.content.startsWith('Selected resource catalogue:'))?.content || '';
            assert.match(catalogue, /FULL_SKILL_MARKER/);
            return { content: '{"action":"final","positive_prompt":"1girl, solo"}', reasoningContent: '', toolCalls: [], rawMessage: {}, usage: {} };
        },
    };
    const result = await runPromptAgent(client, directories, [], {
        ...updateConfig(directories, config => config).modes[3],
        referenceReadChars: 12000,
        maxSteps: 1,
    });
    assert.equal(result.positivePrompt, '1girl, solo');
});
