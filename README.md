# SillyTavern Comfy Prompt Agent

这是一个可直接通过 SillyTavern 扩展管理器安装的独立 ComfyUI 文生图插件。它使用自己的 ComfyUI 地址、OpenAI-compatible LLM Profile、工作流和预设，不读取或覆盖酒馆聊天连接，也不修改内置 Image Generation 设置。

## 安装：粘贴 GitHub 链接即可

1. 打开 SillyTavern 的“扩展”→“安装扩展”。
2. 粘贴本仓库 HTTPS 地址：`https://github.com/ssssrrrrrzzzz/sillytavern-comfy-prompt-agent`。
3. 下载完成后插件会自动刷新页面并直接进入免重启模式，无需重启 SillyTavern。
4. 第一次打开会自动显示“宝宝配置教程”，之后可从插件设置随时重开。

Git 更新同样会自动刷新页面。插件只有一个前端入口，不会生成重复设置界面。仓库为私有时，使用者需要先获得仓库访问权限。

## 两种模式

- 模式 1（默认）：只在 AI 回复含非空图片标签时出图，标签正文直接作为最终正向 Prompt。

  ```text
  <image>1girl, solo, black hair, blue eyes, indoors, window, morning light</image>
  <image>image###1girl, solo, black hair, blue eyes, indoors###</image>
  ```

- 模式 2：无需标签。每条完整 AI 回复和每个新 Swipe 都会调用插件自己的独立 LLM，根据最近聊天生成一行 Danbooru 正向 Prompt。

模式 2 实际发送的完整系统提示词会显示在插件设置的“模式 2 系统提示词”文本框中，可由用户查看、编辑和保存。默认内容整理自随包的 Anima Skill；运行时不会额外附加不可见的 Anima 生成指令。

聊天数据中的 `<image>` 原文会保留；模式 1 在界面上用“正在出图 / 重试 / 图片”遮住长标签，模式 2 发送给提示词 LLM 的临时上下文会移除标签及标签正文。模式 3/Agent 已移除，旧配置中的模式 3 会自动迁移为模式 2。

负面提示词始终只来自当前工作流预设，模式 2 LLM 无法生成或覆盖它。思考模型的 `reasoning_content` 不会被当作图片 Prompt；输出为空、只有思考或格式错误时会显示明确错误。

## 宝宝配置教程

首次打开的默认值已经可以用于本机 ComfyUI：

- 插件启用；
- 模式 1；
- ComfyUI：`http://127.0.0.1:8188`；
- 并发 1、队列 20、任务超时 300 秒；
- 自动导入并选中 `Anima · API（内置）` 工作流；
- 模式 2 最近聊天 4 轮、历史图片 Prompt 4 条、最大输入 8,000 token、最大输出 1,024 token、LLM 超时 120 秒。

教程会逐步带用户完成：

1. 测试 ComfyUI 并刷新节点/模型；
2. 确认默认工作流，按本机安装情况选择 UNet、CLIP、VAE、采样器和调度器；
3. 用模式 1 的 `<image>` 标签先跑通；
4. 可选配置模式 2 的 Base URL、API Key、模型和请求参数；
5. 调整聊天轮数、输入/输出 token 与可选角色资料；
6. 保存配置并开始使用。

教程不会锁定设置。用户可随时更换 ComfyUI、LLM、工作流、预设、模型与所有开放参数。

## Anima 默认内容

仓库附带：

- `Anima-API.json`：插件可直接运行的 API-format 工作流，首次启动自动导入并确认正面、负面和输出节点；
- `Anima-ComfyUI.json`：可在 ComfyUI 前端打开查看和编辑的普通版工作流；
- 原有 Anima 规则整理后的模式 2 默认提示词：要求纯 Danbooru 标签、单一连贯画面、不输出 JSON/说明/负面词，不要求 `BREAK`；
- 工作流预设中的默认负面 Prompt、随机 Seed 和可选默认画师串。

画师串用逗号或换行分隔；保存时自动补 `@`，下划线会转换为空格，并在运行时合并到正向 Prompt。`BREAK` 是可选分隔符，插件不检查数量或位置。

## 工作流和参数

插件接受 ComfyUI “Save (API Format)” JSON，也能扫描插件工作流目录、从 HTTPS/GitHub URL 导入或复制 SillyTavern 已有工作流。自定义工作流导入后必须确认正向 Prompt 目标；负面目标可以为空。

连接 ComfyUI 后，模型、Checkpoint、UNet、CLIP、VAE、采样器和调度器显示为下拉框；INT/FLOAT、BOOLEAN、STRING 使用对应控件；节点连接只读。运行时深拷贝模板，再写入预设参数和 Prompt，不修改原始工作流。

每个工作流可保存多个预设，包括默认负面 Prompt、默认画师串、Prompt 目标、输出节点、模型、采样参数、尺寸、seed 及快捷面板可见项。生成图片只挂到触发它的原 AI Swipe；后台完成其他 Swipe 时会明确提示位置，切回即可显示。鼠标悬停或点击图片时可查看正向 Prompt。

## 模式 2 上下文和 token

“1 轮”是一条用户消息及其后一条 AI 回复；设置为 0 仍保留当前 AI 回复。模式 2 还能参考最近若干条由本插件生成的正向 Prompt，用于保持人物外观、服装和画风一致。

超出输入上限时，先删除最旧完整轮，再依次裁剪世界书、系统提示、Persona、角色卡和历史图片 Prompt。强制系统指令和当前消息不会静默截断；它们自身超限会中止并提示提高上限。设置页可在请求前显示实际轮数、消息数和估算 token。

## 可选增强服务端与热加载

普通 Git 安装已经可以直接出图。若需要跨页面后台任务、SecretManager 保存密钥、完整批次图片和完整 `/object_info`，可在仓库目录执行：

```bash
node install.mjs --st /path/to/SillyTavern
```

安装器会保留现有 `data/<user>/comfy-prompt-agent/config.json`，安装稳定引导器和版本化后端，启用 `enableServerPlugins: true`。引导器已存在时，新版本会在任务空闲后热切换；无需重启 SillyTavern。只有第一次注册引导器或引导器自身升级才可能需要完整重启一次。

## 开发与测试

```bash
npm run check
npm test
npm run acceptance:browser
```

`npm run acceptance:browser -- --generate` 会经正在运行的 SillyTavern/ComfyUI 完成真实出图验收。更多资料见 [API](docs/API.md)、[安全模型](docs/SECURITY.md) 和 [开发/验收](docs/DEVELOPMENT.md)。

首版只实现文生图和 OpenAI-compatible Chat Completions，不实现图生图、视频或厂商原生 LLM 协议。
