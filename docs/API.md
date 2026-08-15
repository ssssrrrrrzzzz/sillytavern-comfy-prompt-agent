# 增强服务端 API

统一前缀：`/api/plugins/comfy-prompt-agent`。接口使用 SillyTavern 当前用户身份和 CSRF 保护；普通 Git 安装由浏览器运行时提供同形接口，无需自定义后端。

## 配置与连接

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/health` | 当前/已安装版本、空闲与热更新状态 |
| POST | `/reload` | 管理员热加载已暂存版本 |
| POST | `/stage-update` | 从当前扩展目录暂存并热切换新版 |
| GET/PUT | `/config` | 获取或保存独立配置；不返回密钥 |
| PUT | `/config/mode` | 切换模式 1/2 |
| PUT | `/config/comfy` | 保存 ComfyUI 与队列配置 |
| POST | `/comfy/secret` | 保存或删除 ComfyUI Secret |
| POST | `/comfy/test` | 测试 ComfyUI |
| GET | `/comfy/object-info` | 读取 `/object_info` |
| POST | `/llm-profiles` | 新建/更新 Profile |
| POST | `/llm-profiles/test` | 用当前表单测试并刷新模型 |
| DELETE | `/llm-profiles/:id` | 删除 Profile 和专用 Secret |
| GET | `/llm-profiles/:id/models` | 获取模型列表 |
| GET | `/bundled/workflows` | 列出两种内置 Anima 工作流 |
| GET | `/bundled/workflows/:name` | 下载内置工作流 |

## 工作流

支持 `GET/POST /workflows`、`POST /workflows/upload`、`POST /workflows/url`、`POST /workflows/scan`、`GET/POST /workflows/sillytavern`、`GET/DELETE /workflows/:id`、`POST /workflows/:id/presets` 和 `DELETE /workflows/:id/presets/:presetId`。

## Jobs

`POST /jobs` 接收：

```json
{
  "mode": 2,
  "directive": "仅模式 1 使用的最终正向 Prompt",
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

模式 2 不需要标签，并会强制忽略 `directive`。服务端会从临时聊天上下文中移除所有 `<image>` 标签及正文，再按已保存的轮数和 token 上限裁剪。

创建返回 HTTP 202。查询：`GET /jobs/:id`；取消：`DELETE /jobs/:id`；最近任务：`GET /jobs`；估算上下文：`POST /jobs/estimate`。

完成结果包含正/负 Prompt、工作流与预设、最终节点参数、图片、LLM usage、上下文统计和格式警告；不包含密钥、认证头或思维链。
