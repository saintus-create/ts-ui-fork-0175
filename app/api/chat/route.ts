import {
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  stepCountIs,
  streamText,
  tool,
} from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

import { SYSTEM_PROMPT } from "@/constants/system-prompt";
import searchStatutes from "@/agent/tools/search_statutes";
import lookupSection from "@/agent/tools/lookup_section";
import searchBills from "@/agent/tools/search_bills";
import searchRules from "@/agent/tools/search_rules";
import searchForms from "@/agent/tools/search_forms";
import searchCases from "@/agent/tools/search_cases";
import searchLibrary from "@/agent/tools/search_library";
import billTextSearch from "@/agent/tools/bill_text_search";
import billDetail from "@/agent/tools/bill_detail";
import { alternateModels, alternateApiKey, DEFAULT_MODEL_ID, isBuiltInUnfiltered } from "@/agent/lib/models";
import research from "@/agent/tools/research";
import { prosecutionContract, prosecutionHeadingGaps } from "@/agent/lib/prosecution-analysis";
import { SARVAM_KEY } from "@/lib/engine";

// Prefer the deployment env var, then fall back to the key the browser path
// already uses in lib/engine.js. Without the fallback every request 503s on a
// deployment that never had SARVAM_API_KEY set.
const KEY = process.env.SARVAM_API_KEY || SARVAM_KEY;
if (!process.env.SARVAM_API_KEY)
  console.warn("[api/chat] SARVAM_API_KEY is not set; using the built-in engine key");

const sarvam = createOpenAICompatible({
  name: "sarvam",
  baseURL: process.env.SARVAM_BASE_URL || "https://api.sarvam.ai/v1",
  apiKey: KEY || "",
  headers: KEY ? { "api-subscription-key": KEY } : {},
});

// per-model provider cache for alternate (OpenAI-compatible) endpoints
const providerCache = new Map<
  string,
  ReturnType<typeof createOpenAICompatible>
>();

function resolveModel(requested: string | undefined): {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  provider: ReturnType<typeof createOpenAICompatible>;
  modelId: string;
} {
  if (requested) {
    const alt = alternateModels().find((m) => m.id === requested);
    if (alt) {
      const key = alternateApiKey(alt);
      if (key) {
        let provider = providerCache.get(alt.id);
        if (!provider) {
          provider = createOpenAICompatible({
            name: alt.id,
            baseURL: alt.apiBase,
            apiKey: key,
            headers: {
              ...(alt.headers || {}),
              ...(alt.apiBase.includes("sarvam.ai")
                ? { "api-subscription-key": key }
                : {}),
            },
          });
          providerCache.set(alt.id, provider);
        }
        return { provider, modelId: alt.model };
      }
    }
  }
  return { provider: sarvam, modelId: DEFAULT_MODEL_ID };
}

type SourceMap = Map<string, string>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type StreamPart = { type: string; [k: string]: any };

function normalizeMarker(marker: string) {
  return marker.replace(/[\[\]\s]/g, "").toLowerCase();
}

function statuteUrl(code: unknown, citation: string): string | null {
  // Statute sources may carry code like "Penal Code (PEN)", or a citation like
  // "CIV § 2987" — either way, build a library deep-link into the code browser.
  const abbrFromCode =
    typeof code === "string" ? code.match(/\(([A-Z]{2,5})\)\s*$/) : null;
  const abbrFromCitation = citation.match(/^([A-Z]{2,5})\s+§/);
  const section = citation.match(/§\s*([0-9A-Za-z][0-9A-Za-z.]*)/);
  const abbr = abbrFromCode || abbrFromCitation;
  if (!abbr || !section) return null;
  return `/codes?code=${abbr[1]}&section=${encodeURIComponent(section[1])}`;
}

