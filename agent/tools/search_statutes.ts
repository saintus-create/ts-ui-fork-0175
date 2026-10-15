import { defineTool } from "eve/tools";
import { z } from "zod";
import { CODE_NAMES, codesFor, loadCode } from "../lib/corpus";
import { fuseEmbeddings, hybridRetrieve, interpretQuery, screenDocs } from "../lib/retrieval";

function extractCodeHints(queries: string[]): string[] {
  const text = queries.join(" ").toLowerCase();
  const hints = new Set<string>();

  for (const [phrase, abbr] of [
    ["family code", "FAM"], ["penal code", "PEN"], ["civil code", "CIV"],
    ["code of civil procedure", "CCP"], ["government code", "GOV"],
    ["insurance code", "INS"], ["education code", "EDC"], ["evidence code", "EVID"],
    ["welfare and institutions code", "WIC"], ["business and professions code", "BPC"],
    ["health and safety code", "HSC"], ["revenue and taxation code", "RTC"],
    ["vehicle code", "VEH"], ["water code", "WAT"], ["labor code", "LAB"],
    ["elections code", "ELEC"], ["probate code", "PROB"], ["corporations code", "CORP"],
    ["financial code", "FIN"], ["commercial code", "COM"], ["food and agricultural code", "FAC"],
    ["fish and game code", "FGC"], ["public resources code", "PRC"],
    ["public utilities code", "PUC"], ["public contract code", "PCC"],
    ["streets and highways code", "SHC"], ["harbors and navigation code", "HNC"],
    ["military and veterans code", "MVC"], ["unemployment insurance code", "UIC"],
  ] as const) {
    if (text.includes(phrase)) hints.add(abbr);
  }

  for (const q of queries) {
    for (const token of q.match(/\b[A-Z]{2,5}\b/g) || []) {
      if (Object.prototype.hasOwnProperty.call(CODE_NAMES, token)) hints.add(token);
    }
  }

  return [...hints];
}

export default defineTool({
  description:
    "Search the complete California Codes (all 29 codes + the Constitution, every section with full text and legislative history). " +
    "Runs a multi-stage retrieval pipeline: it interprets the question, ranks sections by BM25 content match fused with metadata " +
    "(code hints, recency, repealed status, definitional language), enriches the query with discriminative terms mined from the " +
    "first-pass results (an inspectable second pass), reranks the top candidates, and can screen results with natural-language criteria. " +
    "Set mode='keyword' for a reproducible literal-term search with no enrichment. " +
    "Use this FIRST for any California law question. Returns numbered statute sources like [1], [2] to cite inline.",
  inputSchema: z.object({
    queries: z.array(z.string().min(2)).min(1).max(4).describe("Search phrases — the question's key terms"),
    codes: z.array(z.string()).optional().describe("Optional code abbreviations to prioritize, e.g. [\"CIV\", \"CCP\"]"),
    limit: z.number().int().min(4).max(24).optional(),
    mode: z.enum(["hybrid", "keyword"]).optional().describe("hybrid (default) enables query enrichment + fusion; keyword is literal and reproducible"),
    screen: z
      .object({
        include: z.array(z.string()).optional(),
        exclude: z.array(z.string()).optional(),
      })
      .optional()
      .describe("Natural-language screening criteria applied to the retrieved set (e.g. include ['penalties'], exclude ['repealed'])"),
  }),
  async execute({ queries, codes, limit, mode, screen }) {
    const explicit = codesFor(codes);
    const hints = codes?.length ? [] : extractCodeHints(queries);
    const inferred = hints.length ? hints : undefined;
    const abbrs = codes?.length ? explicit : (inferred || ["FAM", "CCP", "PEN", "CIV", "GOV", "WIC", "EVID"]);

    const records = (await Promise.all(
      abbrs.map(async (abbr) => {
        const rows = await loadCode(abbr).catch(() => []);
        return rows.map((r) => ({ abbr, r: r as unknown as Record<string, unknown> }));
      }),
    )).flat();

    // Stage 1 — question interpretation
    const plan = interpretQuery(queries.join(" ; "), { codes, mode: mode || "hybrid" });

    // Stages 2–4 — hybrid BM25 retrieval, query enrichment, reranking
    const { docs, expandedTerms, stats } = hybridRetrieve(records, plan, {
      limit: limit ?? 16,
      expand: plan.mode === "hybrid",
    });

    // Stage 5 — natural-language screening
    const screened = screen ? screenDocs(docs, screen) : docs;

    // Optional dense fusion (no-op unless an embedding endpoint is configured)
    const finalDocs = await fuseEmbeddings(screened, queries.join(" "));

    if (!finalDocs.length) {
      return {
        sources: [],
        note: screen
          ? "No matching statutes survived screening. Try different terms or loosen the criteria."
          : "No matching statutes found. Try different terms.",
        ...(expandedTerms.length ? { expanded_terms: expandedTerms } : {}),
      };
    }

    return {
      note:
        "Multi-stage retrieval (interpret → hybrid BM25 + metadata → query enrichment → rerank → screen). " +
        "Cite these inline with their bracketed markers, e.g. [1] or [2], right after the sentence each supports.",
      pipeline: {
        mode: plan.mode,
        intent: plan.intent,
        scanned: stats.scanned,
        candidates: stats.candidates,
        reranked: stats.reranked,
        ...(expandedTerms.length ? { expanded_terms: expandedTerms } : {}),
      },
      sources: finalDocs.map((h, i) => ({
        marker: `[${i + 1}]`,
        citation: String(h.r.citation || "") + (h.r.repealed ? " (REPEALED)" : ""),
        code: (CODE_NAMES[h.abbr] || h.abbr) + " (" + h.abbr + ")",
        text: String(h.r.text || "").slice(0, 1600),
        score: h.score,
        signals: h.signals,
        ...(h.matchedExpansion.length ? { matched_expansion: h.matchedExpansion } : {}),
        ...(h.r.history ? { legislative_history: String(h.r.history).slice(0, 200) } : {}),
      })),
    };
  },
});
