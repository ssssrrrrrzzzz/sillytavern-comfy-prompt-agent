import {
    chat,
    characters,
    eventSource,
    event_types,
    getCurrentChatId,
    getRequestHeaders,
    saveChatConditional,
    saveSettingsDebounced,
    showSwipeButtons,
    this_chid,
    updateMessageBlock,
} from '../../../../script.js';
import { getContext } from '../../../st-context.js';
import { extension_settings } from '../../../extensions.js';
import { copyText } from '../../../utils.js';
import { BrowserRuntime } from './browser-runtime.js';
import { fnv1a, modeRequiresImageTag, parseImageTags } from './shared/tag-parser.js';
import { PLUGIN_VERSION } from './shared/version.js';

const API = '/api/plugins/comfy-prompt-agent';
const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
let config = null;
let workflowDetail = null;
let editingReferenceId = '';
let objectInfoAvailable = false;
const pollers = new Map();
const galleryFallbackTimers = new Map();
const promptHideTimers = new WeakMap();
let swipeRefreshFrame = 0;
let browserRuntime = null;
const PROMPT_MEDIA_SELECTOR = '.mes_media_wrapper img, .mes_media_wrapper video, .cpa-inline-gallery img, .cpa-inline-gallery video';

const $id = id => document.getElementById(id);
const val = id => $id(id)?.value ?? '';
const checked = id => Boolean($id(id)?.checked);
const number = (id, fallback = 0) => val(id) === '' || !Number.isFinite(Number(val(id))) ? fallback : Number(val(id));
const escapeHtml = value => String(value ?? '').replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
const notify = (type, message) => globalThis.toastr?.[type]?.(message, 'Comfy Prompt Agent') ?? console[type === 'error' ? 'error' : 'log'](message);

function extensionFolderName() {
    const parts = decodeURIComponent(new URL(import.meta.url).pathname).split('/').filter(Boolean);
    const thirdParty = parts.lastIndexOf('third-party');
    return thirdParty >= 0 && parts[thirdParty + 1] ? parts[thirdParty + 1] : 'Comfy-Prompt-Agent';
}

function bootstrapCommand() {
    return `node data/default-user/extensions/${extensionFolderName()}/install.mjs`;
}

function showBootstrapHelp() {
    const root = $id('cpa-bootstrap-help');
    if (!root) return;
    root.hidden = false;
    const title = $id('cpa-runtime-help-title');
    const description = $id('cpa-runtime-help-description');
    const commandWrap = $id('cpa-bootstrap-command-wrap');
    if (browserRuntime) {
        if (title) title.textContent = 'Git 免重启兼容模式';
        if (description) description.textContent = '插件正在使用 SillyTavern 自带的 ComfyUI 与 OpenAI-compatible 代理；配置保存在酒馆扩展设置中。内置 Skill 和 References 可供 Agent 读取，但浏览器不会执行 Python/Node Skill 脚本。';
        if (commandWrap) commandWrap.hidden = true;
        return;
    }
    if (title) title.textContent = '可选增强服务端尚未加载';
    if (description) description.textContent = '插件可继续使用免重启模式。只有需要后台跨聊天任务、SecretManager 或执行已信任 Skill 脚本时，才需要安装可选增强服务端。';
    if (commandWrap) commandWrap.hidden = false;
    const command = $id('cpa-bootstrap-command');
    if (command) command.textContent = bootstrapCommand();
}

function hideBootstrapHelp() {
    const root = $id('cpa-bootstrap-help');
    if (root) root.hidden = true;
}

function applyRuntimeCapabilities(browserMode) {
    for (const controlId of ['cpa-skill-file', 'cpa-skill-url', 'cpa-skill-ref', 'cpa-skill-subdir', 'cpa-skill-upload', 'cpa-skill-github', 'cpa-skill-scan']) {
        const control = $id(controlId);
        if (!control) continue;
        control.disabled = browserMode;
        control.title = browserMode ? '免重启模式已自带 Anima Skill；第三方 Skill 安装和脚本执行需要可选增强服务端。' : '';
    }
    for (const controlId of ['cpa-mode3-tool-timeout', 'cpa-mode3-tool-output']) {
        const control = $id(controlId);
        if (!control) continue;
        control.disabled = browserMode;
        control.title = browserMode ? '免重启模式不执行本机 Skill 脚本；该限制仅供可选增强服务端使用。' : '';
    }
    const warning = $id('cpa-skill-warning');
    if (warning) warning.textContent = browserMode
        ? '免重启模式已内置并自动选择 Anima Skill 及其 References；可读取文本，但不会执行本机脚本。第三方 Skill 管理属于可选增强服务端功能。'
        : '第三方脚本被信任后，将拥有 SillyTavern 进程用户本身的系统权限。只信任你已审查的代码；未信任 Skill 只能读取文本。';
}

