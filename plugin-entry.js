import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const info = {
    id: 'comfy-prompt-agent',
    name: 'Comfy Prompt Agent',
    description: 'Hot-reload bootstrap for the Comfy Prompt Agent server runtime.',
};

const BOOTSTRAP_API = 1;
const backendRoot = path.dirname(fileURLToPath(import.meta.url));
const releasesRoot = path.join(backendRoot, 'releases');
const activeVersionFile = path.join(backendRoot, 'active-version.json');
let activeRuntime = null;
let transition = Promise.resolve();

function validVersion(value) {
    const version = String(value || '');
    if (!/^[0-9A-Za-z][0-9A-Za-z.-]{0,63}$/.test(version)) throw new Error('Invalid runtime version.');
    return version;
}

function installedVersion() {
    const data = JSON.parse(fs.readFileSync(activeVersionFile, 'utf8'));
    return validVersion(data.version);
}

function releaseEntry(version) {
    const root = path.join(releasesRoot, validVersion(version));
    const entry = path.join(root, 'server-plugin', 'index.js');
    if (!fs.existsSync(entry)) throw new Error(`Installed runtime ${version} is incomplete.`);
    return entry;
}

function copyRuntimeTree(sourceRoot, targetRoot) {
    let files = 0;
    let bytes = 0;
    const copy = (source, target) => {
        const stat = fs.lstatSync(source);
        if (stat.isSymbolicLink()) throw new Error('Runtime source may not contain symbolic links.');
        if (stat.isDirectory()) {
            fs.mkdirSync(target, { recursive: true });
            for (const name of fs.readdirSync(source)) copy(path.join(source, name), path.join(target, name));
            return;
        }
        if (!stat.isFile()) throw new Error('Runtime source contains an unsupported file type.');
        files += 1;
        bytes += stat.size;
        if (files > 500 || bytes > 25 * 1024 * 1024) throw new Error('Runtime source exceeds update limits.');
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(source, target);
    };
    for (const directory of ['server-plugin', 'shared']) {
        const source = path.join(sourceRoot, directory);
        if (!fs.existsSync(source)) throw new Error(`Extension update is missing ${directory}/.`);
        copy(source, path.join(targetRoot, directory));
    }
}

function stageFromExtension(directories, extensionName) {
    const folder = String(extensionName || '');
    if (!/^[A-Za-z0-9_.-]+$/.test(folder)) throw new Error('Invalid extension folder name.');
    const extensionsRoot = path.resolve(directories.extensions);
    const sourceRoot = path.resolve(extensionsRoot, folder);
    if (!sourceRoot.startsWith(`${extensionsRoot}${path.sep}`)) throw new Error('Extension path escaped its root.');
    const manifest = JSON.parse(fs.readFileSync(path.join(sourceRoot, 'manifest.json'), 'utf8'));
    const version = validVersion(manifest.version);
    const target = path.join(releasesRoot, version);
    if (!fs.existsSync(target)) {
        fs.mkdirSync(releasesRoot, { recursive: true });
        const staging = path.join(releasesRoot, `.staging-${version}-${process.pid}-${Date.now()}`);
        try {
            copyRuntimeTree(sourceRoot, staging);
            fs.renameSync(staging, target);
        } catch (error) {
            fs.rmSync(staging, { recursive: true, force: true });
            throw error;
        }
    }
    const temp = `${activeVersionFile}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify({ version, stagedAt: Date.now() }, null, 2), 'utf8');
    fs.renameSync(temp, activeVersionFile);
    return version;
}

async function createRuntime(version, services) {
    const entry = releaseEntry(version);
    const stamp = fs.statSync(entry).mtimeMs;
    const module = await import(`${pathToFileURL(entry).href}?loaded=${stamp}`);
    if (String(module.PLUGIN_VERSION) !== version) throw new Error(`Runtime declares ${module.PLUGIN_VERSION || 'no version'}, expected ${version}.`);
    const runtimeRouter = express.Router();
    const controller = await module.init(runtimeRouter, services);
    return { version, router: runtimeRouter, controller: controller || {} };
}

async function switchRuntime(version, services) {
    const target = validVersion(version);
    if (activeRuntime?.version === target) return activeRuntime;
    if (activeRuntime?.controller?.canReload && !activeRuntime.controller.canReload()) {
        const error = new Error('Prompt/ComfyUI jobs are still active; retry hot reload after they finish.');
        error.status = 409;
        throw error;
    }
    const next = await createRuntime(target, services);
    const previous = activeRuntime;
    activeRuntime = next;
    await previous?.controller?.shutdown?.();
    return next;
}

function serializeTransition(task) {
    const next = transition.then(task, task);
    transition = next.catch(() => {});
    return next;
}

export async function init(router) {
    const secrets = await import('../../src/endpoints/secrets.js');
    const services = { secrets };
    await switchRuntime(installedVersion(), services);

    router.get('/health', (_request, response) => response.json({
        ok: true,
        version: activeRuntime?.version || '',
        installedVersion: installedVersion(),
        hotReload: true,
        bootstrapApi: BOOTSTRAP_API,
        idle: activeRuntime?.controller?.canReload?.() ?? true,
    }));

    router.post('/reload', async (request, response) => {
        try {
            if (!request.user?.profile?.admin) return response.status(403).json({ error: 'Administrator permission is required.' });
            const runtime = await serializeTransition(() => switchRuntime(installedVersion(), services));
            response.json({ ok: true, version: runtime.version });
        } catch (error) {
            response.status(error.status || 500).json({ error: String(error.message || error) });
        }
    });

    router.post('/stage-update', async (request, response) => {
        try {
            if (!request.user?.profile?.admin) return response.status(403).json({ error: 'Administrator permission is required.' });
            if (!request.user?.directories?.extensions) throw new Error('No user extension directory is available.');
            const version = stageFromExtension(request.user.directories, request.body?.extensionName);
            const runtime = await serializeTransition(() => switchRuntime(version, services));
            response.json({ ok: true, version: runtime.version });
        } catch (error) {
            response.status(error.status || 500).json({ error: String(error.message || error) });
        }
    });

    router.use((request, response, next) => {
        if (!activeRuntime) return response.status(503).json({ error: 'Comfy Prompt Agent runtime is unavailable.' });
        return activeRuntime.router(request, response, next);
    });
}

export async function exit() {
    await activeRuntime?.controller?.shutdown?.();
    activeRuntime = null;
}

export default { info, init, exit };
