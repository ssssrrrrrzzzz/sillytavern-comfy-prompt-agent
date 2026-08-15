# 开发与验收

## 目录

- `index.js`、`settings.html`、`style.css`：SillyTavern 前端和首次教程。
- `browser-runtime.js`：Git 安装后立即可用的任务、LLM 和 ComfyUI 运行时。
- `server-plugin/`：可选增强服务端、队列、SecretManager、LLM 和 ComfyUI。
- `shared/`：标签、上下文和工作流纯函数。
- `plugin-entry.js`：稳定热更新引导器。
- `install.mjs`：双端安装、版本暂存和 `config.yaml` 开关。
- `server-plugin/bundled/workflows/`：Anima API/普通版工作流。
- `tests/`：Node test runner 自动化测试。

服务端布局：

```text
plugins/comfy-prompt-agent/
├── index.js
├── active-version.json
└── releases/<version>/
    ├── server-plugin/
    └── shared/
```

发布时必须同步提升根 `package.json`、`manifest.json`、`plugin-package.json`、`server-plugin/package.json` 和 `shared/version.js`。

## 自动验收

```bash
npm run check
npm test
npm run acceptance:browser
```

测试覆盖两种模式、标签、上下文/token、提示词连贯性、独立 LLM、负面 Prompt 隔离、动态工作流参数、默认教程、重复界面、Git 安装和热更新布局。

## 真实 ComfyUI 验收

先确保 SillyTavern 与 ComfyUI 已运行：

```bash
npm run acceptance:browser
npm run acceptance:browser -- --generate
```

直接验收 Anima 工作流：

```bash
npm run acceptance:anima -- --url http://127.0.0.1:8188
npm run acceptance:anima -- --url http://127.0.0.1:8188 --generate
```

验收要点：首次打开教程；默认模式 1 和 Anima API 工作流；刷新模型；两种标签语法；模式 2 无标签触发；思维内容不进入 Prompt；历史 Prompt 保持一致性；默认负面词不被 LLM 覆盖；图片落到原 Swipe；设置弹窗只有一份。

可选增强服务端安装：

```bash
node install.mjs --st /path/to/SillyTavern
```

已存在引导器时调用 `/stage-update` 或 `/reload` 即可在空闲时热切换，无需重启进程。
