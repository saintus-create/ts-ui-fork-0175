import { defineTool } from "eve/tools";
import { z } from "zod";

const FIRECRAWL_BASE = process.env.FIRECRAWL_BASE_URL || "https://api.firecrawl.dev/v2";

const DETAILS = {
  text: {
    capability: "legislation/bill",
    label: "current text, digest and versions",
  },
  status: {
    capability: "legislation/bill_status",
    label: "status, authors, topic and last milestone",
  },
  history: {
    capability: "legislation/bill_history",
    label: "complete dated action history",
  },
  votes: {
    capability: "legislation/bill_votes",
    label: "roll-call votes with member names",
  },
} as const;

/**
 * One bill's live detail from leginfo.legislature.ca.gov (Firecrawl
 * Alexandria). Activates when FIRECRAWL_API_KEY is set.
 */
export default defineTool({
  description:
    "Live detail for one California bill by measure (e.g. 'AB-1930' or 'SB 50'): its current text and digest, " +
    "its status and last milestone, its complete action history, or its roll-call votes. " +
    "Use after finding a bill (search_bills / bill_text_search) to answer where a measure stands. " +
    "Returns sources like [d1].",
  inputSchema: z.object({
    measure: z.string().min(2).max(20).describe("Measure like 'AB-1930', 'SB50', 'ACA-3'"),
    detail: z.enum(["text", "status", "history", "votes"]),
    session_year: z.string().regex(/^(19|20)[0-9]{2}(20)[0-9]{2}$/).optional().describe("Session code, e.g. 20252026 (default)"),
  }),
  async execute({ measure, detail, session_year }) {
    const key = process.env.FIRECRAWL_API_KEY;
    if (!key) {
      return {
        sources: [],
        note: "Live bill detail is not configured (no Firecrawl key); rely on search_bills for status.",
      };
    }
    const session = session_year || "20252026";
    const clean = measure.toUpperCase().replace(/\s+/g, "").replace(/([A-Z]+)-?(\d+)/, "$1$2");
    const billId = `${session}0${clean}`;
    const spec = DETAILS[detail];
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
            capability: spec.capability,
            options: { bill_id: billId },
          },
        }),
        signal: AbortSignal.timeout(25000),
      });
      if (!resp.ok) {
        return { sources: [], note: `Bill detail failed (HTTP ${resp.status}).` };
      }
      const json = (await resp.json()) as { data?: Record<string, unknown> };
      const data = json?.data;
      if (!data || !Object.keys(data).length) {
        return { sources: [], note: `No ${spec.label} found for ${clean}.` };
      }
      const text = JSON.stringify(data, null, 1).slice(0, 6000);
      return {
        note: `${clean} ${spec.label} (${session}). Cite like [d1].`,
        sources: [
          {
            marker: "[d1]",
            measure: clean,
            session,
            detail: spec.label,
            snippet: text,
            url: `https://leginfo.legislature.ca.gov/faces/billNavClient.xhtml?bill_id=${billId}`,
          },
        ],
      };
    } catch (e) {
      return { sources: [], note: `Bill detail unavailable (${e instanceof Error ? e.message : "error"}).` };
    }
  },
});
