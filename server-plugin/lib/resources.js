import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { fetchWithTimeout, readResponseLimited, validateUrl } from './http.js';
import { ensureDataLayout, newId, readConfig, safeItemPath, sha256, updateConfig } from './storage.js';

const REFERENCE_EXTENSIONS = new Set(['.md', '.txt', '.json', '.yaml', '.yml']);
const SCRIPT_EXTENSIONS = new Set(['.py', '.js', '.mjs', '.cjs']);
const BUNDLED_ANIMA_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bundled', 'anima-prompt');
let activeScripts = 0;
const runtimeScannedRoots = new Set();

function seedBundledAnimaSkill(directories) {
    if (!fs.existsSync(path.join(BUNDLED_ANIMA_ROOT, 'SKILL.md'))) return false;
    const targetRoot = path.join(ensureDataLayout(directories), 'skills', 'anima-prompt');
    if (fs.existsSync(path.join(targetRoot, 'SKILL.md'))) return false;
    let files = 0;
    let bytes = 0;
    const copy = (source, target) => {
        const stat = fs.lstatSync(source);
        if (stat.isSymbolicLink()) throw new Error('Bundled Skill may not contain symbolic links.');
        if (stat.isDirectory()) {
            fs.mkdirSync(target, { recursive: true });
            for (const entry of fs.readdirSync(source)) copy(path.join(source, entry), path.join(target, entry));
            return;
        }
        if (!stat.isFile()) return;
        files += 1;
        bytes += stat.size;
        if (files > 500 || bytes > 25 * 1024 * 1024) throw new Error('Bundled Skill exceeds installation limits.');
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(source, target);
    };
    copy(BUNDLED_ANIMA_ROOT, targetRoot);
    return true;
}

function safeRelative(relative) {
    const normalized = path.posix.normalize(String(relative).replaceAll('\\', '/')).replace(/^\.\//, '');
    if (!normalized || normalized.startsWith('../') || path.posix.isAbsolute(normalized) || normalized.includes('\0')) throw new Error('Archive contains an unsafe path.');
    return normalized;
}

async function unzipEntries(buffer) {
    if (buffer.length > 50 * 1024 * 1024) throw new Error('Skill archive exceeds 50 MB.');
    const { default: yauzl } = await import('yauzl');
    const openZip = promisify(yauzl.fromBuffer.bind(yauzl));
    const zip = await openZip(buffer, { lazyEntries: true });
    const entries = [];
    let total = 0;
    return await new Promise((resolve, reject) => {
        zip.on('error', reject);
        zip.on('end', () => resolve(entries));
        zip.on('entry', entry => {
            try {
                const name = safeRelative(entry.fileName);
                if (/\/$/.test(name)) return zip.readEntry();
                if (entries.length >= 500) throw new Error('Skill archive contains too many files.');
                zip.openReadStream(entry, (error, stream) => {
                    if (error) return reject(error);
                    const chunks = [];
                    let size = 0;
                    stream.on('data', chunk => {
                        size += chunk.length;
                        total += chunk.length;
                        if (size > 10 * 1024 * 1024 || total > 50 * 1024 * 1024) stream.destroy(new Error('Skill archive exceeds extraction limits.'));
                        else chunks.push(chunk);
                    });
                    stream.on('error', reject);
                    stream.on('end', () => {
                        entries.push({ name, data: Buffer.concat(chunks) });
                        zip.readEntry();
                    });
                });
            } catch (error) {
                reject(error);
            }
        });
        zip.readEntry();
    });
}

function findSkillRoot(entries, requestedSubdir = '') {
    const normalizedSubdir = requestedSubdir ? safeRelative(requestedSubdir).replace(/\/$/, '') : '';
    const candidates = entries.filter(entry => entry.name.endsWith('/SKILL.md') || entry.name === 'SKILL.md');
    const selected = normalizedSubdir
        ? candidates.find(entry => entry.name.includes(`/${normalizedSubdir}/SKILL.md`) || entry.name === `${normalizedSubdir}/SKILL.md`)
        : candidates.sort((a, b) => a.name.split('/').length - b.name.split('/').length)[0];
    if (!selected) throw new Error('Archive does not contain SKILL.md in the requested location.');
    return selected.name.slice(0, -'SKILL.md'.length).replace(/\/$/, '');
}

function skillDisplayName(skillText, fallback) {
    const frontmatter = skillText.match(/^---\s*\n([\s\S]*?)\n---/);
    const name = frontmatter?.[1]?.match(/^name:\s*(.+)$/m)?.[1]?.trim();
    return (name || fallback || 'Skill').slice(0, 120);
}

function skillCodeHash(skillRoot) {
    const entries = [];
    const scriptsRoot = path.join(skillRoot, 'scripts');
    const walk = (directory, prefix = '') => {
        if (!fs.existsSync(directory)) return;
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            const relative = path.posix.join(prefix, entry.name);
            const target = path.join(directory, entry.name);
            if (entry.isSymbolicLink()) continue;
            if (entry.isDirectory()) walk(target, relative);
            else if (entry.isFile() && SCRIPT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
                entries.push([relative, sha256(fs.readFileSync(target))]);
            }
        }
    };
    walk(scriptsRoot);
    return sha256(entries.sort(([left], [right]) => left.localeCompare(right)));
}