function recordSources(out: unknown, map: SourceMap, urls?: Map<string, string>) {
  const sources = (out as { sources?: unknown })?.sources;
  if (!Array.isArray(sources)) return;
  for (const s of sources) {
    if (!s || typeof s !== "object") continue;
    const item = s as Record<string, unknown>;
    if (typeof item.marker !== "string") continue;
    const key = normalizeMarker(item.marker);
    if (!key || map.has(key)) continue;
    const citation = typeof item.citation === "string" ? item.citation : "";
    const rule = typeof item.rule === "string" ? item.rule : "";
    const measure = typeof item.measure === "string" ? item.measure : "";
    const caseName = typeof item.caseName === "string" ? item.caseName : "";
    const cite = typeof item.cite === "string" ? item.cite : "";
    const status = typeof item.status === "string" ? item.status : "";
    const label = citation || rule || measure || caseName;
    if (label) {
      map.set(key, label + (cite && caseName ? ` (${cite})` : "") + (status && measure ? ` · ${status}` : ""));
      // Judicial Council forms deep-link to the official fillable PDF; statutes
      // deep-link into the local code browser.
      const pdfUrl = typeof item.pdf_url === "string" ? item.pdf_url : "";
      const url = citation ? statuteUrl(item.code, citation) : null;
      if (urls) {
        if (pdfUrl) urls.set(key, pdfUrl);
        else if (url) urls.set(key, url);
      }
    }
  }
}

function recordPropositions(
  record: Awaited<ReturnType<typeof research.execute>>,
  map: SourceMap,
  urls?: Map<string, string>,
) {
  for (const p of record.propositions || []) {
    const proposition = p as { proposition_id: string; source_ids: string[]; statement: string };
    const source = (record.sources || []).find((s) => proposition.source_ids.includes(s.source_id));
    if (!source) continue;
    map.set(normalizeMarker(proposition.proposition_id), source.citation || source.title || source.marker);
    const inherited = urls?.get(normalizeMarker(source.marker || ""));
    if (inherited) urls?.set(normalizeMarker(proposition.proposition_id), inherited);
  }
}

function lastUserQuestion(messages: any[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role !== "user") continue;
    return (m.parts ?? [])
      .filter((p: { type?: string }) => p?.type === "text")
      .map((p: { text?: string }) => p.text || "")
      .join(" ")
      .trim();
  }
  return "";
}

// Record markers always carry a letter prefix (p1, s2, c3, g4). A bare number
// like [2] is a formatting slip, not a citation — treating it as one rejected
// otherwise-correct answers and made the app hold them back.
const CITED_RE = /\[\s*([a-z]{1,2}\d{1,3})\s*\]/gi;
// non-global variant for per-paragraph .test() checks
const CITED_ONE_RE = /\[\s*[a-z]{1,2}\d{1,3}\s*\]/i;

