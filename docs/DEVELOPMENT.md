# 开发与验收

## 目录

- `index.js`、`settings.html`、`style.css`：SillyTavern 前端扩展。
- `server-plugin/`：Express 路由、队列、LLM/Agent、ComfyUI、资源管理。
- `shared/`：浏览器和服务端可复用的标签、上下文、工作流纯函数。
- `plugin-entry.js`：稳定服务端引导器；从版本化目录加载运行代码。
- `install.mjs`：双端安装、版本暂存、可选 Skill 同步与 `config.yaml` 开关。
- `server-plugin/bundled/`：随发布包提供的 Anima Skill、API 工作流和 ComfyUI 普通工作流。
- `tests/`：Node test runner 自动化测试。

服务端安装布局为：

```text
plugins/comfy-prompt-agent/
├── index.js                 稳定引导器
├── active-version.json
└── releases/<version>/
    ├── server-plugin/
    └── shared/
```

每次发布必须同步提升根 `package.json`、`manifest.json`、`plugin-package.json`、`server-plugin/package.json` 和 `shared/version.js` 的版本。运行目录视为不可变；不要以同一个版本号发布不同代码。

## 自动验收

```bash
npm test
npm run check
```

若执行环境禁止监听本机临时端口或启动子进程，模拟 OpenAI/ComfyUI、安装器和 Skill 测试需要在允许这些操作的本机环境运行。

## 真实 Anima 验收

```bash
node install.mjs --st /path/to/SillyTavern
```

首次安装并重启后：

1. 确认自动安装并选择的 Skill 能看到 `SKILL.md`、`references/reference.md` 和 `scripts/check_prompt.py`。
2. 确认内置 Anima API 工作流已自动选择，并已配置 `__PROMPT__` 目标、负面目标和 SaveImage 输出。
3. 先在未信任状态验证脚本被拒绝；审查代码后显式信任，再运行模式 3。
4. 启动本地 ComfyUI，刷新 `/object_info`，检查缺失自定义节点。
5. 用模式 1 验证两种非空标签语法；用模式 2/3 验证无标签回复自动触发，已有标签正文不会进入 LLM/Agent；同时验证负面提示词始终等于预设值。
6. 生成期间切换聊天；完成后返回原聊天检查原 Swipe 画廊。

也可以先运行只读节点验收，增加 `--generate` 后提交一张真实测试图：

```bash
npm run acceptance:anima -- --url http://127.0.0.1:8188
npm run acceptance:anima -- --url http://127.0.0.1:8188 --generate
```

验收脚本不会修改工作流模板。若 API 工作流保存的 UNet 名称与本机已安装模型不同，可只在验收运行副本中覆盖，例如：

```bash
npm run acceptance:anima -- \
  --url http://127.0.0.1:8188 \
  --user-root /path/to/SillyTavern/data/default-user \
  --unet anima-aesthetic-v1.1.safetensors \
  --generate
```

脚本会先用实时 `/object_info` 验证覆盖后的所有节点参数；模型不存在、类型/范围错误或自定义节点缺失时不会提交生成任务。

本仓库自动化测试直接验证发布包内置的 `anima-prompt`、两种工作流格式、安装布局、设置映射和 Python 校验器。实际安装到 SillyTavern 的 Skill 脚本信任仍必须由用户显式开启。