export async function installSkillZip(directories, buffer, { name, subdir = '', source = 'upload' } = {}) {
    const entries = await unzipEntries(buffer);
    const root = findSkillRoot(entries, subdir);
    const id = newId('skill');
    const targetRoot = safeItemPath(directories, 'skills', id);
    fs.mkdirSync(targetRoot, { recursive: true });
    const selected = entries.filter(entry => root ? entry.name.startsWith(`${root}/`) : true);
    for (const entry of selected) {
        const relative = safeRelative(root ? entry.name.slice(root.length + 1) : entry.name);
        const target = path.resolve(targetRoot, relative);
        if (!target.startsWith(`${path.resolve(targetRoot)}${path.sep}`)) throw new Error('Archive path escaped skill root.');
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, entry.data);
    }
    const skillText = fs.readFileSync(path.join(targetRoot, 'SKILL.md'), 'utf8');
    const metadata = { id, name: skillDisplayName(skillText, name), source, trusted: false, installedAt: Date.now(), hash: sha256(skillText), codeHash: skillCodeHash(targetRoot) };
    updateConfig(directories, config => config.skills.push(metadata));
    return metadata;
}

export async function installSkillGithub(directories, { url, ref = 'main', subdir = '' }) {
    const parsed = validateUrl(url, { httpsOnly: true });
    if (parsed.hostname.toLowerCase() !== 'github.com') throw new Error('Only github.com Skill repositories are supported.');
    const [owner, repoWithGit] = parsed.pathname.split('/').filter(Boolean);
    if (!owner || !repoWithGit) throw new Error('Invalid GitHub repository URL.');
    const repo = repoWithGit.replace(/\.git$/, '');
    if (!/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(repo) || !/^[\w./-]+$/.test(ref)) throw new Error('Invalid GitHub repository parameters.');
    const archive = `https://codeload.github.com/${owner}/${repo}/zip/${encodeURIComponent(ref)}`;
    const response = await fetchWithTimeout(archive, {}, 60000);
    if (!response.ok) throw new Error(`GitHub download failed (${response.status}).`);
    const buffer = await readResponseLimited(response, 50 * 1024 * 1024);
    const installed = await installSkillZip(directories, buffer, { name: repo, subdir, source: `${url}#${ref}${subdir ? `:${subdir}` : ''}` });
    return updateConfig(directories, config => {
        const skill = config.skills.find(item => item.id === installed.id);
        skill.github = { url: parsed.toString(), ref, subdir };
    }).skills.find(item => item.id === installed.id);
}

export async function updateSkillGithub(directories, id, input = {}) {
    const config = readConfig(directories);
    const existing = config.skills.find(item => item.id === id);
    if (!existing) throw new Error('Skill not found.');
    const github = { ...(existing.github || {}), ...input };
    if (!github.url) throw new Error('This Skill has no GitHub update source.');
    const wasSelected = config.modes[3].skillIds.includes(id);
    const installed = await installSkillGithub(directories, github);
    // Updating third-party code deliberately resets trust to read-only.
    deleteSkill(directories, id);
    return updateConfig(directories, next => {
        if (wasSelected && !next.modes[3].skillIds.includes(installed.id)) next.modes[3].skillIds.push(installed.id);
    }).skills.find(item => item.id === installed.id);
}

