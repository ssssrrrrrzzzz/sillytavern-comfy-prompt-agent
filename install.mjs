#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const projectRoot = path.dirname(fileURLToPath(import.meta.url));
const args = new Map();
for (let index = 2; index < process.argv.length; index++) {
    const key = process.argv[index];
    if (key.startsWith('--')) args.set(key.slice(2), process.argv[index + 1]?.startsWith('--') ? true : process.argv[++index]);
}

function findSillyTavern() {
    const explicit = args.get('st');
    const ancestors = [];
    for (let current = projectRoot; ; current = path.dirname(current)) {
        ancestors.push(current);
        if (path.dirname(current) === current) break;
    }
    const candidates = [
        explicit,
        process.env.SILLYTAVERN_HOME,
        ...ancestors,
        process.cwd(),
    ].filter(Boolean).map(item => path.resolve(String(item)));
    return candidates.find(candidate => {
        try { return JSON.parse(fs.readFileSync(path.join(candidate, 'package.json'), 'utf8')).name === 'sillytavern'; }
        catch { return false; }
    });
}

function emptyAndCopy(source, target, filter = () => true) {
    fs.mkdirSync(target, { recursive: true });
    for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
        if (!filter(entry)) continue;
        const from = path.join(source, entry.name);
        const to = path.join(target, entry.name);
        if (entry.isDirectory()) emptyAndCopy(from, to, filter);
        else fs.copyFileSync(from, to);
    }
}

function copyFile(relative, targetRoot) {
    const target = path.join(targetRoot, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const source = path.join(projectRoot, relative);
    if (path.resolve(source) !== path.resolve(target)) fs.copyFileSync(source, target);
}

const runtimeFilter = entry => !['.git', '.venv', '__pycache__', 'node_modules'].includes(entry.name) && !entry.name.endsWith('.pyc');

function writeJsonAtomic(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(value, null, 2), 'utf8');
    fs.renameSync(temp, file);
}

function enableServerPlugins(stRoot) {
    const configFile = path.join(stRoot, 'config.yaml');
    if (!fs.existsSync(configFile)) throw new Error(`找不到 ${configFile}`);
    const source = fs.readFileSync(configFile, 'utf8');
    if (/^enableServerPlugins:\s*true\s*$/m.test(source)) return false;
    const backup = `${configFile}.before-comfy-prompt-agent`;
    if (!fs.existsSync(backup)) fs.copyFileSync(configFile, backup);
    const next = /^enableServerPlugins:/m.test(source)
        ? source.replace(/^enableServerPlugins:\s*.*$/m, 'enableServerPlugins: true')
        : `${source.trimEnd()}\n\nenableServerPlugins: true\n`;
    fs.writeFileSync(configFile, next, 'utf8');
    return true;
}

const stRoot = findSillyTavern();
if (!stRoot) {
    console.error('未找到 SillyTavern。请使用：node install.mjs --st /path/to/SillyTavern');
    process.exit(1);
}

function isInstalledExtensionPath(candidate, root) {
    const parts = path.relative(root, candidate).split(path.sep);
    return (parts[0] === 'data' && parts.length === 4 && parts[2] === 'extensions')
        || (parts.length === 5 && parts[0] === 'public' && parts[1] === 'scripts' && parts[2] === 'extensions' && parts[3] === 'third-party');
}

// When SillyTavern's Git installer cloned this repository, the repository is
// already the live frontend extension. Reusing it avoids loading a second copy
// from a fixed Comfy-Prompt-Agent directory.
const frontend = isInstalledExtensionPath(projectRoot, stRoot)
    ? projectRoot
    : path.join(stRoot, 'data', 'default-user', 'extensions', 'Comfy-Prompt-Agent');
const backend = path.join(stRoot, 'plugins', 'comfy-prompt-agent');
const version = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8')).version;
if (!/^[0-9A-Za-z][0-9A-Za-z.-]{0,63}$/.test(version)) throw new Error('package.json contains an invalid version.');
fs.mkdirSync(frontend, { recursive: true });
fs.mkdirSync(backend, { recursive: true });
if (path.resolve(frontend) !== path.resolve(projectRoot)) {
    for (const file of ['browser-runtime.js', 'index.js', 'manifest.json', 'settings.html', 'style.css']) copyFile(file, frontend);
    emptyAndCopy(path.join(projectRoot, 'shared'), path.join(frontend, 'shared'));
    // Keep the versioned server sources beside the frontend extension. After
    // the one-time bootstrap install, its update hook can stage this tree
    // without a SillyTavern process restart.
    emptyAndCopy(path.join(projectRoot, 'server-plugin'), path.join(frontend, 'server-plugin'), runtimeFilter);
}
fs.copyFileSync(path.join(projectRoot, 'plugin-entry.js'), path.join(backend, 'index.js'));
fs.copyFileSync(path.join(projectRoot, 'plugin-package.json'), path.join(backend, 'package.json'));
const release = path.join(backend, 'releases', version);
emptyAndCopy(path.join(projectRoot, 'server-plugin'), path.join(release, 'server-plugin'), runtimeFilter);
emptyAndCopy(path.join(projectRoot, 'shared'), path.join(release, 'shared'));
writeJsonAtomic(path.join(backend, 'active-version.json'), { version, installedAt: Date.now() });

const seedWorkflow = args.get('workflow');
if (seedWorkflow) {
    const source = path.resolve(String(seedWorkflow));
    const target = path.join(stRoot, 'data', 'default-user', 'comfy-prompt-agent', 'workflow-imports', path.basename(source));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
    console.log(`已放入待扫描工作流目录：${target}`);
}

const changed = enableServerPlugins(stRoot);
console.log(`前端已安装：${frontend}`);
console.log(`后端 ${version} 已暂存：${release}`);
console.log(changed ? '已启用 enableServerPlugins: true（原 config.yaml 已备份）。' : 'enableServerPlugins 已启用。');
console.log('首次安装或旧版引导器升级需要完整重启一次；以后版本可在任务空闲时热切换。');
