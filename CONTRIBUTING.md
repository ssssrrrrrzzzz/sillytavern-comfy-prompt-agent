# Contributing

请先阅读 `docs/DEVELOPMENT.md` 和 `docs/SECURITY.md`。修改应保持插件与 SillyTavern 聊天连接、内置 Image Generation 设置及用户数据相互独立。

提交前运行：

```bash
npm ci
npm run check
npm test
```

发布新版本时必须同步所有版本字段，且不能复用已经发布过的版本号。涉及 Skill 脚本信任、URL 下载、文件路径、Agent 参数或负面提示词的更改必须补充安全回归测试。
