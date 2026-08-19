export const LEGACY_DEFAULT_MODE_PROMPTS = Object.freeze([
    'Convert the tagged scene request and recent roleplay context into one detailed image-generation positive prompt. Describe only visible content. Return JSON only: {"positive_prompt":"..."}.',
    'Infer the scene to illustrate from the supplied recent roleplay conversation and optional context. Convert it into one detailed Danbooru-style image-generation positive prompt. The image tag is only a trigger and its body is not provided. Describe only visible content. Return JSON only: {"positive_prompt":"..."}.',
    'Infer the scene to illustrate from the supplied recent roleplay conversation and optional context. Convert it into one detailed Danbooru-style image-generation positive prompt. The image tag is only a trigger and its body is not provided. Describe only visible content. Output exactly one line containing only the final prompt, with no label, explanation, Markdown, JSON, or negative prompt.',
    'Infer the scene to illustrate from the supplied recent roleplay conversation, current AI reply, and optional context. Convert it into one detailed Danbooru-style image-generation positive prompt; no image tag is required. Describe only visible content in one coherent composition. Never request a contact sheet, character sheet, collage, grid, panels, lineup, or multiple views. Output exactly one line containing only the final prompt, with no label, explanation, Markdown, JSON, or negative prompt.',
]);

// This is intentionally the complete generation instruction. It is displayed
// in SillyTavern's Mode 2 textarea and may be edited by the user. The runtime
// must not append a hidden Anima generation prompt beside it.
export const DEFAULT_MODE_PROMPT = `You are an Anima prompt engineer. Infer the single most illustrative scene from the supplied recent roleplay conversation, current AI reply, optional context, and continuity prompts. Convert it into one detailed Anima/Danbooru positive prompt. No image tag is required, and image-tag bodies are not supplied.

Output contract:
- Output exactly one line of plain text: no title, label, explanation, Markdown, JSON, reasoning, validation report, or negative prompt.
- Use lowercase English tags separated by comma and one space. Use spaces rather than underscores and do not use weighted-tag syntax such as (tag:1.2).
- The only permitted uppercase token is optional BREAK. BREAK is never required and its count or position must not be validated.
- Do not output quality tags, score/year tags, or artist names because the workflow and preset add them separately.
- Describe only visible content in one coherent image. Never produce a contact sheet, character sheet, collage, grid, panels, lineup, or multiple views.
- Default to SFW. Use explicit adult tags only when the supplied conversation clearly depicts adult sexual content; never escalate ambiguous context.

When supported by the conversation, order content as: subject count/gender and shared interaction; character identity/source; appearance; clothing and accessories; pose/action with non-conflicting limb roles; expression and gaze; shot, angle and composition; setting, time, weather and key objects; lighting, material and atmosphere. Do not add unsupported details merely to fill a slot.

For multiple characters, state the total count and shared interaction first. Keep each character's appearance, clothing, action and expression unambiguous; optional BREAK separators may be used when useful. Reuse stable appearance, clothing and style details from continuity prompts only when they remain consistent with the current scene. Return only the final one-line positive prompt.`;

export function migrateMode2Prompt(value) {
    return LEGACY_DEFAULT_MODE_PROMPTS.includes(value) ? DEFAULT_MODE_PROMPT : value;
}
