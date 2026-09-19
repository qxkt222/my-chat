import type { ApiTemplate } from "@/types";
import openaiPreset from "./presets/openai.json";
import ollamaPreset from "./presets/ollama.json";
import deepseekPreset from "./presets/deepseek.json";
import geminiPreset from "./presets/gemini.json";
import wenxinPreset from "./presets/wenxin.json";
import tongyiPreset from "./presets/tongyi.json";
import claudePreset from "./presets/claude.json";
import mistralPreset from "./presets/mistral.json";
import coherePreset from "./presets/cohere.json";
import openrouterPreset from "./presets/openrouter.json";
import siliconflowPreset from "./presets/siliconflow.json";
import moonshotPreset from "./presets/moonshot.json";
import zhipuPreset from "./presets/zhipu.json";
import lingyiPreset from "./presets/lingyi.json";
import minimaxPreset from "./presets/minimax.json";
import groqPreset from "./presets/groq.json";

const now = new Date().toISOString();

export const BUILTIN_PRESETS: ApiTemplate[] = [
  { ...openaiPreset, created_at: now, updated_at: now } as ApiTemplate,
  { ...ollamaPreset, created_at: now, updated_at: now } as ApiTemplate,
  { ...deepseekPreset, created_at: now, updated_at: now } as ApiTemplate,
  { ...geminiPreset, created_at: now, updated_at: now } as ApiTemplate,
  { ...wenxinPreset, created_at: now, updated_at: now } as ApiTemplate,
  { ...tongyiPreset, created_at: now, updated_at: now } as ApiTemplate,
  { ...claudePreset, created_at: now, updated_at: now } as ApiTemplate,
  { ...mistralPreset, created_at: now, updated_at: now } as ApiTemplate,
  { ...coherePreset, created_at: now, updated_at: now } as ApiTemplate,
  { ...openrouterPreset, created_at: now, updated_at: now } as ApiTemplate,
  { ...siliconflowPreset, created_at: now, updated_at: now } as ApiTemplate,
  { ...moonshotPreset, created_at: now, updated_at: now } as ApiTemplate,
  { ...zhipuPreset, created_at: now, updated_at: now } as ApiTemplate,
  { ...lingyiPreset, created_at: now, updated_at: now } as ApiTemplate,
  { ...minimaxPreset, created_at: now, updated_at: now } as ApiTemplate,
  { ...groqPreset, created_at: now, updated_at: now } as ApiTemplate,
];

export function getPresetById(id: string): ApiTemplate | undefined {
  return BUILTIN_PRESETS.find((p) => p.id === id);
}

export function getPresetsByCategory(category: string): ApiTemplate[] {
  return BUILTIN_PRESETS.filter((p) => p.category === category);
}
