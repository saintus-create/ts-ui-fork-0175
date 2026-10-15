import { defineTool } from "eve/tools";
import { z } from "zod";

const FIRECRAWL_BASE = process.env.FIRECRAWL_BASE_URL || "https://api.firecrawl.dev/v2";

/**
 * Keyword search over the full text of bills on leginfo.legislature.ca.gov
 * (Firecrawl Alexandria: leginfo-legislature-ca-gov/legislation/bill_search).
 * Activates when FIRECRAWL_API_KEY is set; otherwise returns a note so the
 * model falls back to the local bill catalog (search_bills).
 */
export default defineTool({
  description:
    "Keyword search over the FULL TEXT of California bills for a legislative session " +
    "(live from leginfo.legislature.ca.gov via Firecrawl). Matches bills whose text contains " +
    "the words — far deeper than subject-line search. Returns sources like [t1], [t2]. " +
    "10 results per page.",
  inputSchema: z.object({
    keyword: z.string().min(2).max(120).describe("Words to search in bill text, e.g. 'civil discovery'"),
    page: z.number().int().min(1).max(50).optional(),
    session_year: z.string().regex(/^(19|20)[0-9]{2}(20)[0-9]{2}$/).optional().describe("Session code, e.g. 20252026 (default)"),
  }),
  async execute({ keyword, page, session_year }) {
    const key = process.env.FIRECRAWL_API_KEY;
    if (!key) {
      return {
        sources: [],
        note: "Bill-text search is not configured (no Firecrawl key); use search_bills on the local catalog instead.",
      };
    }
    try {
      const resp = await fetch(`${FIRECRAWL_BASE}/scrape`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${key}`,
        },
        body: JSON.stringify({
          alexandria: {
            provider: "leginfo-legislature-ca-gov",
            capability: "legislation/bill_search",
            options: {
              keyword,
              ...(page ? { page } : {}),
              ...(session_year ? { session_year } : {}),
            },
          },
        }),
        signal: AbortSignal.timeout(20000),
      });
      if (!resp.ok) {
        return { sources: [], note: `Bill-text search failed (HTTP ${resp.status}).` };
      }
      const json = (await resp.json()) as {
        data?: {
          results?: Array<{ author?: string; bill_id?: string; measure?: string; snippet?: string; source_url?: string }>;
          total?: number;
          page?: number;
          pages?: number;
        };
      };
      const results = json?.data?.results || [];
      if (!results.length) {
        return { sources: [], note: "No bills matched those words in bill text." };
      }
      return {
        note: `Full-text bill search${json?.data?.total != null ? ` — ${json.data.total} total matches` : ""}. Cite like [t1].`,
        sources: results.map((r, i) => ({
          marker: `[t${i + 1}]`,
          measure: String(r.measure || r.bill_id || "?"),
          author: String(r.author || "unknown"),
          session: session_year || "20252026",
          snippet: String(r.snippet || "").replace(/<[^>]+>/g, "").slice(0, 500),
          url: String(r.source_url || ""),
        })),
      };
    } catch (e) {
      return { sources: [], note: `Bill-text search unavailable (${e instanceof Error ? e.message : "error"}).` };
    }
  },
});
