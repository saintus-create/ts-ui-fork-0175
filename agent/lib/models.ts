/**
 * Model registry. The default is Sarvam 105B; additional models come from the
 * ALTERNATE_MODELS_JSON env var, each pointing at any OpenAI-compatible
 * endpoint (OpenRouter, Together, a local vLLM/Ollama server, ...):
 *
 * ALTERNATE_MODELS_JSON=[
 *   {"id":"llama-3.3-70b","name":"Llama 3.3 70B",
 *    "apiBase":"https://openrouter.ai/api/v1",
 *    "model":"meta-llama/llama-3.3-70b-instruct",
 *    "apiKeyEnv":"OPENROUTER_API_KEY"}
 * ]
 *
 * An alternate is only listed/served when its apiKeyEnv variable is set.
 */
export interface AlternateModel {
  id: string;
  name?: string;
  apiBase: string;
  model: string;
  apiKeyEnv?: string;
  headers?: Record<string, string>;
}

export const DEFAULT_MODEL_ID = "sarvam-105b-conversations";
export const DEFAULT_MODEL_NAME = "Sarvam 105B";

/**
 * Built-in "Unfiltered" model: an uncensored open-weight model (Dolphin
 * Mistral 24B Venice Edition) served through OpenRouter. It activates the
 * moment OPENROUTER_API_KEY is set; ALTERNATE_MODELS_JSON overrides it.
 */
const BUILT_IN_UNFILTERED: AlternateModel = {
  id: "unfiltered",
  name: "Unfiltered",
  apiBase: "https://openrouter.ai/api/v1",
  model: "cognitivecomputations/dolphin-mistral-24b-venice-edition",
  apiKeyEnv: "OPENROUTER_API_KEY",
  headers: { "X-Title": "California Legislative Information" },
};

export function alternateModels(): AlternateModel[] {
  try {
    const raw = process.env.ALTERNATE_MODELS_JSON;
    if (!raw) {
      return [BUILT_IN_UNFILTERED];
    }
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (m): m is AlternateModel =>
        !!m && typeof m === "object" && typeof m.id === "string" && typeof m.apiBase === "string" && typeof m.model === "string",
    );
  } catch {
    return [];
  }
}

export function alternateApiKey(alt: AlternateModel): string | undefined {
  const envName = alt.apiKeyEnv || "ALTERNATE_API_KEY";
  const v = process.env[envName];
  return v && v.length > 0 ? v : undefined;
}

export interface ServedModel {
  id: string;
  name: string;
  /** false when the model is configured but its API key env is missing */
  available: boolean;
}

/** Models configured on this server (used by /api/models). */
export function servedModels(): ServedModel[] {
  const out: ServedModel[] = [
    { id: DEFAULT_MODEL_ID, name: DEFAULT_MODEL_NAME, available: true },
  ];
  for (const alt of alternateModels()) {
    const builtIn = alt.id === BUILT_IN_UNFILTERED.id && !process.env.ALTERNATE_MODELS_JSON;
    out.push({
      id: alt.id,
      name: alt.name || alt.id,
      // the built-in Unfiltered always works: it upgrades to OpenRouter when the
      // key exists and otherwise runs in direct mode on the standard model
      available: builtIn || !!alternateApiKey(alt),
    });
  }
  return out;
}

/** true when the request asks for the built-in Unfiltered mode */
export function isBuiltInUnfiltered(requested: string | undefined): boolean {
  if (!requested || process.env.ALTERNATE_MODELS_JSON) return false;
  return requested === BUILT_IN_UNFILTERED.id;
}
