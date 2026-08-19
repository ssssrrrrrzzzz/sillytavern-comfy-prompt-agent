# Changelog

## 0.5.2

- 删除模式 3 移除后遗留且不可达的 Agent 与 Skill/Reference 执行模块，缩小发布包执行面。
- 保留随包的 Anima `SKILL.md`、引用资料、工作流和模式 2 默认提示词作为只读静态内容。

## 0.5.1

- 修复已保存并测试通过的 LLM Profile 未自动关联模式 2，导致任务误报“没有选择有效 LLM Profile”。
- 连接测试成功后自动保存 Profile 并将其设为模式 2 使用；旧配置只有一个 Profile 时自动修复关联。

## 0.5.0

- 移除模式 3、Agent、Skill/Reference 管理和脚本执行入口；旧模式 3 自动迁移到模式 2。
- 增加首次打开自动出现的“宝宝配置教程”，使用模式 1、本机 ComfyUI 与内置 Anima API 工作流作为安全默认值。
- 教程可直接测试 ComfyUI、刷新节点/模型、定位设置并保存；之后可随时重新打开。
- 保留用户已有 ComfyUI、LLM Profile、工作流、预设和 Secret，不因更新恢复默认值。
- Git 安装/更新继续自动刷新页面；增强服务端可在任务空闲时热加载 0.5.0。
- 更新发布文档与测试，仅公开模式 1/2，并验证无重复界面和旧配置迁移。

## 0.4.0

- 增加 Git 下载后自动刷新即可使用的免重启浏览器运行时，不再要求首次执行安装命令或重启。
- 通过 SillyTavern 自带 ComfyUI/OpenAI-compatible 代理完成节点刷新、模式 1/2/3 和图片保存。
- 自动加载内置 Anima API 工作流、`anima-prompt` Skill 与 References；浏览器模式明确禁止本机脚本执行。
- 保留原服务端作为可选增强模式，用于 SecretManager、后台任务和可信 Skill 脚本。
- 生成图片先落盘至 SillyTavern 用户图片目录，避免把 Base64 写入聊天数据。

## 0.3.1

- 修复 Skill 管理卡片未显示内置 References/Scripts 数量的问题。
- 配置接口不再向前端暴露 SillyTavern SecretManager 的内部键名。
- 更新时尊重用户主动删除内置 `anima-prompt` Skill 的选择，不再自动恢复。
- 将运行环境声明与 SillyTavern 当前支持的 Node.js 18.17+ 对齐，并增加 Node 18 CI。

## 0.3.0

- 内置原 `anima-prompt` Skill、References、Scripts 与默认提示词，新用户首次启动自动安装并选中。
- 附带 Anima API/ComfyUI 普通版两套工作流；API 版自动导入并配置提示词、负面词、输出节点和快捷参数。
- 修复 Git 安装后复制第二份前端导致重复界面的问题，并增加首次服务端安装引导。
- ComfyUI 测试/节点刷新现在保存并使用输入框当前配置；未保存的 LLM Profile 可直接刷新模型。
- Profile 与模式 token/超时限制共同生效，Agent 总超时可中止进行中的 LLM/脚本调用。
- 将旧内置 Anima 工作流的失效 UNet 文件名原地迁移到 `anima-aesthetic-v1.1.safetensors`，不创建重复工作流。
- 增加内置资源、设置映射、重复界面、Git 安装布局和真实 ComfyUI 验收。

## 0.2.2

- 移除 Anima 多人 Prompt 的 `BREAK` 数量和位置检查。
- 缺少 `BREAK` 不再触发 LLM 格式修复、警告或任务失败；已有 `BREAK` 仍作为可选标记保留。

## 0.2.1

- 修复 Anima 总人数与角色块重复人数标签被重复计数的问题。
- Mode 2 的 `BREAK` 修复仍失败时继续出图并保存可见警告。
- 模式 3 自动载入完整所选 `SKILL.md`，大型引用仍按需读取。
- 本地 Skill 脚本内容变化时自动撤销已有执行信任。

## 0.2.0

- 增加稳定服务端引导器、版本化运行目录和任务空闲时热切换。
- 保留既有用户配置，并支持一次性自动发现相邻安装的 `anima-prompt` Skill。
- Mode 2/3 无需 `<image>` 标签；模式 1 保留显式标签。
- Mode 2 使用纯文本正向 Prompt，隔离推理内容，并改善 Anima 多人 `BREAK` 修复与警告。
- 增加 Prompt 连贯性历史、动态 ComfyUI 参数、随机 seed、画师串和消息图片 Prompt 展示。
- 完善公开安装、安全、开发文档和自动化测试。
