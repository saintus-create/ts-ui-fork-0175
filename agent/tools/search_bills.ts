import { defineTool } from "eve/tools";
import { z } from "zod";
import { loadJsonl } from "../lib/corpus";
import { measuresIn, termsOf } from "../lib/search";

export default defineTool({
  description:
    "Search all 5,062 bills and measures of the 2025-2026 California legislative session (subject, author, status). " +
    "Use for questions about what the Legislature passed, pending bills, or vetoed measures. Only CHAPTERED bills are law. " +
    "Returns bill sources like [b1], [b2] to cite inline.",
  inputSchema: z.object({
    queries: z.array(z.string().min(2)).min(1).max(4),
    limit: z.number().int().min(3).max(12).optional(),
  }),
  async execute({ queries, limit }) {
    const bills = await loadJsonl("corpus/legislation/BILLS.jsonl.gz").catch(() => []);
    if (!bills.length) return { sources: [], note: "Bill catalog unavailable." };
    const qsets = queries.map((q) => ({ raw: q.toLowerCase(), terms: termsOf(q), measures: measuresIn(q) }));
    const out: Array<{ b: Record<string, unknown>; score: number }> = [];
    for (const b of bills) {
      const mk = String(b.measure || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
      const subject = String(b.subject || "").toLowerCase();
      const author = String(b.author || "").toLowerCase();
      const terms = ((b.terms as string[]) || []).join(" ").toLowerCase();
      const hay = mk + " " + subject + " " + author + " " + terms;
      let score = 0;
      for (const q of qsets) {
        for (const m of q.measures) {
          if (m === mk) score += 100;
          else if (mk.includes(m) || m.includes(mk)) score += 20;
        }
        for (const t of q.terms) {
          if (subject.includes(" " + t + " ") || subject.startsWith(t + " ") || subject.endsWith(" " + t)) score += 8;
          else if (subject.includes(t)) score += 4;
          if (author.includes(t)) score += 10;
          if (terms.includes(t)) score += 5;
        }
      }
      if (score > 0) out.push({ b, score });
    }
    out.sort((a, b) => b.score - a.score || String(a.b.measure).localeCompare(String(b.b.measure), undefined, { numeric: true }));
    const top = out.slice(0, limit ?? 6).map((x) => x.b);
    if (!top.length) return { sources: [], note: "No matching bills." };
    return {
      note: "Status groups: Chaptered = became law; Active = still moving; Vetoed = rejected by the Governor. Cite like [b1].",
      sources: top.map((b, i) => ({
        marker: `[b${i + 1}]`,
        measure: String(b.measure || ""),
        author: String(b.author || "unknown"),
        chamber: String(b.chamber || ""),
        status: String(b.status || b.group || ""),
        ...(b.subject ? { subject: String(b.subject).slice(0, 300) } : {}),
        ...(b.url ? { official_text: String(b.url) } : {}),
      })),
    };
  },
});
