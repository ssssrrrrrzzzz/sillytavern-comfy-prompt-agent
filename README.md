# SillyTavern Comfy Prompt Agent

这是一个由“前端扩展 + 服务端插件”组成的独立文生图插件。它使用自己的 ComfyUI 地址、OpenAI-compatible LLM Profiles、工作流预设、Skill 和 Reference，不读取、切换或覆盖 SillyTavern 的聊天连接，也不修改内置 Image Generation 设置。

插件监听完整 AI 回复和新 Swipe。模式 1 要求显式标签，标签正文是直接发送给 ComfyUI 的最终 Danbooru 提示词：

```text
<image>1girl, solo, black_hair, blue_eyes, indoors, window, morning, soft_lighting</image>
<image>image###1girl, solo, black_hair, blue_eyes, indoors, window###</image>
```

模式 2/3 无需标签：每条完整 AI 回复和每个新 Swipe 都会自动触发。若消息中恰好包含 `<image>`，标签会原样保留在聊天正文，但服务端会在发送给独立 LLM/Agent 的临时上下文中移除全部标签及其正文。触发和任务状态保存在 `swipe_info[].extra.comfy_prompt_agent`。

## 三种模式

- 模式 1：标签内容直接作为正面提示词，不请求 LLM。
- 模式 2：独立 LLM 根据最近 N 轮聊天和用户允许的资料直接返回一行正向 Prompt，不使用 JSON，也不读取标签正文。
- 模式 3：受限 Agent 按需读取所选 Skill/Reference、调用已信任脚本，并可按权限选择工作流或修改白名单参数。

负面提示词始终只来自当前工作流预设。LLM 和 Agent 无法提供或覆盖负面提示词；服务端会再次校验。

工作流预设还可设置 Anima 默认画师串。多个画师使用逗号或换行分隔；保存时自动补充 `@` 前缀并把下划线转换为空格，运行时固定合并到最终正向 Prompt。

导入的 API 工作流不会保留 ComfyUI 前端的“生成后随机 seed”控件状态，因此预设默认在每个任务运行时生成新 seed，避免同一坏 seed 稳定复现拼贴/角色表等生成伪影。需要精确复现时，可在预设中关闭“每次任务随机 Seed”。模式 2 识别到 Anima 工作流后还会自动采用 Anima 标签格式并去除重复的质量词/画师词。`BREAK` 只是可选分隔符；插件不检查其数量或位置，不会因缺少 `BREAK` 修复、警告或终止出图。

前端与服务端会校验插件版本。0.2.0 起服务端使用稳定引导器和版本化运行目录：完成一次引导器安装与完整启动后，后续 Git 更新可在没有运行中任务时热切换服务端并自动刷新页面。配置和密钥位于用户数据目录，不随代码更新覆盖。

仓库内置经过校验的 `anima-prompt` Skill 快照及全部运行所需 References/Scripts，并附带：

- `Anima-API.json`：插件首次启动时自动导入、确认提示词/负面词/输出节点并设为默认；
- `Anima-ComfyUI.json`：可在 ComfyUI 前端直接打开的普通版工作流；
- 默认 Anima 模式 2 提示词与模式 3 Agent 提示词。

内置 Skill 默认只读且自动选中。脚本仍需用户审查后手动信任。

## 从 GitHub 安装

这个项目同时包含浏览器扩展和 SillyTavern 服务端插件。SillyTavern 官方“安装扩展”接口只执行 Git clone，没有服务端插件安装 API，因此首次安装仍需要运行一次仓库自带安装器：

1. 在 SillyTavern 的扩展管理器中填入本仓库 Git HTTPS 地址并安装。
2. 安装完成后插件会自动打开设置并显示命令。停止 SillyTavern，在 SillyTavern 根目录执行（自定义用户名时替换目录）：

```bash
node data/default-user/extensions/sillytavern-comfy-prompt-agent/install.mjs
```

3. 完整重启一次 SillyTavern。此后从扩展管理器更新新版本时，更新钩子会自动暂存并热切换服务端；有正在运行的出图任务时会等到下次空闲加载。

安装器会原地使用 Git 已克隆的扩展目录，不会再复制第二份前端，因此不会出现重复设置界面。SillyTavern 里常见的“无需重启”扩展是纯前端扩展；本插件需要后台队列、SecretManager、图片落盘和受控 Skill 脚本执行，所以首次必须注册服务端引导器。这是当前 SillyTavern 官方安装接口的边界，插件不会通过任意文件写入接口绕过它。

## 本地安装

要求 SillyTavern 1.18+、Node.js 18.17+。在项目目录执行：

```bash
node install.mjs --st /path/to/SillyTavern
```

本机默认目录可自动识别，因此也可以直接执行：

```bash
npm run install:local
```

安装器会：

- 安装前端到 `data/default-user/extensions/Comfy-Prompt-Agent`；
- 安装后端到 `plugins/comfy-prompt-agent`；
- 把后端运行代码放入版本化的 `releases/<version>`，保留稳定热更新引导器；
- 将 `enableServerPlugins` 改为 `true`，修改前备份 `config.yaml`；
- 不读取、重置或覆盖现有 `data/<user>/comfy-prompt-agent/config.json`；
- 自动安装内置 `anima-prompt` Skill；首次读取配置时自动导入并选择 Anima API 工作流；
- 仅在首次引导器安装或引导器自身升级时提示完整重启 SillyTavern。

