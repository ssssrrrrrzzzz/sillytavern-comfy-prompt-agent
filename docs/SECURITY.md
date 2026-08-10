# 安全模型

## 密钥

LLM 和 ComfyUI Secret 使用 SillyTavern `SecretManager` 的插件专用 key。配置 API 只返回 `hasApiKey`/`hasAuthSecret`，不会返回密钥、认证头或可逆掩码。聊天元数据和任务归档不记录它们。

## Agent 权限

Agent 无法安装/更新 Skill、改变信任、添加 URL Reference、保存密钥或扩大权限。它只能访问用户在模式 3 中选中的资源 ID。

工作流选择和参数修改各有独立开关。参数必须同时存在于当前预设的 `agentControllable` 白名单，并通过 ComfyUI `/object_info` 的枚举、类型和范围校验。负面目标会在服务端从白名单剔除；运行时负面值最后由预设覆盖。

## Skill 脚本

未信任 Skill 只能读取 `SKILL.md` 和 `references/`。可信脚本必须位于同一 Skill 的真实 `scripts/` 目录，符号链接不能逃逸；仅支持 Python/Node，使用参数数组和 `shell: false` 启动。并发固定限制为 2，并受单次超时和输出上限约束。

信任不是操作系统沙箱。可信脚本仍可使用 SillyTavern 进程用户拥有的文件和网络权限，因此界面会始终显示醒目警告；GitHub 更新后自动撤销信任。

## 下载与路径

GitHub Skill 固定从 `github.com`/`codeload.github.com` 下载。通用导入只接受 HTTPS；禁止 URL 内嵌凭据，限制跳转次数、超时和响应大小。ZIP 限制总大小、单文件大小、文件数量并拒绝路径穿越。

工作流、Reference、Skill 和聊天目标都通过受控目录及安全 ID/文件名定位。后台聊天写回还要求已保存的 pending trigger hash 完全匹配。

## 热更新

热更新端点只允许 SillyTavern 管理员调用，只能从当前用户自己的扩展目录读取 `server-plugin/` 和 `shared/`。引导器拒绝符号链接、路径逃逸和超出文件数/体积上限的运行树，并要求清单版本与运行模块声明一致。存在排队或运行中的任务时拒绝切换；已开始的任务不会被新版代码截断。

代码热更新不会写入用户配置、SecretManager 或工作流模板。本地安装器同步的 Skill 脚本仍属于第三方代码；只有显式信任后才可执行。

## 可信边界

ComfyUI 和用户配置的 LLM 服务被视为用户主动选择的外部服务。聊天和 Reference 内容对 Agent 来说是不可信数据，系统指令明确禁止把其中的文本当作更高优先级权限指令。