export function scanSkills(directories) {
    const skillsRoot = path.join(ensureDataLayout(directories), 'skills');
    const config = readConfig(directories);
    const knownById = new Map(config.skills.map(item => [item.id, item]));
    const found = [];
    for (const entry of fs.readdirSync(skillsRoot, { withFileTypes: true })) {
        if (!entry.isDirectory() || !/^[a-zA-Z0-9_-]+$/.test(entry.name)) continue;
        const skillFile = path.join(skillsRoot, entry.name, 'SKILL.md');
        if (!fs.existsSync(skillFile)) continue;
        const text = fs.readFileSync(skillFile, 'utf8');
        const known = knownById.get(entry.name);
        const codeHash = skillCodeHash(path.join(skillsRoot, entry.name));
        found.push({ ...(known || {}), id: entry.name, name: skillDisplayName(text, entry.name), source: known?.source || 'local', trusted: Boolean(known?.trusted && known.codeHash === codeHash), hash: sha256(text), codeHash, installedAt: known?.installedAt || Date.now() });
    }
    updateConfig(directories, current => { current.skills = found; });
    return found;
}

/**
 * Discover installer-supplied Skills once for each SillyTavern user. The
 * marker is persisted so a later user deselection is respected instead of
 * silently selecting the Skill again on every settings-page load.
 */
export function initializeBundledResources(directories) {
    const rootKey = path.resolve(ensureDataLayout(directories));
    let config = readConfig(directories);
    if (!config.resourceDiscovery?.bundledSkillSeeded) {
        seedBundledAnimaSkill(directories);
        config = updateConfig(directories, current => {
            current.resourceDiscovery = { ...(current.resourceDiscovery || {}), bundledSkillSeeded: true };
        });
    }
    let found = config.skills;
    if (!runtimeScannedRoots.has(rootKey)) {
        found = scanSkills(directories);
        runtimeScannedRoots.add(rootKey);
        config = readConfig(directories);
    }
    if (config.resourceDiscovery?.initialized) return config;
    return updateConfig(directories, current => {
        const anima = found.find(skill => skill.id === 'anima-prompt' || skill.name.toLowerCase() === 'anima-prompt');
        if (anima && !current.modes[3].skillIds.includes(anima.id)) current.modes[3].skillIds.push(anima.id);
        current.resourceDiscovery = { ...(current.resourceDiscovery || {}), initialized: true };
    });
}

export function setSkillTrust(directories, id, trusted) {
    return updateConfig(directories, config => {
        const skill = config.skills.find(item => item.id === id);
        if (!skill) throw new Error('Skill not found.');
        skill.trusted = Boolean(trusted);
    }).skills.find(item => item.id === id);
}

export function deleteSkill(directories, id) {
    const root = safeItemPath(directories, 'skills', id);
    if (fs.existsSync(root)) fs.rmSync(root, { recursive: true });
    return updateConfig(directories, config => {
        config.skills = config.skills.filter(item => item.id !== id);
        config.modes[3].skillIds = config.modes[3].skillIds.filter(item => item !== id);
    });
}

export function skillCatalogue(directories, ids = []) {
    const config = readConfig(directories);
    return config.skills.filter(skill => !ids.length || ids.includes(skill.id)).map(skill => {
        const root = safeItemPath(directories, 'skills', skill.id);
        const references = [];
        const scripts = [];
        const walk = (dir, prefix = '') => {
            if (!fs.existsSync(dir)) return;
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                const relative = path.posix.join(prefix, entry.name);
                if (entry.isDirectory()) walk(path.join(dir, entry.name), relative);
                else if (relative.startsWith('references/') && REFERENCE_EXTENSIONS.has(path.extname(relative).toLowerCase())) references.push(relative);
                else if (relative.startsWith('scripts/') && SCRIPT_EXTENSIONS.has(path.extname(relative).toLowerCase())) scripts.push(relative);
            }
        };
        walk(root);
        return { ...skill, references, scripts, skillPreview: fs.readFileSync(path.join(root, 'SKILL.md'), 'utf8').slice(0, 2000) };
    });
}

