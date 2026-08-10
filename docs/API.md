# 增强服务端 API

统一前缀：`/api/plugins/comfy-prompt-agent`。所有接口使用 SillyTavern 当前用户身份和 CSRF 保护，数据彼此隔离。

普通 Git 安装不需要这些自定义路由：前端免重启运行时提供同形配置/任务接口，并调用 SillyTavern 自带的 `/api/sd/comfy/*`、`/api/backends/chat-completions/*` 和 `/api/images/upload`。本页描述的是可选增强服务端。

## 配置与连接

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/health` | 存活、当前/已暂存版本、空闲和热更新能力 |
| POST | `/reload` | 管理员在任务空闲时加载已暂存版本 |
| POST | `/stage-update` | 管理员从当前用户已安装扩展目录暂存并热切换新版运行代码 |
| GET/PUT | `/config` | 获取或保存独立配置（不返回密钥） |
| PUT | `/config/comfy` | 保存当前 ComfyUI 输入框连接/队列配置和可选 Secret |
| POST | `/llm-profiles` | 新建/更新 Profile，`apiKey` 可省略以保留旧值 |
| POST | `/llm-profiles/test` | 使用尚未保存的 Profile 表单刷新模型并测试 |
| DELETE | `/llm-profiles/:id` | 删除 Profile 及专用 Secret |
| GET | `/llm-profiles/:id/models` | 刷新模型列表并验证连接 |
| POST | `/llm-profiles/:id/test` | Profile 连接测试 |
| POST | `/comfy/secret` | 保存或删除 ComfyUI 认证 Secret |
| POST | `/comfy/test` | 调用 `/system_stats` |
| GET | `/comfy/object-info` | 代理读取 `/object_info` |
| GET | `/bundled/workflows` | 列出内置 Anima API/普通工作流 |
| GET | `/bundled/workflows/:name` | 下载指定内置工作流 |

## 工作流、Skill、Reference

工作流：`GET/POST /workflows`、`POST /workflows/upload`、`POST /workflows/url`、`POST /workflows/scan`、`GET/POST /workflows/sillytavern`、`GET/DELETE /workflows/:id`、`POST /workflows/:id/presets`、`DELETE /workflows/:id/presets/:presetId`。

Skill：`GET /skills`、`POST /skills/scan`、`POST /skills/upload`、`POST /skills/github`、`POST /skills/:id/update`、`PUT /skills/:id/trust`、`DELETE /skills/:id`。

Reference：`GET/POST /references`、`POST /references/upload`、`POST /references/url`、`GET/PUT/DELETE /references/:id`。

## Jobs

`POST /jobs` 接收：

```json
{
  "mode": 3,
  "directive": "仅模式 1：最终 Danbooru 正面提示词",
  "triggerHash": "幂等 hash",
  "conversation": [{"role":"user","content":"..."},{"role":"assistant","content":"..."}],
  "previousPrompts": ["此前由插件生成的正向 Prompt"],
  "extras": {
    "characterCard": "可选",
    "persona": "可选",
    "systemPrompt": "可选",
    "worldBook": "可选"
  },
  "workflowId": "workflow_id",
  "presetId": "preset_id",
  "target": {
    "isGroup": false,
    "chatId": "chat file name",
    "avatar": "character.png",
    "messageIndex": 12,
    "swipeId": 0
  }
}
```

`directive` 只在模式 1 使用。模式 2/3 不需要标签，服务端会强制丢弃 `directive`，并从所有聊天消息中移除任何已有 `<image>` 标签及其正文。

服务端会根据当前保存配置再次执行轮数/token 裁剪、权限校验和工作流参数校验。返回 HTTP 202：

```json
{"id":"job_uuid","status":"queued","stage":"queued"}
```

查询：`GET /jobs/:id`；取消：`DELETE /jobs/:id`；最近任务：`GET /jobs`；只估算上下文：`POST /jobs/estimate`。

完成结果包含 `positivePrompt`、实际预设 `negativePrompt`、工作流 ID/名称/hash、预设、最终非连接节点快照、图片、上下文统计、Agent step、工具调用摘要和 `promptWarnings`。密钥、认证头和完整内部请求不会出现在结果中。
