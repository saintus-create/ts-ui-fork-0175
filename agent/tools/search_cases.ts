import { defineTool } from "eve/tools";
import { z } from "zod";

// California Supreme Court (cal) + Courts of Appeal (calctapp).
// CourtListener's v4 search API is open for read use (no token needed, ~5k
// req/hr anonymous); COURTLISTENER_TOKEN, when present, only raises the limit.
const COURTS = "cal calctapp";

function stripHtml(input: string): string {
  return String(input || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#0?39;|&#8217;|&rsquo;/g, "'")
    .replace(/&#8220;|&#8221;|&ldquo;|&rdquo;|&quot;/g, '"')
    .replace(/&#8212;|&mdash;/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

// opinion snippets are headed with filing/certification boilerplate; cut it so
// the passage the model reads is substance, not a caption
function cleanSnippet(raw: string): string {
  let s = stripHtml(raw);
  s = s.replace(/^Filed\s+\d{1,2}\/\d{1,2}\/\d{2,4}\s*/i, "");
  s = s.replace(/^CERTIFIED FOR PUBLICATION\s*/i, "");
  s = s.replace(/^NOT TO BE PUBLISHED[^.]*\.\s*/i, "");
  s = s.replace(/^IN THE COURT OF APPEAL OF THE STATE OF CALIFORNIA\s*/i, "");
  s = s.replace(/^THE SUPREME COURT OF CALIFORNIA\s*/i, "");
  // caption line: "THE PEOPLE, H042499 v. MARK ANTHONY COLBERT."
  s = s.replace(
    /^(?:THE\s+)?PEOPLE,?\s*(?:[A-Z]\d{4,6}\s*)?v\.?\s+[A-Z][A-Za-z.,'\- ]{2,60}\.\s*/i,
    "",
  );
  s = s.replace(/\s+/g, " ").trim();
  return s.slice(0, 700);
}

function pickCite(r: Record<string, unknown>): string {
  const from = (v: unknown): string => {
    if (Array.isArray(v) && v.length) {
      const first = v[0];
      if (typeof first === "string") return first;
      if (first && typeof first === "object" && "cite" in (first as object))
        return String((first as { cite?: string }).cite || "");
    }
    return "";
  };
  return from(r.citation) || from(r.citations);
}

function pickSnippet(r: Record<string, unknown>): string {
  if (r.snippet) {
    const s = cleanSnippet(String(r.snippet));
    if (s.length > 20) return s;
  }
  const ops = (r.opinions as Array<Record<string, unknown>>) || [];
  const rank = (o: Record<string, unknown>): number =>
    o.type === "combined-opinion" || o.type === "lead-opinion"
      ? 2
      : o.type === "dissent"
        ? 0
        : 1;
  const best = [...ops]
    .filter((o) => String(o.snippet || "").length > 20)
    .sort(
      (a, b) =>
        rank(b) - rank(a) ||
        String(b.snippet || "").length - String(a.snippet || "").length,
    )[0];
  return cleanSnippet(String(best?.snippet || ""));
}

type CaseHit = {
  caseName: string;
  cite: string;
  court: string;
  date: string;
  docket: string;
  status: string;
  snippet: string;
  url: string;
};

export default defineTool({
  description:
    "Search published (precedential) California Supreme Court and Court of Appeal opinions. " +
    "Use for how courts have interpreted or applied a statute, for elements and standards, " +
    "or for case law generally. Returns case sources like [c1], [c2] to cite inline.",
  inputSchema: z.object({
    queries: z.array(z.string().min(4)).min(1).max(3),
  }),
  async execute({ queries }) {
    const token = process.env.COURTLISTENER_TOKEN || "";
    const headers: Record<string, string> = { Accept: "application/json" };
    if (token) headers.Authorization = "Token " + token;
    // These searches are independent. Running them serially made the case
    // search latency equal to the sum of up to three network round trips.
    // Run the bounded query set concurrently, then merge/dedupe locally.
    const searchOne = async (q: string): Promise<CaseHit[]> => {
      try {
        const url =
          "https://www.courtlistener.com/api/rest/v4/search/?q=" +
          encodeURIComponent(q) +
          "&type=o&court=" +
          encodeURIComponent(COURTS);
        const resp = await fetch(url, {
          headers,
          signal: AbortSignal.timeout(10000),
        });
        if (!resp.ok) return [];
        const data = (await resp.json()) as {
          results?: Array<Record<string, unknown>>;
        };
        return (data.results || []).map((r): CaseHit | null => {
          const caseName = String(r.caseName || r.caseNameFull || "").trim();
          if (!caseName) return null;
          return {
            caseName,
            cite: pickCite(r),
            court: String(r.court_citation_string || r.court || ""),
            date: String(r.dateFiled || ""),
            docket: String(r.docketNumber || ""),
            status: String(r.status || ""),
            snippet: pickSnippet(r),
            url: r.absolute_url
              ? "https://www.courtlistener.com" + String(r.absolute_url)
              : "",
          };
        }).filter((x): x is CaseHit => x !== null);
      } catch {
        return [];
      }
    };

    const results = await Promise.all(queries.slice(0, 3).map(searchOne));
    const out: Array<Record<string, string>> = [];
    const seen = new Set<string>();
    for (const batch of results) {
      for (const item of batch) {
        if (out.length >= 6) break;
        if (seen.has(item.caseName)) continue;
        seen.add(item.caseName);
        out.push(item);
      }
      if (out.length >= 6) break;
    }
    // precedential first
    out.sort((a, b) => (b.status === "Published" ? 1 : 0) - (a.status === "Published" ? 1 : 0));
    if (!out.length)
      return { sources: [], note: "No published California opinions found for these terms." };
    return {
      note:
        "Published California opinions (Supreme Court and Courts of Appeal). " +
        "Cite like [c1] inline; use the case name and citation exactly as given.",
      sources: out.map((c, i) => ({ marker: `[c${i + 1}]`, ...c })),
    };
  },
});
