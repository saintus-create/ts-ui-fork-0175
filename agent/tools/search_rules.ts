import { defineTool } from "eve/tools";
import { z } from "zod";
import { loadJsonl } from "../lib/corpus";
import { hybridRetrieve, interpretQuery, screenDocs } from "../lib/retrieval";

export default defineTool({
  description:
    "Search the California Rules of Court (all 1,501 rules, full text) — procedural rules for trial and appellate courts. " +
    "Runs the same multi-stage retrieval pipeline as search_statutes: question interpretation, BM25 ranking fused with metadata, " +
    "query enrichment, and reranking; a named rule number (e.g. 'rule 3.1300') is matched exactly. " +
    "Use for questions about procedure, deadlines, filings, continuances, service. Returns rule sources like [r1], [r2] to cite inline.",
  inputSchema: z.object({
    queries: z.array(z.string().min(2)).min(1).max(4),
    limit: z.number().int().min(3).max(10).optional(),
    mode: z.enum(["hybrid", "keyword"]).optional(),
    screen: z
      .object({ include: z.array(z.string()).optional(), exclude: z.array(z.string()).optional() })
      .optional(),
  }),
  async execute({ queries, limit, mode, screen }) {
    const rules = await loadJsonl("corpus/rules/ROC.jsonl.gz").catch(() => []);
    if (!rules.length) return { sources: [], note: "Rules corpus unavailable." };

    const records = rules.map((r) => ({
      abbr: "ROC",
      r: { ...(r as Record<string, unknown>), citation: `Cal. Rules of Court, rule ${String((r as Record<string, unknown>).rule || "")}` },
    }));

    const plan = interpretQuery(queries.join(" ; "), { mode: mode || "hybrid" });
    const { docs, expandedTerms, stats } = hybridRetrieve(records, plan, {
      limit: (limit ?? 5) + 3,
      expand: plan.mode === "hybrid",
    });

    // a rule number named in the question is decisive
    if (plan.ruleNums.length) {
      docs.sort((a, b) => {
        const an = plan.ruleNums.includes(String(a.r.rule || "")) ? 1 : 0;
        const bn = plan.ruleNums.includes(String(b.r.rule || "")) ? 1 : 0;
        return bn - an || b.score - a.score;
      });
    }

    const screened = screen ? screenDocs(docs, screen) : docs;
    const top = screened.slice(0, limit ?? 5);
    if (!top.length) {
      return { sources: [], note: screen ? "No matching rules survived screening." : "No matching rules." };
    }
    return {
      pipeline: {
        mode: plan.mode,
        scanned: stats.scanned,
        candidates: stats.candidates,
        ...(expandedTerms.length ? { expanded_terms: expandedTerms } : {}),
      },
      sources: top.map((d, i) => ({
        marker: `[r${i + 1}]`,
        rule: "Cal. Rules of Court, rule " + String(d.r.rule || "") + (d.r.rule_title ? " — " + String(d.r.rule_title) : ""),
        text: String(d.r.text || "").slice(0, 1200),
        score: d.score,
        ...(d.r.history ? { history: String(d.r.history).slice(0, 160) } : {}),
      })),
    };
  },
});