export function readSkillFile(directories, skillId, relative = 'SKILL.md', maxChars = 12000) {
    const config = readConfig(directories);
    if (!config.skills.some(item => item.id === skillId)) throw new Error('Skill not found.');
    const root = safeItemPath(directories, 'skills', skillId);
    const normalized = safeRelative(relative);
    if (normalized !== 'SKILL.md' && !normalized.startsWith('references/')) throw new Error('Only SKILL.md and files under references/ may be read.');
    const target = path.resolve(root, normalized);
    if (target !== path.join(root, 'SKILL.md') && !target.startsWith(`${path.resolve(root)}${path.sep}`)) throw new Error('Skill file path escaped its root.');
    const extension = path.extname(target).toLowerCase();
    if (path.basename(target) !== 'SKILL.md' && !REFERENCE_EXTENSIONS.has(extension)) throw new Error('Only SKILL.md and text references may be read.');
    const realRoot = fs.realpathSync(root);
    const realTarget = fs.realpathSync(target);
    if (realTarget !== path.join(realRoot, 'SKILL.md') && !realTarget.startsWith(`${path.join(realRoot, 'references')}${path.sep}`)) throw new Error('Skill reference symlink escaped its root.');
    return fs.readFileSync(realTarget, 'utf8').slice(0, Math.max(256, maxChars));
}

