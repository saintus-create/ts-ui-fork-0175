import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText, stepCountIs, tool } from "ai";

import { SARVAM_KEY } from "@/lib/engine";
import { DEFAULT_MODEL_ID } from "./models";
import searchBills from "../tools/search_bills";
import searchCases from "../tools/search_cases";
import searchForms from "../tools/search_forms";
import searchLibrary from "../tools/search_library";
import searchRules from "../tools/search_rules";
import searchStatutes from "../tools/search_statutes";

/**
 * Two research agents that run concurrently.
 *
 * The record pre-pass used to be a hand-written task list, which is why a whole
 * source (Words and Phrases) could be in the corpus yet unreachable: nothing in
 * the plan ever named it. These agents instead choose their own tools and
 * queries within a step budget, which is the ordinary agentic-retrieval shape —
 * parallel workers over disjoint sources, merged before synthesis, with the
 * deterministic planner kept as the fallback when a worker fails.
 *
 * They do NOT decide the answer or the evidence standard. Their output feeds the
 * same record, and the same gate still validates the final answer.
 */

const KEY = process.env.SARVAM_API_KEY || SARVAM_KEY;

const sarvam = createOpenAICompatible({
  name: "sarvam",
  baseURL: process.env.SARVAM_BASE_URL || "https://api.sarvam.ai/v1",
  apiKey: KEY || "",
  headers: KEY ? { "api-subscription-key": KEY } : {},
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const wrap = (definition: any) =>
  tool({
    description: definition.description,
    inputSchema: definition.inputSchema,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    execute: async (input: any, options: any) => definition.execute(input, options),
  });

const AUTHORITY_TOOLS = {
  search_statutes: wrap(searchStatutes),
  search_bills: wrap(searchBills),
  search_rules: wrap(searchRules),
  search_forms: wrap(searchForms),
};

const MEANING_TOOLS = {
  search_cases: wrap(searchCases),
  search_library: wrap(searchLibrary),
};

const AUTHORITY_SYSTEM = `You are the authority researcher on a California legal-research team. Your only job is to gather the PRIMARY authority the question turns on — statutes, bills, Rules of Court, Judicial Council forms.

Work in 3 to 6 tool calls. Start with the statutory terms, then check bills for pending or recent amendments to the same act or topic, then rules or forms if the question is procedural or filing-related. Query with statutory topic terms, never the user's whole sentence. Do not answer the question and do not write prose — gather sources.`;

const MEANING_SYSTEM = `You are the meaning researcher on a California legal-research team. Your only job is to gather how the terms in the question are actually CONSTRUED — published opinions, and Words and Phrases entries from West's California Digest.

Work in 2 to 5 tool calls. Call search_library with the bare term or phrase the question turns on (a definition, a term of art, or a statutory word whose meaning is in dispute), and search_cases for how the courts have read the governing statute. The code states the rule; these show how the words in it have been applied. Do not answer the question and do not write prose — gather sources.`;

export type AgentRole = "authority" | "meaning";

export interface AgentSource {
  /** authority_type this raw result should be recorded as */
  authority: "statute" | "bill" | "rule" | "form" | "case" | "words_and_phrases";
  raw: Record<string, unknown>;
}

export interface AgentResult {
  role: AgentRole;
  sources: AgentSource[];
  toolsCalled: string[];
  error?: string;
}

const ROLE_AUTHORITY: Record<string, AgentSource["authority"]> = {
  search_statutes: "statute",
  search_bills: "bill",
  search_rules: "rule",
  search_forms: "form",
  search_cases: "case",
  search_library: "words_and_phrases",
};

export async function runResearchAgent(
  role: AgentRole,
  question: string,
  maxSteps = 6,
): Promise<AgentResult> {
  const tools = role === "authority" ? AUTHORITY_TOOLS : MEANING_TOOLS;
  const result = await generateText({
    model: sarvam(DEFAULT_MODEL_ID),
    system: role === "authority" ? AUTHORITY_SYSTEM : MEANING_SYSTEM,
    prompt: question,
    tools,
    stopWhen: stepCountIs(maxSteps),
  });

  const sources: AgentSource[] = [];
  const toolsCalled: string[] = [];
  for (const step of result.steps || []) {
    for (const call of step.toolResults || []) {
      const name = String((call as { toolName?: string }).toolName || "");
      if (name) toolsCalled.push(name);
      const out = (call as { output?: unknown }).output as { sources?: unknown } | undefined;
      const list = out && Array.isArray(out.sources) ? out.sources : [];
      for (const s of list) {
        if (s && typeof s === "object") {
          sources.push({
            authority: ROLE_AUTHORITY[name] || "statute",
            raw: s as Record<string, unknown>,
          });
        }
      }
    }
  }
  return { role, sources, toolsCalled };
}

/**
 * Run both agents concurrently. One failing must not sink the other: the caller
 * falls back to the deterministic planner for whatever came back empty.
 */
export async function runResearchAgents(question: string): Promise<AgentResult[]> {
  const settled = await Promise.allSettled([
    runResearchAgent("authority", question),
    runResearchAgent("meaning", question),
  ]);
  return settled.map((s, i) =>
    s.status === "fulfilled"
      ? s.value
      : {
          role: (i === 0 ? "authority" : "meaning") as AgentRole,
          sources: [],
          toolsCalled: [],
          error: String(s.reason).slice(0, 200),
        },
  );
}