async function serverApi(path, options = {}) {
    const isForm = options.body instanceof FormData;
    const response = await fetch(`${API}${path}`, {
        ...options,
        headers: { ...getRequestHeaders({ omitContentType: isForm }), ...(options.headers || {}) },
        body: isForm || typeof options.body === 'string' || options.body === undefined ? options.body : JSON.stringify(options.body),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
    return body;
}

async function ensureBrowserRuntime() {
    if (browserRuntime) return browserRuntime;
    const key = 'comfy_prompt_agent_browser';
    extension_settings[key] ||= {};
    browserRuntime = new BrowserRuntime({
        storage: extension_settings[key],
        save: saveSettingsDebounced,
        headers: () => getRequestHeaders(),
        assetUrl: relative => new URL(`./${relative}`, import.meta.url).href,
    });
    await browserRuntime.ready();
    return browserRuntime;
}

async function api(path, options = {}) {
    if (browserRuntime) return await browserRuntime.handle(path, options);
    try {
        return await serverApi(path, options);
    } catch (error) {
        // A freshly Git-installed extension has no custom server route yet.
        // Fall back to SillyTavern's built-in ComfyUI/OpenAI proxy APIs so the
        // extension works immediately after the normal automatic page reload.
        if (path !== '/health') throw error;
        const runtime = await ensureBrowserRuntime();
        return await runtime.handle(path, options);
    }
}

function setOptions(select, items, selected, emptyLabel = '— 未选择 —') {
    if (!select) return;
    select.replaceChildren();
    if (emptyLabel) select.add(new Option(emptyLabel, ''));
    for (const item of items) select.add(new Option(item.name, item.id));
    select.value = selected || '';
}

function modeFieldsHtml(mode) {
    return `
        <label>LLM Profile<select id="cpa-mode${mode}-profile"></select></label>
        <label>最近聊天轮数<input id="cpa-mode${mode}-turns" type="number" min="0" max="100"></label>
        <label>参考最近图片 Prompt 数<input id="cpa-mode${mode}-prompt-history" type="number" min="0" max="20"></label>
        <label>最大输入 token<input id="cpa-mode${mode}-input" type="number" min="256"></label>
        <label>最大输出 token<input id="cpa-mode${mode}-output" type="number" min="16"></label>
        <label>LLM 请求超时（秒）<input id="cpa-mode${mode}-timeout" type="number" min="1" max="3600"></label>
        <label><input id="cpa-mode${mode}-character" type="checkbox"> 加入角色卡</label>
        <label><input id="cpa-mode${mode}-persona" type="checkbox"> 加入 Persona</label>
        <label><input id="cpa-mode${mode}-system" type="checkbox"> 加入系统提示</label>
        <label><input id="cpa-mode${mode}-world" type="checkbox"> 加入所选世界书</label>
        <label class="cpa-wide">世界书（可多选）<select id="cpa-mode${mode}-worldbooks" multiple size="4"></select></label>`;
}

function putMode(mode, data) {
    setOptions($id(`cpa-mode${mode}-profile`), config.llmProfiles, data.profileId);
    $id(`cpa-mode${mode}-turns`).value = data.historyTurns;
    $id(`cpa-mode${mode}-prompt-history`).value = data.promptHistoryCount ?? 4;
    $id(`cpa-mode${mode}-input`).value = data.maxInputTokens;
    $id(`cpa-mode${mode}-output`).value = data.maxOutputTokens;
    $id(`cpa-mode${mode}-timeout`).value = data.timeoutSeconds;
    $id(`cpa-mode${mode}-character`).checked = data.includeCharacterCard;
    $id(`cpa-mode${mode}-persona`).checked = data.includePersona;
    $id(`cpa-mode${mode}-system`).checked = data.includeSystemPrompt;
    $id(`cpa-mode${mode}-world`).checked = data.includeWorldBook;
    const worldSelect = $id(`cpa-mode${mode}-worldbooks`);
    const worlds = getContext().getWorldInfoNames?.() || [];
    worldSelect.replaceChildren(...worlds.map(name => new Option(name, name, false, data.worldBooks?.includes(name))));
    const referenceWorld = $id('cpa-reference-worldbook');
    if (referenceWorld && !referenceWorld.options.length) referenceWorld.replaceChildren(new Option('— 未选择 —', ''), ...worlds.map(name => new Option(name, name)));
}

function readMode(mode) {
    const worldSelect = $id(`cpa-mode${mode}-worldbooks`);
    return {
        profileId: val(`cpa-mode${mode}-profile`),
        historyTurns: number(`cpa-mode${mode}-turns`),
        promptHistoryCount: number(`cpa-mode${mode}-prompt-history`),
        maxInputTokens: number(`cpa-mode${mode}-input`),
        maxOutputTokens: number(`cpa-mode${mode}-output`),
        timeoutSeconds: number(`cpa-mode${mode}-timeout`),
        includeCharacterCard: checked(`cpa-mode${mode}-character`),
        includePersona: checked(`cpa-mode${mode}-persona`),
        includeSystemPrompt: checked(`cpa-mode${mode}-system`),
        includeWorldBook: checked(`cpa-mode${mode}-world`),
        worldBooks: [...worldSelect.selectedOptions].map(option => option.value),
    };
}

async function loadConfig() {
    let health = await api('/health');
    if (String(health.version) !== PLUGIN_VERSION && health.hotReload) {
        if (String(health.installedVersion) === PLUGIN_VERSION) {
            await api('/reload', { method: 'POST', body: {} });
        } else {
            await api('/stage-update', { method: 'POST', body: { extensionName: extensionFolderName() } });
        }
        health = await api('/health');
    }
    if (String(health.version) !== PLUGIN_VERSION) {
        throw new Error(`前后端版本不一致：前端 ${PLUGIN_VERSION}，运行中的后端 ${health.version ?? '未知'}。请完整停止并重新启动 SillyTavern。`);
    }
    config = await api('/config');
    if (health.browserRuntime) showBootstrapHelp();
    else hideBootstrapHelp();
    applyRuntimeCapabilities(Boolean(health.browserRuntime));
    $id('cpa-server-state').textContent = health.browserRuntime ? `免重启模式 · ${PLUGIN_VERSION}` : `增强服务端 · ${PLUGIN_VERSION}`;
    $id('cpa-server-state').className = 'cpa-pill ok';
    $id('cpa-enabled').checked = config.enabled;
    $id('cpa-mode').value = config.mode;
    $id('cpa-comfy-url').value = config.comfy.url;
    $id('cpa-comfy-auth').value = config.comfy.authType;
    $id('cpa-comfy-secret').placeholder = config.comfy.hasAuthSecret ? '已保存；留空保持原值' : '未保存';
    $id('cpa-concurrency').value = config.comfy.concurrency;
    $id('cpa-max-queue').value = config.comfy.maxQueue;
    $id('cpa-comfy-timeout').value = config.comfy.timeoutSeconds;
    putMode(2, config.modes[2]);
    putMode(3, config.modes[3]);
    $id('cpa-mode2-prompt').value = config.modes[2].promptTemplate;
    $id('cpa-mode3-prompt').value = config.modes[3].agentPrompt;
    $id('cpa-mode3-steps').value = config.modes[3].maxSteps;
    $id('cpa-mode3-total-timeout').value = config.modes[3].totalTimeoutSeconds;
    $id('cpa-mode3-reference-chars').value = config.modes[3].referenceReadChars;
    $id('cpa-mode3-tool-timeout').value = config.modes[3].toolTimeoutSeconds;
    $id('cpa-mode3-tool-output').value = config.modes[3].toolOutputChars;
    $id('cpa-mode3-workflow').checked = config.modes[3].allowWorkflowSelection;
    $id('cpa-mode3-parameters').checked = config.modes[3].allowParameterChanges;
    renderProfileOptions();
    renderWorkflowOptions();
    renderSkills();
    renderReferences();
    await Promise.allSettled([loadWorkflowDetail(), loadSillyTavernWorkflows(), refreshJobs()]);
    renderQuickPanel();
}

export async function hotUpdateExtension() {
    try {
        const health = await api('/health');
        if (health.browserRuntime) {
            notify('success', `前端已更新到 ${PLUGIN_VERSION}，正在刷新`);
            setTimeout(() => location.reload(), 300);
            return;
        }
        const result = await api('/stage-update', { method: 'POST', body: { extensionName: extensionFolderName() } });
        notify('success', `服务端已热更新到 ${result.version}`);
        setTimeout(() => location.reload(), 300);
    } catch (error) {
        notify('warning', `服务端热更新不可用；首次安装或旧版引导器需要完整重启：${error.message}`);
    }
}

export async function installExtension() {
    try {
        const health = await api('/health');
        notify('success', health.browserRuntime ? '插件安装完成，免重启模式已就绪，正在刷新' : '插件安装完成，增强服务端已连接，正在刷新');
        setTimeout(() => location.reload(), 350);
    } catch (error) {
        notify('error', `插件初始化失败：${error.message}`);
    }
}

async function saveConfig() {
    const mode3 = {
        ...readMode(3),
        agentPrompt: val('cpa-mode3-prompt'),
        maxSteps: number('cpa-mode3-steps'),
        totalTimeoutSeconds: number('cpa-mode3-total-timeout'),
        referenceReadChars: number('cpa-mode3-reference-chars'),
        toolTimeoutSeconds: number('cpa-mode3-tool-timeout'),
        toolOutputChars: number('cpa-mode3-tool-output'),
        allowWorkflowSelection: checked('cpa-mode3-workflow'),
        allowParameterChanges: checked('cpa-mode3-parameters'),
        skillIds: [...document.querySelectorAll('.cpa-skill-select:checked')].map(input => input.dataset.id),
        referenceIds: [...document.querySelectorAll('.cpa-reference-select:checked')].map(input => input.dataset.id),
    };
    const body = {
        enabled: checked('cpa-enabled'), mode: number('cpa-mode', 1),
        selectedWorkflowId: val('cpa-workflow'), selectedPresetId: val('cpa-preset'),
        comfy: { url: val('cpa-comfy-url'), authType: val('cpa-comfy-auth'), concurrency: number('cpa-concurrency'), maxQueue: number('cpa-max-queue'), timeoutSeconds: number('cpa-comfy-timeout') },
        modes: { 2: { ...readMode(2), promptTemplate: val('cpa-mode2-prompt') }, 3: mode3 },
    };
    config = await api('/config', { method: 'PUT', body });
    if (val('cpa-comfy-secret')) {
        await api('/comfy/secret', { method: 'POST', body: { secret: val('cpa-comfy-secret') } });
        $id('cpa-comfy-secret').value = '';
    }
    notify('success', '配置已保存');
    await loadConfig();
}

async function saveModeSelection() {
    const previous = Number(config.mode);
    const mode = number('cpa-mode', previous);
    config.mode = mode;
    try {
        const result = await api('/config/mode', { method: 'PUT', body: { mode } });
        config.mode = Number(result.mode);
        notify('success', `已切换到模式 ${result.mode}`);
    } catch (error) {
        config.mode = previous;
        $id('cpa-mode').value = String(previous);
        throw error;
    }
}

function renderProfileOptions() {
    const previous = val('cpa-profile-list');
    setOptions($id('cpa-profile-list'), config.llmProfiles, previous || config.llmProfiles[0]?.id, '— 新 Profile —');
    editProfile();
}

function editProfile() {
    const profile = config?.llmProfiles?.find(item => item.id === val('cpa-profile-list'));
    $id('cpa-profile-name').value = profile?.name || '';
    $id('cpa-profile-url').value = profile?.baseUrl || '';
    $id('cpa-profile-key').value = '';
    $id('cpa-profile-key').placeholder = profile?.hasApiKey ? '已保存；留空保持原值' : '未保存';
    $id('cpa-profile-model').value = profile?.model || '';
    $id('cpa-profile-temperature').value = profile?.temperature ?? 0.4;
    $id('cpa-profile-top-p').value = profile?.topP ?? 1;
    $id('cpa-profile-max-output').value = profile?.maxOutputTokens ?? 1024;
    $id('cpa-profile-timeout').value = profile?.timeoutSeconds ?? 120;
    $id('cpa-profile-extra').value = JSON.stringify(profile?.extraJson || {}, null, 2);
}

function profileDraft() {
    let extraJson;
    try { extraJson = JSON.parse(val('cpa-profile-extra') || '{}'); } catch { throw new Error('附加请求 JSON 格式不正确。'); }
    return {
        id: val('cpa-profile-list') || undefined,
        name: val('cpa-profile-name'),
        baseUrl: val('cpa-profile-url'),
        apiKey: val('cpa-profile-key'),
        model: val('cpa-profile-model'),
        temperature: number('cpa-profile-temperature'),
        topP: number('cpa-profile-top-p', 1),
        maxOutputTokens: number('cpa-profile-max-output'),
        timeoutSeconds: number('cpa-profile-timeout'),
        extraJson,
    };
}

async function saveProfile() {
    const saved = await api('/llm-profiles', { method: 'POST', body: profileDraft() });
    notify('success', 'LLM Profile 已保存');
    await loadConfig();
    $id('cpa-profile-list').value = saved.id;
    editProfile();
}

async function refreshModels() {
    const result = await api('/llm-profiles/test', { method: 'POST', body: profileDraft() });
    $id('cpa-model-list').replaceChildren(...result.models.map(model => new Option(model, model)));
    notify('success', `连接成功，读取到 ${result.models.length} 个模型`);
}

function comfyDraft() {
    return {
        url: val('cpa-comfy-url'),
        authType: val('cpa-comfy-auth'),
        secret: val('cpa-comfy-secret'),
        concurrency: number('cpa-concurrency'),
        maxQueue: number('cpa-max-queue'),
        timeoutSeconds: number('cpa-comfy-timeout'),
    };
}

async function persistComfyDraft() {
    config = await api('/config/comfy', { method: 'PUT', body: comfyDraft() });
    $id('cpa-comfy-secret').value = '';
    $id('cpa-comfy-secret').placeholder = config.comfy.hasAuthSecret ? '已保存；留空保持原值' : '未保存';
}

async function testComfyDraft() {
    await persistComfyDraft();
    await api('/comfy/test', { method: 'POST', body: {} });
    notify('success', '当前 ComfyUI 配置已保存，连接成功');
}

async function refreshObjectInfo() {
    await persistComfyDraft();
    await loadWorkflowDetail();
    notify('success', objectInfoAvailable ? '当前连接已保存，节点与模型列表已刷新' : '已读取工作流原始参数');
}

function renderWorkflowOptions() {
    setOptions($id('cpa-workflow'), config.workflows, config.selectedWorkflowId);
    updatePresetOptions();
}

function downloadBundledWorkflow(fileName) {
    const allowed = new Set(['Anima-API.json', 'Anima-ComfyUI.json']);
    if (!allowed.has(fileName)) throw new Error('未知的内置工作流。');
    const link = document.createElement('a');
    link.href = new URL(`./server-plugin/bundled/workflows/${fileName}`, import.meta.url).href;
    link.download = fileName;
    document.body.append(link);
    link.click();
    link.remove();
}

function updatePresetOptions() {
    const workflow = config.workflows.find(item => item.id === val('cpa-workflow'));
    setOptions($id('cpa-preset'), workflow?.presets || [], workflow?.id === config.selectedWorkflowId ? config.selectedPresetId : workflow?.presets?.[0]?.id, null);
}

function inputControl(input, presetValue) {
    const normalizedType = String(input.type || '').toUpperCase();
    const control = input.options
        ? document.createElement('select')
        : document.createElement(normalizedType === 'STRING' && input.metadata?.multiline ? 'textarea' : 'input');
    control.className = 'cpa-node-value';
    control.dataset.node = input.nodeId;
    control.dataset.input = input.inputName;
    control.dataset.type = input.type;
    if (input.options) for (const option of input.options) control.add(new Option(String(option), JSON.stringify(option)));
    if (normalizedType === 'BOOLEAN') {
        control.type = 'checkbox';
        control.checked = Boolean(presetValue);
    } else if (['INT', 'FLOAT', 'NUMBER'].includes(normalizedType)) {
        control.type = 'number';
        if (input.metadata?.min !== undefined) control.min = input.metadata.min;
        if (input.metadata?.max !== undefined) control.max = input.metadata.max;
        control.step = input.metadata?.step ?? (normalizedType === 'INT' ? 1 : 'any');
        control.value = presetValue;
    } else if (input.options) {
        control.value = JSON.stringify(presetValue);
    } else {
        // HTMLTextAreaElement exposes a read-only `type` getter in browsers.
        // Only text inputs need their type assigned; multiline controls are
        // already created as <textarea> above.
        if (control.tagName === 'INPUT') control.type = 'text';
        control.value = typeof presetValue === 'object' ? JSON.stringify(presetValue) : String(presetValue ?? '');
    }
    return control;
}

function readNodeControl(control) {
    const type = String(control.dataset.type || '').toUpperCase();
    if (type === 'BOOLEAN') return control.checked;
    if (type === 'INT') return Math.trunc(Number(control.value));
    if (['FLOAT', 'NUMBER'].includes(type)) return Number(control.value);
    if (control.tagName === 'SELECT' || type === 'OBJECT') return JSON.parse(control.value);
    return control.value;
}

function targetHas(targets, input) {
    return Boolean(targets?.some(target => String(target.nodeId) === String(input.nodeId) && target.inputName === input.inputName));
}

function renderWorkflowNodes() {
    const root = $id('cpa-workflow-nodes');
    root.replaceChildren();
    if (!workflowDetail) return;
    const preset = workflowDetail.metadata.presets.find(item => item.id === val('cpa-preset')) || workflowDetail.metadata.presets[0];
    $id('cpa-preset-name').value = preset?.name || 'Default';
    $id('cpa-randomize-seed').checked = preset?.randomizeSeed !== false;
    $id('cpa-artist').value = preset?.artistPrompt || '';
    $id('cpa-negative').value = preset?.negativePrompt || '';
    const heading = document.createElement('div');
    heading.className = 'cpa-node-grid cpa-muted';
    heading.innerHTML = '<span>节点 / 参数</span><span>运行值</span><span>快捷显示</span><span>Agent 可控</span><span>提示词目标</span>';
    root.append(heading);
    for (const input of workflowDetail.inputs) {
        const row = document.createElement('div');
        row.className = 'cpa-node cpa-node-grid';
        const label = document.createElement('span');
        label.className = 'cpa-node-label';
        label.textContent = `${input.nodeId} · ${input.title} / ${input.inputName}`;
        const current = preset?.values?.[input.nodeId]?.[input.inputName] ?? input.value;
        const control = inputControl(input, current);
        const visible = document.createElement('input');
        visible.type = 'checkbox'; visible.className = 'cpa-node-visible'; visible.dataset.node = input.nodeId; visible.dataset.input = input.inputName;
        visible.checked = Boolean(preset?.visible?.[input.nodeId]?.includes?.(input.inputName));
        const agent = document.createElement('input');
        agent.type = 'checkbox'; agent.className = 'cpa-node-agent'; agent.dataset.node = input.nodeId; agent.dataset.input = input.inputName;
        agent.checked = Boolean(preset?.agentControllable?.[input.nodeId]?.includes?.(input.inputName));
        const targets = document.createElement('span');
        if (input.type === 'STRING' || input.type === 'string') {
            const pos = document.createElement('label');
            pos.innerHTML = '正 <input type="checkbox" class="cpa-positive-target">';
            const neg = document.createElement('label');
            neg.innerHTML = '负 <input type="checkbox" class="cpa-negative-target">';
            for (const element of [pos.lastElementChild, neg.lastElementChild]) { element.dataset.node = input.nodeId; element.dataset.input = input.inputName; }
            pos.lastElementChild.checked = targetHas(preset?.positiveTargets, input);
            neg.lastElementChild.checked = targetHas(preset?.negativeTargets, input);
            targets.append(pos, neg);
        }
        row.append(label, control, visible, agent, targets);
        root.append(row);
    }
    const output = document.createElement('div');
    output.className = 'cpa-node';
    output.innerHTML = '<strong>图片输出节点：</strong> ';
    for (const nodeId of workflowDetail.metadata.discovery.outputNodes || []) {
        const label = document.createElement('label');
        label.innerHTML = `<input type="checkbox" class="cpa-output-node" data-node="${escapeHtml(nodeId)}"> ${escapeHtml(nodeId)}`;
        label.firstElementChild.checked = preset?.outputNodeIds?.map(String).includes(String(nodeId));
        output.append(label, document.createTextNode(' '));
    }
    root.append(output);
}

function installQuickPanel() {
    if ($id('cpa-quick-button')) return;
    const button = document.createElement('div');
    button.id = 'cpa-quick-button';
    button.className = 'fa-solid fa-wand-magic-sparkles interactable';
    button.title = 'Comfy Prompt Agent 快捷面板';
    const settingsButton = document.createElement('div');
    settingsButton.id = 'cpa-settings-button';
    settingsButton.className = 'fa-solid fa-gears interactable';
    settingsButton.title = 'Comfy Prompt Agent 完整设置';
    const floatingActions = document.createElement('div');
    floatingActions.id = 'cpa-floating-actions';
    floatingActions.className = 'cpa-floating-actions';
    floatingActions.append(button, settingsButton);
    document.body.append(floatingActions);
    const panel = document.createElement('div');
    panel.id = 'cpa-quick-panel';
    panel.className = 'cpa-quick';
    panel.hidden = true;
    document.body.append(panel);
    button.addEventListener('click', toggleQuickPanel);
    settingsButton.addEventListener('click', openSettings);
}

function toggleQuickPanel() {
    const panel = $id('cpa-quick-panel');
    if (!panel) return;
    panel.hidden = !panel.hidden;
    if (!panel.hidden) renderQuickPanel();
}

function openSettings() {
    const shell = $id('cpa-settings-shell');
    if (!shell) return;
    shell.hidden = false;
    document.body.classList.add('cpa-settings-open');
}

function closeSettings() {
    const shell = $id('cpa-settings-shell');
    if (!shell) return;
    shell.hidden = true;
    document.body.classList.remove('cpa-settings-open');
}

function mountSettings(html) {
    if ($id('cpa-settings-shell')) return;
    const shell = document.createElement('div');
    shell.id = 'cpa-settings-shell';
    shell.className = 'cpa-settings-shell';
    shell.hidden = true;
    shell.setAttribute('role', 'dialog');
    shell.setAttribute('aria-modal', 'true');
    shell.setAttribute('aria-label', 'Comfy Prompt Agent 设置');
    shell.innerHTML = `<div class="cpa-settings-dialog">
        <div class="cpa-settings-toolbar"><strong>Comfy Prompt Agent · 完整设置</strong><button id="cpa-settings-close" class="menu_button" type="button">关闭</button></div>
        <div class="cpa-settings-content">${html}</div>
    </div>`;
    document.body.append(shell);
    $id('cpa-settings-close').addEventListener('click', closeSettings);
    shell.addEventListener('click', event => { if (event.target === shell) closeSettings(); });
    document.addEventListener('keydown', event => { if (event.key === 'Escape' && !shell.hidden) closeSettings(); });

    const host = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
    if (host) {
        const launcher = document.createElement('div');
        launcher.id = 'cpa-settings-launcher';
        launcher.className = 'cpa-settings-launcher';
        launcher.innerHTML = `<div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>Comfy Prompt Agent</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <p class="cpa-muted">独立的 ComfyUI、提示词 LLM、Skills 与工作流配置。</p>
                <div class="cpa-launcher-actions">
                    <button class="menu_button cpa-open-settings" type="button">打开完整设置</button>
                    <button class="menu_button cpa-open-quick" type="button">打开快捷参数</button>
                </div>
            </div>
        </div>`;
        launcher.querySelector('.cpa-open-settings').addEventListener('click', openSettings);
        launcher.querySelector('.cpa-open-quick').addEventListener('click', toggleQuickPanel);
        host.append(launcher);
    }
}

function renderQuickPanel() {
    const panel = $id('cpa-quick-panel');
    if (!panel || !config) return;
    const workflow = config.workflows.find(item => item.id === config.selectedWorkflowId);
    const preset = workflow?.presets?.find(item => item.id === config.selectedPresetId) || workflow?.presets?.[0];
    panel.replaceChildren();
    const head = document.createElement('div');
    head.className = 'cpa-card-head';
    head.innerHTML = `<strong>Comfy Prompt Agent</strong><span class="cpa-muted">${escapeHtml(workflow?.name || '未选择工作流')} / ${escapeHtml(preset?.name || '')}</span>`;
    panel.append(head);
    const inputs = workflowDetail?.metadata?.id === workflow?.id ? workflowDetail.inputs : [];
    let count = 0;
    for (const input of inputs) {
        if (!preset?.visible?.[input.nodeId]?.includes?.(input.inputName)) continue;
        const row = document.createElement('label');
        row.className = 'cpa-quick-row';
        const label = document.createElement('span');
        label.textContent = `${input.title} / ${input.inputName}`;
        const control = inputControl(input, preset.values?.[input.nodeId]?.[input.inputName] ?? input.value);
        control.classList.remove('cpa-node-value');
        control.classList.add('cpa-quick-value');
        row.append(label, control);
        panel.append(row);
        count++;
    }
    if (!count) {
        const empty = document.createElement('p');
        empty.className = 'cpa-muted'; empty.textContent = '当前预设没有标记为“快捷显示”的参数。'; panel.append(empty);
    }
    const actions = document.createElement('div');
    actions.className = 'cpa-actions';
    actions.innerHTML = '<button class="menu_button" id="cpa-quick-settings">完整设置</button><button class="menu_button" id="cpa-quick-apply">应用参数</button><button class="menu_button" id="cpa-quick-regenerate">重绘当前 Swipe</button><button class="menu_button" id="cpa-quick-close">关闭</button>';
    panel.append(actions);
    $id('cpa-quick-settings').onclick = () => { panel.hidden = true; openSettings(); };
    $id('cpa-quick-close').onclick = () => { panel.hidden = true; };
    $id('cpa-quick-regenerate').onclick = () => submitMessageJob(chat.length - 1, { force: true }).catch(error => notify('error', error.message));
    $id('cpa-quick-apply').onclick = () => saveQuickValues(workflow, preset).catch(error => notify('error', error.message));
}

async function saveQuickValues(workflow, preset) {
    if (!workflow || !preset) throw new Error('没有选中的工作流预设。');
    const next = structuredClone(preset);
    next.values ||= {};
    for (const control of document.querySelectorAll('.cpa-quick-value')) {
        (next.values[control.dataset.node] ||= {})[control.dataset.input] = readNodeControl(control);
    }
    await api(`/workflows/${encodeURIComponent(workflow.id)}/presets`, { method: 'POST', body: next });
    notify('success', '快捷参数已应用');
    await loadConfig();
}

async function loadWorkflowDetail() {
    const id = val('cpa-workflow');
    workflowDetail = null;
    renderWorkflowNodes();
    renderQuickPanel();
    if (!id) return;
    try {
        workflowDetail = await api(`/workflows/${encodeURIComponent(id)}?live=1`);
        objectInfoAvailable = true;
    } catch (error) {
        objectInfoAvailable = false;
        workflowDetail = await api(`/workflows/${encodeURIComponent(id)}`);
        notify('warning', `ComfyUI 未连接，先按 JSON 原始类型显示参数：${error.message}`);
    }
    renderWorkflowNodes();
}

function collectPreset(clone = false) {
    const arrays = selector => [...document.querySelectorAll(selector)].filter(item => item.checked).map(item => ({ nodeId: item.dataset.node, inputName: item.dataset.input }));
    const grouped = selector => {
        const result = {};
        for (const item of document.querySelectorAll(selector)) if (item.checked) (result[item.dataset.node] ||= []).push(item.dataset.input);
        return result;
    };
    const values = {};
    for (const control of document.querySelectorAll('.cpa-node-value')) {
        (values[control.dataset.node] ||= {})[control.dataset.input] = readNodeControl(control);
    }
    const negativeTargets = arrays('.cpa-negative-target');
    const agentControllable = grouped('.cpa-node-agent');
    for (const target of negativeTargets) agentControllable[target.nodeId] = (agentControllable[target.nodeId] || []).filter(name => name !== target.inputName);
    return {
        id: clone ? undefined : val('cpa-preset'), name: val('cpa-preset-name'), negativePrompt: val('cpa-negative'),
        randomizeSeed: checked('cpa-randomize-seed'),
        artistPrompt: val('cpa-artist'),
        positiveTargets: arrays('.cpa-positive-target'), negativeTargets,
        outputNodeIds: [...document.querySelectorAll('.cpa-output-node:checked')].map(item => item.dataset.node),
        values, visible: grouped('.cpa-node-visible'), agentControllable,
    };
}

async function savePresetUi(clone = false) {
    const workflowId = val('cpa-workflow');
    if (!workflowId) throw new Error('请先选择工作流。');
    await api(`/workflows/${encodeURIComponent(workflowId)}/presets`, { method: 'POST', body: collectPreset(clone) });
    notify('success', '工作流预设已保存');
    await loadConfig();
}

async function upload(endpoint, fileInput, extra = {}) {
    const file = $id(fileInput).files[0];
    if (!file) throw new Error('请先选择文件。');
    const form = new FormData(); form.set('file', file);
    for (const [key, value] of Object.entries(extra)) form.set(key, value);
    return await api(endpoint, { method: 'POST', body: form });
}

async function importWorkflowFile() { await upload('/workflows/upload', 'cpa-workflow-file'); notify('success', '工作流已导入，请确认提示词目标'); await loadConfig(); }
async function importWorkflowUrl() { await api('/workflows/url', { method: 'POST', body: { url: val('cpa-workflow-url') } }); notify('success', '工作流已导入'); await loadConfig(); }
async function loadSillyTavernWorkflows() {
    const items = await api('/workflows/sillytavern');
    const select = $id('cpa-st-workflows'); select.replaceChildren(new Option('— 未选择 —', ''), ...items.map(item => new Option(item.name, item.name)));
}

function renderSkills() {
    const selected = new Set(config.modes[3].skillIds || []);
    $id('cpa-skills').innerHTML = config.skills.map(skill => `<div class="cpa-card">
        <div class="cpa-card-head"><label><input class="cpa-skill-select" data-id="${escapeHtml(skill.id)}" type="checkbox" ${selected.has(skill.id) ? 'checked' : ''}> <strong>${escapeHtml(skill.name)}</strong></label><span class="cpa-pill ${skill.trusted ? 'ok' : ''}">${browserRuntime ? '浏览器只读' : (skill.trusted ? '可信脚本' : '只读文本')}</span></div>
        <div class="cpa-muted">${escapeHtml(skill.source)} · references ${(skill.references || []).length} · scripts ${(skill.scripts || []).length}</div>
        ${browserRuntime ? '' : `<div class="cpa-actions"><button class="menu_button cpa-skill-trust" data-id="${escapeHtml(skill.id)}" data-trusted="${!skill.trusted}">${skill.trusted ? '撤销信任' : '标记为可信'}</button>${skill.github ? `<button class="menu_button cpa-skill-update" data-id="${escapeHtml(skill.id)}">更新（会撤销信任）</button>` : ''}<button class="menu_button redWarningBG cpa-skill-delete" data-id="${escapeHtml(skill.id)}">删除</button></div>`}
    </div>`).join('') || '<span class="cpa-muted">尚无 Skill。</span>';
}

function renderReferences() {
    const selected = new Set(config.modes[3].referenceIds || []);
    $id('cpa-references').innerHTML = config.references.map(reference => `<div class="cpa-card">
        <div class="cpa-card-head"><label><input class="cpa-reference-select" data-id="${escapeHtml(reference.id)}" type="checkbox" ${selected.has(reference.id) ? 'checked' : ''}> <strong>${escapeHtml(reference.title)}</strong></label><button class="menu_button cpa-reference-edit" data-id="${escapeHtml(reference.id)}">编辑</button></div>
        <div class="cpa-muted">${escapeHtml(reference.source)} · ${escapeHtml(reference.summary)}</div>
    </div>`).join('') || '<span class="cpa-muted">尚无 Reference。</span>';
}

async function editReference(id) {
    const result = await api(`/references/${encodeURIComponent(id)}`);
    editingReferenceId = id;
    $id('cpa-reference-title').value = result.metadata.title;
    $id('cpa-reference-content').value = result.content;
}

async function refreshJobs() {
    const jobs = await api('/jobs');
    $id('cpa-jobs').innerHTML = jobs.map(job => `<div class="cpa-card">
        <div class="cpa-card-head"><strong>${escapeHtml(job.status)} · ${escapeHtml(job.stage)}</strong><code>${escapeHtml(job.id)}</code></div>
        ${job.result ? `<div class="cpa-muted">${escapeHtml(job.result.workflow?.name)} / ${escapeHtml(job.result.preset?.name)} · ${job.result.images?.length || 0} 张 · ${job.result.context?.estimatedTokens || 0} tokens · ${job.result.agentSteps || 0} steps</div>` : ''}
        ${job.error ? `<div class="cpa-job-error">${escapeHtml(job.error)}</div>` : ''}
        ${!TERMINAL.has(job.status) ? `<button class="menu_button cpa-job-cancel" data-id="${escapeHtml(job.id)}">取消</button>` : ''}
    </div>`).join('') || '<span class="cpa-muted">尚无任务。</span>';
}

function ensureSwipe(message, swipeId) {
    message.extra ||= {};
    message.swipe_id ??= swipeId;
    message.swipes ||= [];
    message.swipe_info ||= [];
    message.swipes[swipeId] ??= message.mes;
    message.swipe_info[swipeId] ||= { send_date: message.send_date, gen_started: message.gen_started, gen_finished: message.gen_finished, extra: structuredClone(message.extra) };
    message.swipe_info[swipeId].extra ||= {};
    return message.swipe_info[swipeId].extra;
}

function activeText(message) {
    return String(message?.mes ?? '');
}

function conversationThrough(messageId) {
    return chat.slice(0, messageId + 1).filter(item => !item.is_system).map(item => ({ role: item.is_user ? 'user' : 'assistant', content: activeText(item) }));
}

function previousPositivePrompts(messageId, mode) {
    const limit = Math.max(0, Math.min(20, Number(config?.modes?.[mode]?.promptHistoryCount) || 0));
    if (!limit) return [];
    const prompts = [];
    for (let index = 0; index <= messageId; index++) {
        const message = chat[index];
        if (!message || message.is_user || message.is_system) continue;
        const swipeId = Number(message.swipe_id ?? 0);
        const state = message.swipe_info?.[swipeId]?.extra?.comfy_prompt_agent || message.extra?.comfy_prompt_agent;
        const prompt = String(state?.positive_prompt || '').trim();
        if (prompt && prompts.at(-1) !== prompt) prompts.push(prompt);
    }
    return prompts.slice(-limit);
}

async function contextExtras(mode) {
    const settings = config.modes[mode];
    if (!settings || mode === 1) return {};
    const fields = getContext().getCharacterCardFields?.() || {};
    const extras = {};
    if (settings.includeCharacterCard) extras.characterCard = JSON.stringify({ description: fields.description, personality: fields.personality, scenario: fields.scenario, mesExamples: fields.mesExamples, creatorNotes: fields.creatorNotes });
    if (settings.includePersona) extras.persona = fields.persona || '';
    if (settings.includeSystemPrompt) extras.systemPrompt = fields.system || '';
    if (settings.includeWorldBook) {
        const books = [];
        for (const name of settings.worldBooks || []) {
            try { books.push({ name, content: await getContext().loadWorldInfo(name) }); }
            catch (error) { books.push({ name, error: error.message }); }
        }
        extras.worldBook = JSON.stringify(books);
    }
    return extras;
}

function targetFor(messageId, swipeId) {
    const context = getContext();
    return {
        isGroup: Boolean(context.groupId), chatId: getCurrentChatId(), avatar: characters[this_chid]?.avatar || '',
        messageIndex: messageId, swipeId,
    };
}

async function persistIfCurrent(target) {
    if (target.chatId === getCurrentChatId()) await saveChatConditional();
}

async function submitMessageJob(messageId, { force = false } = {}) {
    const message = chat[messageId];
    if (!message || message.is_user || message.is_system) return;
    const swipeId = Number(message.swipe_id ?? 0);
    const source = activeText(message);
    const parsed = parseImageTags(source);
    const mode = number('cpa-mode', Number(config.mode));
    const requiresTag = modeRequiresImageTag(mode);
    const extra = ensureSwipe(message, swipeId);
    let state = extra.comfy_prompt_agent;
    const archived = parsed.tags.length ? parsed : parseImageTags(state?.original_text || '');
    const triggerTag = requiresTag ? archived.selected : archived.trigger;
    let directive = requiresTag ? (archived.selected?.directive || state?.directive || '') : '';

    if (parsed.tags.length) {
        state = {
            ...(state || {}), original_text: source, original_tag: triggerTag?.raw || parsed.trigger?.raw || state?.original_tag || '', directive,
            tag_content_ignored: !requiresTag,
            ignored_tags: parsed.tags.filter(item => item !== triggerTag).map(item => item.raw), mode,
        };
        extra.comfy_prompt_agent = state;
        if (message.swipe_id === swipeId) message.extra = extra;
        if (requiresTag && !triggerTag) {
            state.status = 'ignored_empty';
            await persistIfCurrent(targetFor(messageId, swipeId));
            return;
        }
    }
    if (!parsed.tags.length && state && triggerTag?.raw) {
        state.original_tag ||= triggerTag.raw;
        if (requiresTag) state.directive ||= directive;
    }
    if (!requiresTag && !state) {
        state = {
            original_text: source,
            original_tag: '',
            directive: '',
            tag_content_ignored: false,
            ignored_tags: [],
            mode,
        };
        extra.comfy_prompt_agent = state;
        if (message.swipe_id === swipeId) message.extra = extra;
    }
    const hasTrigger = requiresTag ? Boolean(directive) : true;
    if (!hasTrigger) {
        if (force) throw new Error('模式 1 要求当前 Swipe 包含非空 <image>提示词</image> 标签。');
        return;
    }
    if (!force && state?.status && Number(state.mode) === mode && !['failed', 'cancelled'].includes(state.status)) {
        if (state.status === 'pending' && state.job_id) pollJob(state.job_id, targetFor(messageId, swipeId));
        return;
    }

    const target = targetFor(messageId, swipeId);
    const triggerIdentity = requiresTag ? directive : source;
    const triggerHash = fnv1a(`${target.chatId}|${messageId}|${swipeId}|${triggerIdentity}|${force ? Date.now() : state?.original_text || source}`);
    Object.assign(state, { trigger_hash: triggerHash, directive, mode, status: 'pending', error: '', job_id: '' });
    await persistIfCurrent(target);
    try {
        const created = await api('/jobs', { method: 'POST', body: {
            mode, directive, triggerHash,
            workflowId: val('cpa-workflow') || config.selectedWorkflowId,
            presetId: val('cpa-preset') || config.selectedPresetId,
            conversation: conversationThrough(messageId), previousPrompts: previousPositivePrompts(messageId, mode), extras: await contextExtras(mode), target,
        } });
        state.job_id = created.id;
        state.status = created.status === 'queued' ? 'pending' : created.status;
        await persistIfCurrent(target);
        pollJob(created.id, target);
        refreshJobs().catch(() => {});
    } catch (error) {
        state.status = 'failed'; state.error = error.message;
        await persistIfCurrent(target);
        notify('error', error.message);
    }
}

function locateTarget(target) {
    if (target.chatId !== getCurrentChatId()) return null;
    const message = chat[target.messageIndex];
    if (!message) return null;
    return { message, extra: ensureSwipe(message, Number(target.swipeId)), active: Number(message.swipe_id ?? 0) === Number(target.swipeId) };
}

function imageMedia(image, result) {
    const raw = String(image.path || '');
    const url = /^(?:data:|blob:|https?:)/i.test(raw) ? raw : (raw.startsWith('/') ? raw : `/${raw.replace(/^\/+/, '')}`);
    return { type: 'image', url, title: `${result.workflow?.name || 'ComfyUI'} · ${result.preset?.name || ''}`, generation_type: 'comfy-prompt-agent' };
}

function clearGalleryFallbackTimer(messageId) {
    const pending = galleryFallbackTimers.get(messageId);
    if (!pending) return;
    clearTimeout(pending.timer);
    galleryFallbackTimers.delete(messageId);
}

function nativeGalleryHasImage(messageElement, paths) {
    const nativeMedia = [...messageElement.querySelectorAll('.mes_media_wrapper img, .mes_media_wrapper video')];
    return paths.some(url => nativeMedia.some(element => String(element.getAttribute('src') || '').includes(url)));
}

function insertFallbackGallery(messageElement, state, paths) {
    let gallery = messageElement.querySelector('.cpa-inline-gallery');
    if (!gallery) {
        gallery = document.createElement('div');
        gallery.className = 'cpa-inline-gallery';
        const text = messageElement.querySelector('.mes_text');
        if (text) text.insertAdjacentElement('afterend', gallery);
        else messageElement.append(gallery);
    }
    gallery.replaceChildren();
    for (const [index, url] of paths.entries()) {
        const link = document.createElement('a');
        link.href = url;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.title = `${state.workflow?.name || 'ComfyUI'} · ${state.preset?.name || ''} · ${index + 1}/${paths.length}`;
        const image = document.createElement('img');
        image.src = url;
        image.alt = `ComfyUI image ${index + 1}`;
        image.loading = 'lazy';
        link.append(image);
        gallery.append(link);
    }
}

function promptBlockForMediaTarget(target) {
    if (!(target instanceof Element)) return null;
    const media = target.closest(PROMPT_MEDIA_SELECTOR);
    return media?.closest('.mes')?.querySelector('.cpa-message-prompt') || null;
}

function showMessagePrompt(block) {
    const timer = promptHideTimers.get(block);
    if (timer) clearTimeout(timer);
    promptHideTimers.delete(block);
    block.hidden = false;
}

function hideMessagePrompt(block, immediate = false) {
    const timer = promptHideTimers.get(block);
    if (timer) clearTimeout(timer);
    promptHideTimers.delete(block);
    if (block.dataset.pinned === 'true') return;
    if (immediate) {
        block.hidden = true;
        return;
    }
    promptHideTimers.set(block, setTimeout(() => {
        promptHideTimers.delete(block);
        if (block.dataset.pinned !== 'true') block.hidden = true;
    }, 180));
}

function bindMessagePromptReveal() {
    document.addEventListener('pointerover', event => {
        const block = promptBlockForMediaTarget(event.target) || event.target.closest?.('.cpa-message-prompt');
        if (block) showMessagePrompt(block);
    });
    document.addEventListener('pointerout', event => {
        const block = promptBlockForMediaTarget(event.target) || event.target.closest?.('.cpa-message-prompt');
        if (!block) return;
        const relatedBlock = promptBlockForMediaTarget(event.relatedTarget) || event.relatedTarget?.closest?.('.cpa-message-prompt');
        if (relatedBlock === block) return;
        hideMessagePrompt(block);
    });
    document.addEventListener('click', event => {
        const block = promptBlockForMediaTarget(event.target);
        if (block) {
            for (const other of document.querySelectorAll('.cpa-message-prompt[data-pinned="true"]')) {
                if (other === block) continue;
                other.dataset.pinned = 'false';
                hideMessagePrompt(other, true);
            }
            block.dataset.pinned = block.dataset.pinned === 'true' ? 'false' : 'true';
            showMessagePrompt(block);
            return;
        }
        if (event.target.closest?.('.cpa-message-prompt')) return;
        for (const other of document.querySelectorAll('.cpa-message-prompt[data-pinned="true"]')) {
            other.dataset.pinned = 'false';
            hideMessagePrompt(other, true);
        }
    });
}

function renderMessageGallery(messageId, extra) {
    const messageElement = document.querySelector(`.mes[mesid="${messageId}"]`);
    if (!messageElement) return;
    const state = extra?.comfy_prompt_agent;
    const images = Array.isArray(state?.images) ? state.images : [];
    const gallery = messageElement.querySelector('.cpa-inline-gallery');
    if (!images.length) {
        clearGalleryFallbackTimer(messageId);
        gallery?.remove();
        return;
    }

    const paths = images.map(image => imageMedia(image, { workflow: state.workflow, preset: state.preset }).url);
    if (nativeGalleryHasImage(messageElement, paths)) {
        clearGalleryFallbackTimer(messageId);
        gallery?.remove();
        return;
    }
    if (gallery) return;

    // SillyTavern appends its native media asynchronously after updateMessageBlock().
    // Wait for that path first so the fallback and native image never flash together.
    const signature = paths.join('\n');
    const pending = galleryFallbackTimers.get(messageId);
    if (pending?.signature === signature) return;
    clearGalleryFallbackTimer(messageId);
    const timer = setTimeout(() => {
        galleryFallbackTimers.delete(messageId);
        const currentElement = document.querySelector(`.mes[mesid="${messageId}"]`);
        const message = chat[messageId];
        if (!currentElement || !message) return;
        const swipeId = Number(message.swipe_id ?? 0);
        const currentExtra = message.swipe_info?.[swipeId]?.extra || message.extra;
        const currentState = currentExtra?.comfy_prompt_agent;
        const currentPaths = (currentState?.images || []).map(image => imageMedia(image, { workflow: currentState.workflow, preset: currentState.preset }).url);
        if (currentPaths.join('\n') !== signature || nativeGalleryHasImage(currentElement, currentPaths)) return;
        insertFallbackGallery(currentElement, currentState, currentPaths);
    }, 800);
    galleryFallbackTimers.set(messageId, { signature, timer });
}

function renderMessagePositivePrompt(messageId, extra) {
    const messageElement = document.querySelector(`.mes[mesid="${messageId}"]`);
    if (!messageElement) return;
    const prompt = String(extra?.comfy_prompt_agent?.positive_prompt || '').trim();
    let block = messageElement.querySelector('.cpa-message-prompt');
    if (!prompt) {
        block?.remove();
        return;
    }
    if (!block) {
        block = document.createElement('section');
        block.className = 'cpa-message-prompt';
        block.hidden = true;
        block.dataset.pinned = 'false';
        block.innerHTML = `<div class="cpa-message-prompt-head">
            <strong>图片正向 Prompt</strong>
            <button class="menu_button cpa-prompt-copy" type="button" title="复制正向 Prompt"><i class="fa-solid fa-copy"></i><span>复制</span></button>
        </div><pre class="cpa-message-prompt-text"></pre>`;
        block.querySelector('.cpa-prompt-copy').addEventListener('click', async event => {
            event.preventDefault();
            event.stopPropagation();
            try {
                await copyText(block.querySelector('.cpa-message-prompt-text')?.textContent || '');
                notify('success', '正向 Prompt 已复制');
            } catch (error) {
                notify('error', `复制失败：${error.message}`);
            }
        });
        const media = messageElement.querySelector('.mes_media_wrapper');
        if (media) media.insertAdjacentElement('afterend', block);
        else messageElement.querySelector('.mes_text')?.insertAdjacentElement('afterend', block);
    }
    const text = block.querySelector('.cpa-message-prompt-text');
    if (text.textContent !== prompt) {
        text.textContent = prompt;
        block.dataset.pinned = 'false';
        hideMessagePrompt(block, true);
    }
}

function renderMessageError(messageId, extra) {
    const messageElement = document.querySelector(`.mes[mesid="${messageId}"]`);
    if (!messageElement) return;
    const state = extra?.comfy_prompt_agent;
    const error = ['failed', 'cancelled'].includes(state?.status) ? String(state?.error || '').trim() : '';
    let block = messageElement.querySelector('.cpa-message-error');
    if (!error) {
        block?.remove();
        return;
    }
    if (!block) {
        block = document.createElement('div');
        block.className = 'cpa-message-error';
        block.setAttribute('role', 'alert');
        const text = messageElement.querySelector('.mes_text');
        if (text) text.insertAdjacentElement('afterend', block);
        else messageElement.append(block);
    }
    block.textContent = `Comfy Prompt Agent：${error}`;
}

function syncMessageUi(messageId) {
    const message = chat[messageId];
    if (!message || message.is_user || message.is_system) return;
    const swipeId = Number(message.swipe_id ?? 0);
    const extra = message.swipe_info?.[swipeId]?.extra || message.extra;
    addMessageAction(messageId);
    renderMessageGallery(messageId, extra);
    renderMessagePositivePrompt(messageId, extra);
    renderMessageError(messageId, extra);
    cancelAnimationFrame(swipeRefreshFrame);
    swipeRefreshFrame = requestAnimationFrame(() => {
        swipeRefreshFrame = 0;
        showSwipeButtons();
    });
}

async function applyJob(job, target) {
    const located = locateTarget(target);
    if (!located) return;
    const state = located.extra.comfy_prompt_agent || (located.extra.comfy_prompt_agent = {});
    state.status = job.status;
    state.error = job.error || '';
    if (job.result) {
        state.positive_prompt = job.result.positivePrompt;
        state.negative_prompt = job.result.negativePrompt;
        state.workflow = job.result.workflow;
        state.preset = job.result.preset;
        state.parameters = job.result.parameters;
        state.images = job.result.images;
        state.context = job.result.context;
        state.agent_steps = job.result.agentSteps;
        state.tool_calls = job.result.toolLog;
        state.prompt_warnings = job.result.promptWarnings || [];
        located.extra.media ||= [];
        for (const image of job.result.images || []) {
            const media = imageMedia(image, job.result);
            if (!located.extra.media.some(item => item.url === media.url)) located.extra.media.push(media);
        }
        located.extra.media_display = 'gallery';
        located.extra.inline_image = true;
        located.extra.media_index = Math.max(0, located.extra.media.length - 1);
    }
    if (located.active) located.message.extra = located.extra;
    await persistIfCurrent(target);
    // Job polling must never re-render .mes_text: doing so resets user-owned
    // DOM state such as an opened <details> block once per polling interval.
    // A completed result only needs SillyTavern to refresh its media wrapper.
    if (located.active && job.result) updateMessageBlock(target.messageIndex, located.message, { rerenderMessage: false });
    syncMessageUi(target.messageIndex);
}

function pollJob(jobId, target) {
    if (pollers.has(jobId)) return;
    const run = async () => {
        try {
            const job = await api(`/jobs/${encodeURIComponent(jobId)}`);
            await applyJob(job, target);
            if (TERMINAL.has(job.status)) {
                pollers.delete(jobId);
                if (job.status === 'completed') {
                    for (const warning of job.result?.promptWarnings || []) notify('warning', warning);
                    notify('success', `已生成 ${job.result?.images?.length || 0} 张图片`);
                }
                else notify('error', job.error || `任务${job.status}`);
                refreshJobs().catch(() => {});
                return;
            }
        } catch (error) { console.warn('[Comfy Prompt Agent] poll failed', error); }
        pollers.set(jobId, setTimeout(run, 1000));
    };
    pollers.set(jobId, setTimeout(run, 200));
}

function restoreStoredImageTags(message) {
    if (!Array.isArray(message.swipe_info) || !Array.isArray(message.swipes)) return false;
    let restored = false;
    for (let swipeId = 0; swipeId < message.swipe_info.length; swipeId++) {
        const state = message.swipe_info[swipeId]?.extra?.comfy_prompt_agent;
        const original = String(state?.original_text || '');
        if (!original) continue;
        const parsed = parseImageTags(original);
        if (!parsed.tags.length || String(message.swipes[swipeId] ?? '') !== parsed.cleanedText) continue;
        message.swipes[swipeId] = original;
        if (Number(message.swipe_id ?? 0) === swipeId) message.mes = original;
        restored = true;
    }
    return restored;
}

async function resumeCurrentChat() {
    let restoredAny = false;
    const latestAssistantId = chat.findLastIndex(message => message && !message.is_user && !message.is_system);
    for (const [messageId, message] of chat.entries()) {
        if (message.is_user || message.is_system) continue;
        const restored = restoreStoredImageTags(message);
        restoredAny ||= restored;
        if (restored) updateMessageBlock(messageId, message);
        const swipeId = Number(message.swipe_id ?? 0);
        const state = message.swipe_info?.[swipeId]?.extra?.comfy_prompt_agent || message.extra?.comfy_prompt_agent;
        if (state?.status === 'pending') {
            if (state.job_id) pollJob(state.job_id, targetFor(messageId, swipeId));
            else submitMessageJob(messageId).catch(error => notify('error', error.message));
        } else if (!state && messageId === latestAssistantId && (!modeRequiresImageTag(config.mode) || parseImageTags(activeText(message)).trigger)) {
            await submitMessageJob(messageId);
        }
        syncMessageUi(messageId);
    }
    if (restoredAny) await saveChatConditional();
}

function addMessageAction(messageId) {
    const message = chat[messageId];
    const swipeId = Number(message?.swipe_id ?? 0);
    const hasState = Boolean(message?.swipe_info?.[swipeId]?.extra?.comfy_prompt_agent || message?.extra?.comfy_prompt_agent);
    if (!hasState) return;
    const element = document.querySelector(`.mes[mesid="${messageId}"] .mes_buttons`);
    if (!element || element.querySelector('.cpa-message-action')) return;
    const button = document.createElement('div');
    button.className = 'mes_button cpa-message-action fa-solid fa-wand-magic-sparkles';
    button.title = 'Comfy Prompt Agent：重新生成本 Swipe';
    button.dataset.messageId = messageId;
    element.append(button);
}

async function estimateCurrent() {
    const messageId = chat.length - 1;
    const message = chat[messageId];
    if (!message || message.is_user) throw new Error('当前没有 AI 消息。');
    const swipeId = Number(message.swipe_id ?? 0);
    const state = ensureSwipe(message, swipeId).comfy_prompt_agent;
    const mode = number('cpa-mode', config.mode);
    const parsed = parseImageTags(activeText(message));
    const directive = modeRequiresImageTag(mode) ? (state?.directive || parsed.selected?.directive || '') : '';
    if (modeRequiresImageTag(mode) && !directive) throw new Error('模式 1 要求当前 Swipe 包含非空 <image>提示词</image> 标签。');
    const result = await api('/jobs/estimate', { method: 'POST', body: { mode, directive, conversation: conversationThrough(messageId), previousPrompts: previousPositivePrompts(messageId, mode), extras: await contextExtras(mode) } });
    $id('cpa-estimate-result').textContent = `实际 ${result.actualTurns} 轮 / ${result.actualMessages} 条 / 参考 ${result.previousPromptCount || 0} 条历史图片 Prompt / 约 ${result.estimatedTokens} tokens；裁掉 ${result.dropped.turns} 轮${result.dropped.extras.length ? `、${result.dropped.extras.join(', ')}` : ''}`;
}

function bindUi() {
    bindMessagePromptReveal();
    $id('cpa-mode').addEventListener('change', () => saveModeSelection().catch(error => notify('error', error.message)));
    $id('cpa-save').addEventListener('click', () => saveConfig().catch(error => notify('error', error.message)));
    $id('cpa-bootstrap-copy').addEventListener('click', async () => {
        try { await copyText(bootstrapCommand()); notify('success', '安装命令已复制'); }
        catch (error) { notify('error', error.message); }
    });
    $id('cpa-comfy-test').addEventListener('click', () => testComfyDraft().catch(error => notify('error', error.message)));
    $id('cpa-object-refresh').addEventListener('click', () => refreshObjectInfo().catch(error => notify('error', error.message)));
    $id('cpa-profile-list').addEventListener('change', editProfile);
    $id('cpa-profile-new').addEventListener('click', () => { $id('cpa-profile-list').value = ''; editProfile(); });
    $id('cpa-profile-save').addEventListener('click', () => saveProfile().catch(error => notify('error', error.message)));
    $id('cpa-profile-models').addEventListener('click', () => refreshModels().catch(error => notify('error', error.message)));
    $id('cpa-profile-delete').addEventListener('click', () => { const id = val('cpa-profile-list'); if (id && confirm('删除此 LLM Profile？')) api(`/llm-profiles/${encodeURIComponent(id)}`, { method: 'DELETE' }).then(loadConfig).catch(error => notify('error', error.message)); });
    $id('cpa-workflow').addEventListener('change', () => { updatePresetOptions(); loadWorkflowDetail().catch(error => notify('error', error.message)); });
    $id('cpa-preset').addEventListener('change', renderWorkflowNodes);
    $id('cpa-workflow-upload').addEventListener('click', () => importWorkflowFile().catch(error => notify('error', error.message)));
    $id('cpa-workflow-import-url').addEventListener('click', () => importWorkflowUrl().catch(error => notify('error', error.message)));
    $id('cpa-workflow-copy').addEventListener('click', () => api('/workflows/sillytavern', { method: 'POST', body: { fileName: val('cpa-st-workflows') } }).then(loadConfig).catch(error => notify('error', error.message)));
    $id('cpa-workflow-scan').addEventListener('click', () => api('/workflows/scan', { method: 'POST', body: {} }).then(result => { notify(result.errors.length ? 'warning' : 'success', `导入 ${result.imported.length} 个，失败 ${result.errors.length} 个`); return loadConfig(); }).catch(error => notify('error', error.message)));
    $id('cpa-workflow-delete').addEventListener('click', () => { const id = val('cpa-workflow'); if (id && confirm('删除此工作流及其预设？')) api(`/workflows/${encodeURIComponent(id)}`, { method: 'DELETE' }).then(loadConfig).catch(error => notify('error', error.message)); });
    $id('cpa-download-anima-api').addEventListener('click', () => downloadBundledWorkflow('Anima-API.json'));
    $id('cpa-download-anima-comfyui').addEventListener('click', () => downloadBundledWorkflow('Anima-ComfyUI.json'));
    $id('cpa-preset-save').addEventListener('click', () => savePresetUi(false).catch(error => notify('error', error.message)));
    $id('cpa-preset-clone').addEventListener('click', () => savePresetUi(true).catch(error => notify('error', error.message)));
    $id('cpa-preset-delete').addEventListener('click', () => { const wid = val('cpa-workflow'), pid = val('cpa-preset'); if (wid && pid && confirm('删除此预设？')) api(`/workflows/${encodeURIComponent(wid)}/presets/${encodeURIComponent(pid)}`, { method: 'DELETE' }).then(loadConfig).catch(error => notify('error', error.message)); });
    $id('cpa-skill-upload').addEventListener('click', () => upload('/skills/upload', 'cpa-skill-file', { subdir: val('cpa-skill-subdir') }).then(loadConfig).catch(error => notify('error', error.message)));
    $id('cpa-skill-github').addEventListener('click', () => api('/skills/github', { method: 'POST', body: { url: val('cpa-skill-url'), ref: val('cpa-skill-ref'), subdir: val('cpa-skill-subdir') } }).then(loadConfig).catch(error => notify('error', error.message)));
    $id('cpa-skill-scan').addEventListener('click', () => api('/skills/scan', { method: 'POST', body: {} }).then(loadConfig).catch(error => notify('error', error.message)));
    $id('cpa-skills').addEventListener('click', event => {
        const trust = event.target.closest('.cpa-skill-trust');
        const update = event.target.closest('.cpa-skill-update');
        const remove = event.target.closest('.cpa-skill-delete');
        if (trust) api(`/skills/${encodeURIComponent(trust.dataset.id)}/trust`, { method: 'PUT', body: { trusted: trust.dataset.trusted === 'true' } }).then(loadConfig).catch(error => notify('error', error.message));
        if (update && confirm('更新会加载第三方新代码并撤销脚本信任，继续？')) api(`/skills/${encodeURIComponent(update.dataset.id)}/update`, { method: 'POST', body: {} }).then(loadConfig).catch(error => notify('error', error.message));
        if (remove && confirm('删除此 Skill？')) api(`/skills/${encodeURIComponent(remove.dataset.id)}`, { method: 'DELETE' }).then(loadConfig).catch(error => notify('error', error.message));
    });
    $id('cpa-reference-new').addEventListener('click', () => { editingReferenceId = ''; $id('cpa-reference-title').value = ''; $id('cpa-reference-content').value = ''; });
    $id('cpa-reference-save').addEventListener('click', () => api(editingReferenceId ? `/references/${encodeURIComponent(editingReferenceId)}` : '/references', { method: editingReferenceId ? 'PUT' : 'POST', body: { title: val('cpa-reference-title'), content: val('cpa-reference-content'), source: 'inline' } }).then(loadConfig).catch(error => notify('error', error.message)));
    $id('cpa-reference-url-add').addEventListener('click', () => api('/references/url', { method: 'POST', body: { title: val('cpa-reference-title'), url: val('cpa-reference-url') } }).then(loadConfig).catch(error => notify('error', error.message)));
    $id('cpa-reference-worldbook-add').addEventListener('click', async () => {
        try {
            const name = val('cpa-reference-worldbook');
            if (!name) throw new Error('请选择世界书。');
            const content = JSON.stringify(await getContext().loadWorldInfo(name), null, 2);
            await api('/references', { method: 'POST', body: { title: name, content, source: `worldbook:${name}` } });
            await loadConfig();
        } catch (error) { notify('error', error.message); }
    });
    $id('cpa-reference-upload').addEventListener('click', () => upload('/references/upload', 'cpa-reference-file', { title: val('cpa-reference-title') }).then(loadConfig).catch(error => notify('error', error.message)));
    $id('cpa-reference-delete').addEventListener('click', () => { if (editingReferenceId && confirm('删除此 Reference？')) api(`/references/${encodeURIComponent(editingReferenceId)}`, { method: 'DELETE' }).then(() => { editingReferenceId = ''; return loadConfig(); }).catch(error => notify('error', error.message)); });
    $id('cpa-references').addEventListener('click', event => { const edit = event.target.closest('.cpa-reference-edit'); if (edit) editReference(edit.dataset.id).catch(error => notify('error', error.message)); });
    $id('cpa-jobs-refresh').addEventListener('click', () => refreshJobs().catch(error => notify('error', error.message)));
    $id('cpa-jobs').addEventListener('click', event => { const cancel = event.target.closest('.cpa-job-cancel'); if (cancel) api(`/jobs/${encodeURIComponent(cancel.dataset.id)}`, { method: 'DELETE' }).then(refreshJobs).catch(error => notify('error', error.message)); });
    $id('cpa-estimate').addEventListener('click', () => estimateCurrent().catch(error => notify('error', error.message)));
    $id('cpa-regenerate').addEventListener('click', () => submitMessageJob(chat.length - 1, { force: true }).catch(error => notify('error', error.message)));
    document.addEventListener('click', event => { const button = event.target.closest('.cpa-message-action'); if (button) submitMessageJob(Number(button.dataset.messageId), { force: true }).catch(error => notify('error', error.message)); });
}

async function initialize() {
    installQuickPanel();
    document.querySelectorAll('.cpa-mode-fields').forEach(root => { root.innerHTML = modeFieldsHtml(root.dataset.mode); });
    bindUi();
    try { await loadConfig(); }
    catch (error) {
        const mismatch = /前后端版本不一致/.test(error.message);
        $id('cpa-server-state').textContent = mismatch ? '版本不一致' : '初始化失败';
        $id('cpa-server-state').className = 'cpa-pill bad';
        showBootstrapHelp();
        notify('error', error.message);
    }
    eventSource.on(event_types.MESSAGE_RECEIVED, messageId => setTimeout(() => config?.enabled && submitMessageJob(Number(messageId)).catch(error => notify('error', error.message)), 0));
    eventSource.on(event_types.MESSAGE_SWIPED, messageId => setTimeout(() => config?.enabled && submitMessageJob(Number(messageId)).catch(error => notify('error', error.message)), 0));
    eventSource.on(event_types.CHAT_LOADED, () => setTimeout(() => resumeCurrentChat().catch(error => console.warn('[Comfy Prompt Agent] chat resume failed', error)), 0));
    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, messageId => setTimeout(() => syncMessageUi(Number(messageId)), 0));
    if (config) await resumeCurrentChat();
}

jQuery(async () => {
    const html = await (await fetch(new URL('./settings.html', import.meta.url))).text();
    mountSettings(html);
    await initialize();
});