export async function runSkillScript(directories, skillId, relative, args, { timeoutSeconds = 60, maxOutputChars = 20000 } = {}) {
    const config = readConfig(directories);
    const skill = config.skills.find(item => item.id === skillId);
    if (!skill) throw new Error('Skill not found.');
    if (!skill.trusted) throw new Error('Skill is not trusted for script execution.');
    const root = safeItemPath(directories, 'skills', skillId);
    const normalized = safeRelative(relative);
    if (!normalized.startsWith('scripts/')) throw new Error('Only files under scripts/ may execute.');
    const script = path.resolve(root, normalized);
    if (!script.startsWith(`${path.resolve(root)}${path.sep}`) || !fs.existsSync(script)) throw new Error('Skill script not found.');
    const realScriptsRoot = fs.realpathSync(path.join(root, 'scripts'));
    const realScript = fs.realpathSync(script);
    if (!realScript.startsWith(`${realScriptsRoot}${path.sep}`)) throw new Error('Skill script symlink escaped scripts/.');
    const extension = path.extname(realScript).toLowerCase();
    let command;
    let commandArgs;
    if (extension === '.py') {
        command = 'uv';
        commandArgs = ['run', realScript, ...(Array.isArray(args) ? args.map(String) : [])];
    } else if (['.js', '.mjs', '.cjs'].includes(extension)) {
        command = process.execPath;
        commandArgs = [realScript, ...(Array.isArray(args) ? args.map(String) : [])];
    } else {
        throw new Error('Only Python and Node scripts are supported.');
    }
    if (activeScripts >= 2) throw new Error('Trusted Skill script concurrency limit reached.');
    activeScripts++;
    try {
        return await new Promise((resolve, reject) => {
        const child = spawn(command, commandArgs, { cwd: root, shell: false, env: { PATH: process.env.PATH || '', LANG: process.env.LANG || 'C.UTF-8', PYTHONIOENCODING: 'utf-8' }, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        const cap = Math.max(1000, Number(maxOutputChars) || 20000);
        child.stdout.on('data', data => { stdout = (stdout + data.toString()).slice(-cap); });
        child.stderr.on('data', data => { stderr = (stderr + data.toString()).slice(-cap); });
        let timedOut = false;
        const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, Math.max(1, Number(timeoutSeconds) || 60) * 1000);
        child.on('error', error => { clearTimeout(timer); reject(error); });
        child.on('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, timedOut, stdout, stderr }); });
        });
    } finally {
        activeScripts--;
    }
}

function referenceSummary(content) {
    return String(content).replace(/^---[\s\S]*?---\s*/m, '').replace(/[#>*_`]/g, '').replace(/\s+/g, ' ').trim().slice(0, 500);
}

function referenceSections(content) {
    const text = String(content);
    const sections = [];
    const headings = [...text.matchAll(/^#{1,6}\s+(.+)$/gm)];
    const boundaries = headings.length ? headings.map(match => ({ start: match.index, title: match[1].trim() })) : [{ start: 0, title: 'Document' }];
    if (boundaries[0]?.start > 0) boundaries.unshift({ start: 0, title: 'Preamble' });
    for (let index = 0; index < boundaries.length; index++) {
        const start = boundaries[index].start;
        const end = boundaries[index + 1]?.start ?? text.length;
        for (let cursor = start; cursor < end; cursor += 4000) {
            const chunkEnd = Math.min(end, cursor + 4000);
            const chunk = text.slice(cursor, chunkEnd);
            sections.push({ index: sections.length, title: boundaries[index].title, start: cursor, end: chunkEnd, summary: referenceSummary(chunk).slice(0, 240) });
            if (sections.length >= 2500) return sections;
        }
    }
    return sections;
}

export function createReference(directories, { title, content, source = 'inline', url = '' }) {
    const text = String(content || '');
    if (!text.trim()) throw new Error('Reference content is empty.');
    if (Buffer.byteLength(text) > 10 * 1024 * 1024) throw new Error('Reference exceeds 10 MB.');
    const id = newId('ref');
    fs.writeFileSync(safeItemPath(directories, 'references', id, '.md'), text, 'utf8');
    const metadata = { id, title: String(title || 'Reference').slice(0, 160), source, url, summary: referenceSummary(text), sections: referenceSections(text), hash: sha256(text), updatedAt: Date.now() };
    updateConfig(directories, config => config.references.push(metadata));
    return metadata;
}

export async function createUrlReference(directories, { title, url }) {
    const parsed = validateUrl(url, { httpsOnly: true });
    const response = await fetchWithTimeout(parsed, {}, 30000);
    if (!response.ok) throw new Error(`Reference download failed (${response.status}).`);
    const contentType = response.headers.get('content-type') || '';
    if (contentType && !/text|json|yaml|octet-stream/i.test(contentType)) throw new Error('Reference URL did not return a supported text type.');
    const buffer = await readResponseLimited(response, 10 * 1024 * 1024);
    return createReference(directories, { title: title || path.basename(parsed.pathname), content: buffer.toString('utf8'), source: 'url', url: parsed.toString() });
}

export function readReference(directories, id, maxChars = 12000, section = null) {
    const metadata = readConfig(directories).references.find(item => item.id === id);
    if (!metadata) throw new Error('Reference not found.');
    const text = fs.readFileSync(safeItemPath(directories, 'references', id, '.md'), 'utf8');
    const selected = Number.isInteger(Number(section)) ? metadata.sections?.[Number(section)] : null;
    const start = selected?.start || 0;
    const end = selected?.end || text.length;
    return { metadata, section: selected || null, content: text.slice(start, Math.min(end, start + Math.max(256, maxChars))) };
}

export function searchReferences(directories, ids, query, limit = 8) {
    const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
    return readConfig(directories).references
        .filter(item => !ids?.length || ids.includes(item.id))
        .flatMap(item => {
            const content = fs.readFileSync(safeItemPath(directories, 'references', item.id, '.md'), 'utf8');
            return (item.sections?.length ? item.sections : [{ index: 0, title: item.title, summary: item.summary, start: 0, end: content.length }]).map(section => ({
                item: { id: item.id, title: item.title, source: item.source, section: section.index, sectionTitle: section.title, summary: section.summary },
                score: words.reduce((sum, word) => sum + (`${item.title} ${section.title} ${content.slice(section.start || 0, section.end || content.length)}`.toLowerCase().includes(word) ? 1 : 0), 0),
            }));
        })
        .filter(result => !words.length || result.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, Math.max(1, Math.min(20, limit)))
        .map(result => result.item);
}

export function updateReference(directories, id, { title, content }) {
    const config = readConfig(directories);
    const current = config.references.find(item => item.id === id);
    if (!current) throw new Error('Reference not found.');
    const text = content === undefined ? fs.readFileSync(safeItemPath(directories, 'references', id, '.md'), 'utf8') : String(content);
    if (!text.trim()) throw new Error('Reference content is empty.');
    if (Buffer.byteLength(text) > 10 * 1024 * 1024) throw new Error('Reference exceeds 10 MB.');
    fs.writeFileSync(safeItemPath(directories, 'references', id, '.md'), text, 'utf8');
    return updateConfig(directories, next => {
        const item = next.references.find(value => value.id === id);
        item.title = String(title ?? item.title).slice(0, 160);
        item.summary = referenceSummary(text);
        item.sections = referenceSections(text);
        item.hash = sha256(text);
        item.updatedAt = Date.now();
    }).references.find(item => item.id === id);
}

export function deleteReference(directories, id) {
    const file = safeItemPath(directories, 'references', id, '.md');
    if (fs.existsSync(file)) fs.unlinkSync(file);
    return updateConfig(directories, config => {
        config.references = config.references.filter(item => item.id !== id);
        config.modes[3].referenceIds = config.modes[3].referenceIds.filter(item => item !== id);
    });
}