function researchBlock(record: Awaited<ReturnType<typeof research.execute>>): string {
  // The model's context window is 32k tokens. Serialising every proposition with
  // its full 1,200-char passage blew past it (~100 sources = ~32k tokens alone),
  // and the provider rejected the whole request — which surfaced to the user as a
  // held-back or empty answer. Budget the block instead of trusting the record's
  // size: passages are trimmed, and once the budget is spent the remaining
  // propositions are summarised rather than silently dropped.
  const PASSAGE_CHARS = 500;
  const BLOCK_CHAR_BUDGET = 60000; // ~15k tokens, leaving room for the 6k output
  let used = 0;
  let omitted = 0;
  const propositionLines: string[] = [];

  for (const p of record.propositions) {
    const source = (record.sources || []).find((s) => p.source_ids.includes(s.source_id));
    const line = source
      ? [
          `${p.proposition_id} [source: ${source.marker}] status=${p.status} type=${source.authority_type}`,
          `citation=${source.citation}; title=${source.title}; date=${source.date ?? "unknown"}; status=${source.status ?? "unknown"}`,
          `verification=${source.verification}; jurisdiction=${source.jurisdiction}; passage=${String(source.relevant_passage || "").slice(0, PASSAGE_CHARS)}`,
          `statement=${p.statement}`,
        ].join(" | ")
      : `${p.proposition_id} [source: ${p.source_ids.join(", ")}] status=${p.status}: ${p.statement}`;

    if (used + line.length > BLOCK_CHAR_BUDGET) {
      omitted += 1;
      continue;
    }
    used += line.length;
    propositionLines.push(line);
  }

  if (omitted) {
    propositionLines.push(
      `(${omitted} further propositions were retrieved but omitted here for length. Cite only the ids above.)`,
    );
  }

  const chronologyLines = record.chronology.map((c) =>
    `${c.event_id} ${c.date ?? "unknown"} ${c.event}: ${c.description} (source ${c.source_id})`,
  );

  const gapLines = record.evidence_gaps.map((g) =>
    `${g.gap_id} status=${g.status}; required=${g.required_authority}; ${g.issue} WHY: ${g.why_it_matters} SEARCH: ${g.search_queries.join(" | ")}` ,
  );

  return [
    "MANDATORY RESEARCH RECORD — VERSION 2.0 — COMPACT EVIDENCE LEDGER",
    "Use only the propositions below for substantive legal/factual claims.",
    `Question: ${record.question}` ,
    `Mode: ${record.mode}` ,
    "ISSUE:",
    JSON.stringify(record.issue),
    "",
    "PROPOSITIONS — CITE THESE IDS INLINE:",
    ...(propositionLines.length ? propositionLines : ["No propositions were retrieved."]),
    "",
    "CHRONOLOGY:",
    ...(chronologyLines.length ? chronologyLines : ["None recorded."]),
    "",
    "EVIDENCE GAPS:",
    ...(gapLines.length ? gapLines : ["None recorded."]),
    "",
    "SYNTHESIS REQUIREMENTS:",
    ...record.synthesis_requirements.map((x) => `- ${x}`),
    "",
    "ANSWER CONTRACT:",
    "- Every substantive legal/factual proposition MUST cite a proposition ID such as [p1].",
    "- Proposition citations must directly support the sentence that uses them.",
    "- Do not invent holdings, dates, statutory history, procedural facts, or source contents.",
    "- When a gap remains open, explicitly state that the point is unverified.",
  ].join("\n");
}
function validateSynthesis(text: string, record: Awaited<ReturnType<typeof research.execute>>, question: string) {
  const valid = new Set(record.propositions.map((p) => normalizeMarker(p.proposition_id)));
  for (const s of record.sources) valid.add(normalizeMarker(s.marker));
  // Evidence-gap ids (g1, g2, ...) are part of the record, and the prompt asks
  // the model to disclose open gaps by reference. Without registering them here
  // any answer that honestly flags a gap is rejected as an unknown citation and
  // the user gets the hold-back message instead of the answer.
  for (const g of record.evidence_gaps) valid.add(normalizeMarker(g.gap_id));

  const citations = Array.from(text.matchAll(CITED_RE)).map((m) => normalizeMarker(m[1]));
  const unknown = citations.filter((c) => !valid.has(c));
  const unknownU = [...new Set(unknown)];
  if (unknownU.length) return { ok: false, reason: `Unknown evidence citation(s): ${unknownU.join(", ")}` };

  const gapsOpen = record.evidence_gaps.some((g) => g.status === "open");
  const hasEvidenceCitation = citations.some((c) => valid.has(c));
  const substantive = text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p && !/^#{1,6}\s/.test(p))
    .filter((p) => !/^(research plan|authorities|followups|sources)\s*:/i.test(p));

  if (substantive.length && !hasEvidenceCitation) {
    return { ok: false, reason: "The response contains substantive text but no verified evidence citation." };
  }

  // Require evidence citations on substantive paragraphs. This is deliberately
  // conservative: it blocks generic uncited legal exposition from escaping the API.
  const uncited = substantive.filter((paragraph) => {
    if (/^(i can|i'm sorry|i cannot|i don't have|unverified|insufficient evidence)/i.test(paragraph)) return false;
    return !CITED_ONE_RE.test(paragraph);
  });
  CITED_RE.lastIndex = 0;

  if (uncited.length) {
    // Quote the offending paragraph so the repair pass can target it directly.
    const sample = uncited[0].replace(/\s+/g, " ").slice(0, 220);
    return {
      ok: false,
      reason: `Uncited substantive paragraph detected (${uncited.length}). Offending paragraph: "${sample}"`,
    };
  }

  // Disclosing a gap is a matter of wording, so accept any phrasing that flags
  // it. The old four-phrase list rejected answers that plainly said the point
  // was not in the record. Citing a gap id counts as disclosure too.
  const disclosed =
    /unverified|not verif|cannot be verified|insufficient evidence|not established|does not establish|does not (?:contain|address|resolve|disclose|provide)|not addressed|no (?:case )?authority|remains? (?:open|unresolved)|unresolved|absent from the record|not (?:reproduced|present|included) in the (?:research )?record/i.test(
      text,
    ) ||
    citations.some((c) =>
      record.evidence_gaps.some((g) => normalizeMarker(g.gap_id) === c),
    );
  if (gapsOpen && !disclosed) {
    return { ok: false, reason: "The research record contains open evidence gaps, but the answer does not disclose an unresolved gap." };
  }

  return { ok: true, reason: "" };
}