可选地预放本地 Skill 和 API 工作流：

```bash
node install.mjs --st /path/to/SillyTavern \
  --skill /path/to/anima-prompt \
  --workflow /path/to/AnimaApi.json
```

预放的 Skill 默认仍是只读状态。工作流需在设置页点击“扫描工作流目录”后导入并确认正面提示词目标。

默认从本仓库同步内置 `anima-prompt` 的 `SKILL.md`、`references/`、`scripts/` 和运行所需文件。可用 `--no-auto-skill` 禁用，或用 `--skill /path/to/skill` 指定其它目录。首次打开设置时会扫描并自动选择 `anima-prompt` 一次；之后尊重手动取消选择。每次服务端版本加载后会刷新本地 Skill 元数据；可执行脚本内容发生变化时自动撤销已有信任。

## 首次配置

1. 首次安装后完整重启 SillyTavern，打开扩展设置中的 “Comfy Prompt Agent”。
2. 填写插件自己的 ComfyUI URL，点击“连接测试”和“刷新节点/模型”。
3. 首次使用默认已选中内置 Anima API 工作流；只需确认本机拥有 `anima-aesthetic-v1.1.safetensors`、`qwen_3_06b_base.safetensors` 和 `qwen_image_vae.safetensors`。也可上传其它 ComfyUI `Save (API Format)` JSON。
4. 内置预设已确认正面、负面和 SaveImage 输出节点；自定义工作流仍需手动确认。
5. 若使用模式 2/3，新建插件专用 OpenAI-compatible Profile，并分别选择 Profile。
6. 设置最近轮数、最大输入/输出 token、超时。模式 3 还可设置最大 Agent step（默认 6）、总超时、工具限制和权限。

“1 轮”是一条用户消息及其后一条 AI 回复。设为 0 时仍保留当前 AI 回复。超限时先从最旧完整轮开始删除，再依次删除世界书、系统提示、Persona、角色卡和历史图片 Prompt；强制系统指令和当前消息不会静默截断。

请求前可点击“估算当前聊天输入”，查看实际轮数、消息数和估算 token。

## 工作流与预设

每个工作流可有多个命名预设。预设保存默认负面提示词、正面与可选负面目标、所有非连接节点输入、输出节点、快捷面板参数和 Agent 可控白名单。

运行时会深拷贝原 API 工作流，然后依次应用预设值、Agent 白名单值，最后写入正面和负面提示词。模板 JSON 不会被修改。未配置负面目标时，工作流原始负面内容保持不变。

连接 ComfyUI 后，COMBO/模型/Checkpoint/UNet/CLIP/VAE/采样器/调度器使用下拉框，INT/FLOAT 使用带范围和步长的数字控件，BOOLEAN 使用开关，STRING 使用文本控件。节点连接不会成为可编辑项。

## Skill 与 Reference

用户数据目录为：

```text
data/<user>/comfy-prompt-agent/
├── skills/
├── workflow-imports/
├── workflows/
├── references/
└── jobs.json
```

Skill 必须包含 `SKILL.md`，可包含 `references/` 和 `scripts/`。支持 ZIP、GitHub HTTPS、目录扫描和 GitHub 更新。新装或更新后的 Skill 都是只读状态。

只有显式标记为可信后，Agent 才能执行 `scripts/` 内的 `.py/.js/.mjs/.cjs`。启动使用参数数组而不是 shell 字符串，并限制并发、超时和输出大小。请注意：可信第三方脚本仍拥有 SillyTavern 进程用户的系统权限。

Reference 支持 Markdown/TXT/JSON/YAML 上传、HTTPS URL、SillyTavern 世界书和界面内 Markdown 编辑。所选 Skill 的 `SKILL.md` 会按“单条 Skills 引用最大字符”自动加入 Agent 初始上下文；其大型 `references/` 只提供目录，再由 Agent 按需读取。独立 Reference 会建立标题、摘要和分段索引，Agent 初始只看到目录摘要，再按需搜索和读取正文。

## 消息与后台任务

提交前先保存 `pending` 和 trigger hash，刷新或重复事件不会重复出图。成功图片加入原 AI Swipe 的媒体画廊，并保留已有媒体。

即使任务期间切换聊天，服务端也只会根据 chat ID、消息序号、Swipe ID 和 trigger hash 写回原 Swipe。原消息已删除或 hash 不匹配时，图片和任务记录保留，但不会附到其他聊天。

消息上的魔杖按钮和设置页都可安全重绘当前 Swipe；最近任务面板支持刷新和取消。

## 测试

```bash
npm test
npm run check
```

测试直接使用发布包内置的 `anima-prompt`，并验证 Git 安装不会创建重复前端、所有静态设置按钮均有处理器、配置范围/限额会进入运行时。`npm run acceptance:anima -- --generate` 可对本机 ComfyUI 提交真实出图验收。

更多资料见 [API 文档](docs/API.md)、[安全模型](docs/SECURITY.md) 和 [开发/验收](docs/DEVELOPMENT.md)。

## 首版边界

仅实现文生图和 OpenAI-compatible Chat Completions；不实现图生图、视频、厂商原生 LLM 协议、未信任代码自动执行，也不修改 SillyTavern 核心。
