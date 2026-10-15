import { defineTool } from "eve/tools";
import { z } from "zod";
import { loadJsonl } from "../lib/corpus";
import { termsOf } from "../lib/search";

interface WpEntry {
  headword: string;
  text: string;
  page: number;
  cites?: string[];
}

let cache: WpEntry[] | null = null;

/** Words and Phrases — West's California Digest 2d (parsed from the scan). */
async function loadDigest(): Promise<WpEntry[]> {
  if (cache) return cache;
  const rows = await loadJsonl("corpus/library/wp-digest.jsonl.gz").catch(() => []);
  cache = rows as unknown as WpEntry[];
  return cache;
}

function score(entry: WpEntry, terms: string[]): number {
  const head = (entry.headword || "").toLowerCase();
  const body = (entry.text || "").toLowerCase();
  let s = 0;
  for (const t of terms) {
    if (head === t) s += 40;
    else if (head.includes(t)) s += 18;
    // boundary match without \b escapes: a term like "will" must not hit "goodwill"
    const n = (body.match(new RegExp(`(^|[^a-z0-9])${t}([^a-z0-9]|$)`, "g")) || []).length;
    if (n > 0) s += Math.min(n, 4) * 3;
  }
  return s;
}

export default defineTool({
  description:
    "Search Words and Phrases — West's California Digest 2d (4,672 entries), the digest that collects, term by term, how California courts have actually construed a word or phrase, each entry carrying the case that defined it and the citation. " +
    "Use this when the question turns on what a term MEANS in California law — a definition, a phrase the code does not itself define, a term of art, or how courts have read a statutory word in practice. " +
    "It complements search_statutes: the code states the rule, this shows how the word in it has been applied. Query with the term or phrase itself (e.g. \"fiduciary\", \"final decision\", \"actual controversy\"), plus a synonym if the first is not a headword. " +
    "Returns sources like [w1], [w2] to cite inline. Do not use it for procedural questions or form numbers.",
  inputSchema: z.object({
    queries: z
      .array(z.string().min(2))
      .min(1)
      .max(4)
      .describe("The word or phrase to look up, plus any synonyms — e.g. [\"actual controversy\", \"ripe\"]"),
    limit: z.number().int().min(3).max(20).optional(),
  }),
  async execute({ queries, limit }) {
    const entries = await loadDigest();
    if (!entries.length) return { sources: [], note: "Words and Phrases corpus unavailable." };

    const terms = [...new Set(queries.flatMap((q) => termsOf(q)))];
    if (!terms.length) return { sources: [], note: "Give a word or phrase to look up." };

    const hits = entries
      .map((e) => ({ e, s: score(e, terms) }))
      .filter((h) => h.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, limit ?? 8)
      .map((h) => h.e);

    if (!hits.length) {
      return {
        sources: [],
        note:
          "No Words and Phrases entry matched those terms. The digest is keyed by headword, so try the noun the court would use " +
          "(e.g. \"controversy\" rather than \"dispute\"), or answer from the statutes.",
      };
    }

    return {
      note:
        "Cite these inline with their bracketed markers, e.g. [w1]. Name the headword and, where the entry gives one, the case that defined it.",
      sources: hits.map((e, i) => ({
        marker: `[w${i + 1}]`,
        citation: `Words and Phrases — "${e.headword}" (West's Cal. Digest 2d, p.${e.page})`,
        headword: e.headword,
        text: (e.text || "").slice(0, 900),
        ...(e.cites && e.cites.length ? { cites: e.cites } : {}),
      })),
    };
  },
});