/** Wrap a finished string in the same UI message stream the client expects. */
function textStreamResponse(finalText: string) {
  const stream = new ReadableStream<StreamPart>({
    start(controller) {
      const id = "law-" + Math.random().toString(36).slice(2, 10);
      controller.enqueue({ type: "text-start", id });
      controller.enqueue({ type: "text-delta", id, delta: finalText });
      controller.enqueue({ type: "text-end", id });
      controller.enqueue({ type: "finish", finishReason: "stop" });
      controller.close();
    },
  });
  const uiStream = createUIMessageStream({ execute: ({ writer }) => writer.merge(stream as any) });
  return createUIMessageStreamResponse({ stream: uiStream });
}

/**
 * Answer without a language model: present the highest-ranked sections the
 * corpus returned, with their text and citations, and say plainly that this is
 * retrieval rather than synthesis.
 */
function retrievalOnlyAnswer(
  question: string,
  record: Awaited<ReturnType<typeof research.execute>> | null,
): string {
  const sources = (record?.sources || []).slice(0, 6);
  if (!sources.length) {
    return (
      "No matching California authority was found in the corpus for that question. " +
      "No language model is configured, so the answer cannot be synthesised — try different " +
      "terms, or browse the Codes directly at /codes."
    );
  }
  const body = sources
    .map((s, i) => {
      const heading = s.title && s.title !== s.citation ? `${s.citation} — ${s.title}` : s.citation;
      const passage = String(s.relevant_passage || "").trim().slice(0, 420);
      return `**${i + 1}. ${heading}**\n${passage}`;
    })
    .join("\n\n");
  const authorities = sources.map((s, i) => `[${i + 1}] ${s.citation}`).join("\n");
  return (
    "Here are the California authorities the corpus ranks highest for that question. " +
    "No language model is configured, so this is the retrieval result itself — the sections " +
    "and their text, cited — rather than a synthesised answer.\n\n" +
    `${body}\n\nAUTHORITIES:\n${authorities}`
  );
}

export const maxDuration = 300;

