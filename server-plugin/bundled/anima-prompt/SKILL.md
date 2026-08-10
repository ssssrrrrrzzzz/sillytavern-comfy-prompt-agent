---
name: anima-prompt
description: 将中文或英文场景要求转换为 Anima 系列模型可用的一行英文正向提示词，并可校验标签冲突、重复、场景、光影与 SFW/NSFW 边界。用于 Anima 文生图、二次元标签转写、角色与场景提示词生成、现有 Anima prompt 检查；不用于通用自然语言 Stable Diffusion prompt 或负面提示词生成。
---

# Anima Prompt Engineer

将输入转换为一条可直接提交给 Anima 工作流的正向提示词。只描述画面中可见的内容，不生成或修改负面提示词。

## 输出契约

- 仅输出一行纯文本，不加标题、解释、Markdown、代码围栏或 JSON。
- 使用英文小写标签，以 `, ` 分隔；唯一允许的大写标记是 `BREAK`。
- 使用空格而不是下划线，不使用 `(tag:1.2)` 权重语法。
- 不输出质量词、年份/评分词或画师名；工作流负责这些内容。
- 生成一幅连贯构图，不生成 contact sheet、character sheet、collage、grid、panel、lineup 或 multiple views。
- 标签无法表达清楚的空间或角色关系，可在末尾补一条简短英文自然语言描述。

正确示例：

```text
1girl, solo, long black hair, blue eyes, school uniform, standing by window, looking outside, medium shot, classroom, morning sunlight
```

## 模式

- 默认使用 SFW 模式并运行 `check_prompt.py`。
- 输入明确包含成人性内容或明确要求 NSFW/R18 时，读取 `references/nsfw-primer.md`，并用 `check_prompt.py --nsfw` 校验。
- 不从含糊上下文自行升级为 NSFW。

## 槽位顺序

按以下顺序组装；不需要为了填满槽位而添加无关标签：

1. 人数、性别、角色名、作品来源与共享互动。
2. 外观：种族特征、头发、眼睛、体型。
3. 服装和配饰：从上到下，明确穿着或脱穿状态。
4. 姿势和动作：给每只手臂明确且不冲突的职责。
5. 表情和视线。
6. 镜头、景别、角度与构图。
7. 场景、时间、天气和关键物件。
8. 光影、材质、气氛与必要的自然语言关系描述。

复杂构图、服装细化、冲突或光影选择时按需读取 `references/reference.md`。需要颜文字时读取 `references/emoticon-reference.md`。完整示例见 `references/example.md`。

## 多角色格式

先写总人数与共享互动。需要强调角色边界时，可以选择用 `BREAK` 建立独立块：

```text
2girls, holding hands, black hair, red dress, smiling, BREAK, blonde hair, blue dress, looking at first girl, full body, garden, sunset
```

- `BREAK` 完全可选；不检查数量、位置或是否连续，缺少它也不是格式错误。
- 使用角色块时可按“外观 → 服装 → 动作 → 表情”排列。
- 共享镜头、场景和光影可放在角色描述之后。

## 工作流程

1. 从输入和最近上下文中选择当前最值得画的一幕，只保留可见内容。
2. 若出现明确角色/IP 专名，先运行：

   ```bash
   uv run scripts/resolve_cn_character.py "<中文名>" --json
   uv run scripts/character_lib.py search "<英文名>" --exact --limit 1 --json
   ```

   查询失败时保留用户提供的角色名，并用输入中明确的外观锚点补充；不要虚构查询结果。
3. 按槽位顺序生成标签；`BREAK` 只作为可选分隔符。
4. 成人场景只按需读取 `references/nsfw-primer.md`；命中特殊主题且确实需要细化时再读取 `references/special-themes.md`。
5. 运行校验：

   ```bash
   uv run scripts/check_prompt.py "<prompt>" --json
   uv run scripts/check_prompt.py "<prompt>" --nsfw --json
   ```

6. 根据 JSON 报告修正并重新校验，直到 `passed` 为 `true`。
7. 只返回最终一行正向提示词。思考、校验报告和工具输出都不得成为提示词的一部分。

若脚本不可执行，只能人工执行同等检查，并明确不能声称“脚本校验已通过”。

## 可用资源

- `scripts/check_prompt.py`：综合格式、NSFW、人数、冲突、重复、场景和光影校验。
- `scripts/check_nsfw.py`：单独检测显式 NSFW 标签。
- `scripts/resolve_cn_character.py`：中文角色名解析；联网查询需环境允许。
- `scripts/character_lib.py`：查询可选的 Danbooru 角色 CSV 和本地扩展角色库。
- `scripts/call_anima.py`：直接向 ComfyUI 提交随包工作流；在 SillyTavern 插件内由插件任务系统替代。
- `scripts/warehouse.py`：用户明确要求保存/搜索提示词时使用。
- `references/reference.md`：跨模式的构图、冲突和风格细化。
- `references/nsfw-primer.md`：仅成人模式加载的扩展规则。
- `references/special-themes.md`：仅在相关成人主题中按需加载。
- `references/emoticon-reference.md`：仅在需要颜文字/Emoji 控制时加载。
- `references/example.md`：完整流程示例。

## 依赖与可选数据

Python 3.10+；运行脚本前执行：

```bash
uv sync
```

`character_lib.py` 的完整角色搜索需要可选文件 `tag-library/danbooru_character.csv`。缺失时本地 `extra_characters.csv` 仍可使用；不要因此阻断普通提示词生成与校验。
