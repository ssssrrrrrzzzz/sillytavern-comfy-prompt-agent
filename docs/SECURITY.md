# 安全模型

## 密钥

增强服务端通过 SillyTavern SecretManager 保存插件专用 LLM/ComfyUI Secret。免重启浏览器模式把密钥保存在当前用户扩展设置中；UI 只显示是否已保存，聊天元数据、任务结果和日志不记录密钥或认证头。分享用户数据前应先删除密钥。

## 模式和 Prompt 边界

只接受模式 1/2。模式 1 仅使用标签中的正向 Prompt；模式 2 LLM 只能返回一行正向 Prompt。负面 Prompt 总是由工作流预设提供。LLM 返回的 JSON、Markdown、解释文字、负面字段或只有思考内容会触发修复或明确失败，不会静默送入 ComfyUI。

标签正文会保留在 SillyTavern 消息中，但模式 2 的临时 LLM 上下文会移除全部标签及正文。`reasoning_content` 不参与图片 Prompt。

## 下载、路径和工作流

远程工作流只接受 HTTPS，禁止 URL 内嵌凭据，并限制超时和响应大小。所有工作流和聊天目标通过受控目录及安全 ID/文件名定位。运行前使用 `/object_info` 重新校验节点、枚举、类型和范围；节点连接不可由设置面板改写。

任务运行时深拷贝工作流模板，负面 Prompt 最后由预设写入。后台写回要求 chat、message、Swipe 和 pending trigger hash 完全匹配。

## 热更新

热更新只允许 SillyTavern 管理员调用，并只能从当前用户扩展目录读取 `server-plugin/` 和 `shared/`。引导器拒绝符号链接、路径逃逸和超限运行树，要求清单版本与模块版本一致；存在任务时拒绝切换。热更新不修改用户配置、SecretManager 或工作流模板。

## 可信边界

ComfyUI 和用户配置的 LLM 都是用户主动选择的外部服务。角色卡、Persona、世界书、系统提示和聊天内容只有在相应开关开启时才发送给模式 2 LLM。