export async function POST(req: Request) {
  const { messages, model: requestedModel } = await req.json();
  const question = lastUserQuestion(messages);
  if (!question) return new Response("A research question is required.", { status: 400 });

  if (/^(?:(?:hi|hello|hey)(?:\s+there)?|good\s+(?:morning|afternoon|evening)|how\s+are\s+you|what(?:'s|\s+is)\s+up|thanks|thank\s+you)[.!?]*$/i.test(question.trim()) && question.trim().length <= 80) {
    const greeting = /^thank/i.test(question.trim())
      ? "You're welcome. What California law question can I help you with?"
      : "Hi! What California law question can I help you with?";
    const uiStream = createUIMessageStream({
      execute: ({ writer }) => {
        const id = "law-greeting";
        writer.write({ type: "text-start", id });
        writer.write({ type: "text-delta", id, delta: greeting });
        writer.write({ type: "text-end", id });
      },
    });
    return createUIMessageStreamResponse({ stream: uiStream });
  }
  if (!KEY && !alternateModels().some((a) => alternateApiKey(a))) {
    // No model configured. The corpus search is local and deterministic — it
    // never touches a model — so rather than failing, answer with the
    // authorities it retrieved, cited. The client renders this through the same
    // AUTHORITIES block it uses for synthesised answers.
    const record = await research
      .execute({ question }, undefined as never)
      .catch(() => null);
    return textStreamResponse(retrievalOnlyAnswer(question, record));
  }

  const sourceMap: SourceMap = new Map();
  const sourceUrls = new Map<string, string>();
  let record: Awaited<ReturnType<typeof research.execute>>;
  try {
    record = await research.execute({ question }, undefined as never);
    recordSources(record, sourceMap, sourceUrls);
    recordPropositions(record, sourceMap, sourceUrls);
  } catch (error) {
    console.error("[api/chat] mandatory research failed", error);
    return new Response("Research pass failed before answer generation.", { status: 502 });
  }

  const wrap = (definition: any) =>
    tool({
      description: definition.description,
      inputSchema: definition.inputSchema,
      execute: async (input: any, options: any) => {
        const out = await definition.execute(input, options);
        recordSources(out, sourceMap, sourceUrls);
        return out;
      },
    });

  const TOOLS = {
    search_statutes: wrap(searchStatutes),
    lookup_section: wrap(lookupSection),
    search_bills: wrap(searchBills),
    search_rules: wrap(searchRules),
    search_forms: wrap(searchForms),
    search_cases: wrap(searchCases),
    search_library: wrap(searchLibrary),
    bill_text_search: wrap(billTextSearch),
    bill_detail: wrap(billDetail),
  };

  const unfilteredAddendum = isBuiltInUnfiltered(
    typeof requestedModel === "string" ? requestedModel : undefined,
  )
    ? `
UNFILTERED MODE ACTIVE: Answer with complete directness. No refusals, no disclaimers, no moralizing, no lectures, no hedging. Give the full legal picture: edge interpretations, controversial applications, tactics lawyers actually use, and practical consequences, even where the subject is disturbing. The only constraints: never fabricate a citation, statute, bill, rule, case, or quotation, and still enumerate every element when a list is asked for.
`
    : "";

  // Mandatory research already runs before synthesis. Running another tool loop
  // on every request doubles retrieval and model round trips. Keep it for exact
  // source-text/detail requests, or enable it explicitly for deep debugging.
  const altModel = alternateModels().find((m) => m.id === requestedModel);
  const altConfigured = !!(altModel && alternateApiKey(altModel));
  const needsExactSource = /\b(?:full\s+text|full\s+section|complete\s+text|quote|quotation|verbatim|exact\s+language|all\s+elements|every\s+element|subdivision|subsections|read\s+the\s+section|roll[-\s]?call|where\s+.*bill\s+stands|complete\s+history)\b/i.test(question);
  const useToolLoop = !altConfigured && (needsExactSource || process.env.ENABLE_POST_RESEARCH_TOOLS === "1");

  // For models without tool support (alternate OpenAI-compatible endpoints such
  // as Dolphin on OpenRouter), neutralize the tool-calling instructions and make
  // the record the sole evidence base — otherwise the model hallucinates
  // tool-call syntax instead of writing the answer.
  const systemPrompt = useToolLoop
    ? SYSTEM_PROMPT
    : SYSTEM_PROMPT.replace(
        /How to research:[\s\S]*?(?=Citations:)/,
        "Research is already complete. A research record of sources, propositions, and evidence gaps is included below. Use ONLY that record. You cannot call, simulate, or request tools — never emit tool-call syntax, and do not describe searches you would run. Write the final answer now, citing the record's exact bracketed markers inline.\n\n",
      ).replace(
        /Call tools at most 7 times per answer \(across statutes, bills, and cases\), then write the final answer\. ?/,
        "",
      );

  const system = `${systemPrompt}${unfilteredAddendum}

${researchBlock(record)}

FINAL SYNTHESIS ENFORCEMENT:
The server will validate your completed answer before sending it to the user. An answer with unknown citations, uncited substantive paragraphs, or concealed open evidence gaps is rejected. Therefore, research first, cite the proposition that supports each substantive claim, and explicitly identify anything the record does not establish.
`;

  // We intentionally buffer the generated text until validation. Streaming an
  // invalid answer first would make a post-generation evidence gate meaningless.
  const modelMessages = await convertToModelMessages(messages);

  const generate = (extra = "") => streamText({
    model: (() => {
      const { provider, modelId } = resolveModel(
        typeof requestedModel === "string" ? requestedModel : undefined,
      );
      return provider(modelId);
    })(),
    system: system + extra,
    ...(useToolLoop
      ? {
          tools: TOOLS,
          stopWhen: stepCountIs(10),
          prepareStep: (() => {
            let step = 0;
            return () => {
              step += 1;
              return step >= 8 ? { toolChoice: "none" as const } : {};
            };
          })(),
        }
      : {
          // no tool loop on alternate models: cap the reserved output so
          // providers with small balances (OpenRouter prepay) accept the call
          maxOutputTokens: 6144,
        }),
    onError: (error) => {
      providerError = error;
      console.error(
        "[api/chat]",
        error,
        "| cause:",
        (error as { cause?: { message?: string } })?.cause?.message,
        "| last:",
        (error as { lastError?: { message?: string } })?.lastError?.message,
        "| lastCause:",
        (error as { lastError?: { cause?: { message?: string } } })?.lastError?.cause
          ?.message,
      );
    },
    messages: modelMessages,
  });

  // A provider failure (out of credits, rate limit, bad key) leaves the answer
  // empty. Without this the gate reports it as an unverifiable-answer problem,
  // which blames the research for what is actually an account problem — the app
  // told users "I wasn't able to verify this answer against the sources" when the
  // provider had simply refused the call. Say what actually happened instead.
  let providerError: unknown = null;

  let result = generate();
  let answer = "";
  for await (const part of result.textStream) answer += part;

  if (process.env.DEBUG_ANSWER) console.log('[debug] raw answer:\n' + answer.slice(0, 3000));
  let validation = validateSynthesis(answer, record, question);

  const providerFailed = !answer.trim() && !!providerError;
  if (providerFailed) {
    // The provider's own words live at different depths depending on whether the
    // failure came from the call, its cause, or the last retry — collect all of
    // them so a quota failure is recognised as one.
    const detail = [
      (providerError as { responseBody?: string })?.responseBody,
      (providerError as { cause?: { responseBody?: string } })?.cause?.responseBody,
      (providerError as { lastError?: { responseBody?: string } })?.lastError?.responseBody,
      (providerError as { lastError?: { cause?: { responseBody?: string } } })?.lastError?.cause
        ?.responseBody,
      (providerError as Error)?.message,
    ]
      .filter(Boolean)
      .join(" ");
    const quota = /insufficient_quota|no credits|quota/i.test(detail);
    console.error("[api/chat] provider failure (not an evidence failure):", detail.slice(0, 300));
    answer = quota
      ? "The model provider refused this request because the account has no credits available. " +
        "That is an account issue, not a research result — nothing was retrieved and nothing was held back. " +
        "Top up the provider account and ask again."
      : "The model provider could not complete this request. That is an infrastructure failure, not a research " +
        "result — nothing was held back for evidentiary reasons. Please try again.";
  }

  // Up to two bounded repair passes. The gate is strict by design, so give the
  // model a targeted second chance rather than serving nothing at all. Skipped
  // entirely when the provider itself failed: there is nothing to repair.
  for (
    let attempt = 0;
    !providerFailed && !validation.ok && attempt < 2 && !/^(simple|short|greeting)$/i.test(record.mode);
    attempt++
  ) {
    result = generate(`

REPAIR REQUIRED:
Your previous synthesis failed the evidence gate for this reason:
${validation.reason}
Produce a replacement answer, not commentary about the failure. Every paragraph — including any opening or framing sentence — must carry a valid bracketed record marker. If a sentence cannot be supported by any marker in the record, delete it rather than leaving it uncited. Do not use general knowledge to fill gaps. If an evidence gap remains open, explicitly say so. If this is a criminal-law question, include every required prosecution-grade section and explicitly separate probable cause from trial sufficiency.
`);
    answer = "";
    for await (const part of result.textStream) answer += part;
    validation = validateSynthesis(answer, record, question);
  }

  if (!providerFailed && !validation.ok) {
    console.error("[api/chat] evidence gate rejected answer", validation.reason);
    answer =
      "I wasn't able to verify this answer against the sources I retrieved, so I'm holding it back rather than risk an unsupported statement. " +
      "Try rephrasing, or narrow the question to a specific code or section and I'll build the answer from the text.";
  }

  const cited: string[] = [];
  const seen = new Set<string>();
  const re = new RegExp(CITED_RE.source, "gi");
  let m: RegExpExecArray | null;
  while ((m = re.exec(answer))) {
    const key = normalizeMarker(m[1]);
    if (!seen.has(key) && sourceMap.has(key)) {
      seen.add(key);
      cited.push(key);
    }
  }

  const cleanAnswer = answer.replace(/\n?\s*AUTHORITIES:\s*[\s\S]*$/i, "").replace(/\n?\s*FOLLOWUPS:\s*[\s\S]*$/i, "").trim();
  // Preserve the model's FOLLOWUPS block (client rewrites it into Keep digging pills).
  const followupMatch = answer.match(
    /(?:^|\n)\s*FOLLOWUPS:[ \t]*\n([\s\S]*?)(?=\n\s*AUTHORITIES:|$)/i,
  );
  const followupLines = followupMatch
    ? followupMatch[1]
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 3)
        .slice(0, 3)
    : [];
  const finalText = cleanAnswer +
    (cited.length
      ? "\n\nAUTHORITIES:\n" +
        cited
          .map((k) => {
            const label = sourceMap.get(k) || k;
            const url = sourceUrls.get(k);
            return url
              ? `[${k} ${label}](#law-authority:${url})`
              : `[${k}] ${label}`;
          })
          .join("\n")
      : "") +
    (followupLines.length
      ? "\n\nFOLLOWUPS:\n" + followupLines.map((l) => `- ${l.replace(/^[-*\d.)\s]+/, "").trim()}`).join("\n")
      : "");

  const stream = new ReadableStream<StreamPart>({
    start(controller) {
      const id = "law-" + Math.random().toString(36).slice(2, 10);
      controller.enqueue({ type: "text-start", id });
      controller.enqueue({ type: "text-delta", id, delta: finalText });
      controller.enqueue({ type: "text-end", id });
      controller.enqueue({ type: "finish", finishReason: "stop" });
      controller.close();
    },
  });

  const uiStream = createUIMessageStream({ execute: ({ writer }) => writer.merge(stream as any) });
  return createUIMessageStreamResponse({ stream: uiStream });
}
