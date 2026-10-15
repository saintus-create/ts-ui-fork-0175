import { defineTool } from "eve/tools";
import { z } from "zod";
import { loadForms } from "../lib/corpus";
import { formSeries, scoreForms } from "../lib/search";

export default defineTool({
  description:
    "Search the complete catalog of statewide Judicial Council forms (1,670 forms) — form numbers, titles, " +
    "plain-language descriptions, mandatory-use flags, effective dates, topic categories, official PDF links, " +
    "form-information pages, and translation availability. Use this whenever a question involves a court form, " +
    "a form number (FL-100, DV-110, CR-101, UD-100, SC-100), mandatory vs optional forms, filing/pleading " +
    "paperwork, or self-help forms. Query with the topic phrase a filer would use (\"fee waiver\", " +
    "\"eviction response\", \"name change\") or the exact form number; when you know the series, pass it " +
    "as prefix (FL, DV, FW, UD, SC, GC, JV, CR, APP, POS) to narrow the pool. Returns form sources " +
    "like [f1], [f2] to cite inline.",
  inputSchema: z.object({
    queries: z
      .array(z.string().min(2))
      .min(1)
      .max(4)
      .describe("Search phrases — topic terms and/or a form number, e.g. [\"domestic violence restraining order\", \"DV-110\"]"),
    prefix: z
      .string()
      .optional()
      .describe("Restrict to one form series, e.g. FL, DV, CR, JV, GC, SC, UD, APP, POS"),
    mandatory_only: z.boolean().optional().describe("Only return forms adopted for mandatory use"),
    limit: z.number().int().min(3).max(25).optional(),
  }),
  async execute({ queries, prefix, mandatory_only, limit }) {
    const forms = await loadForms().catch(() => []);
    if (!forms.length) return { sources: [], note: "Forms corpus unavailable." };

    const series = prefix ? prefix.toUpperCase().replace(/[^A-Z0-9]/g, "") : "";
    // Match the form family (FL, DV, CP10, GDC) rather than the source's
    // number-range group (FL-1XX ... FL-9XX).
    const pool = series ? forms.filter((f) => formSeries(f).replace(/[^A-Z0-9]/g, "") === series) : forms;

    let hits = scoreForms(queries, pool, limit ?? 10);
    if (mandatory_only) hits = hits.filter((h) => h.mandatory);
    if (!hits.length) {
      return {
        sources: [],
        note: series
          ? `No ${series}-series forms matched those terms. Try different terms or drop the prefix filter.`
          : "No Judicial Council forms matched those terms. Try the form number or the topic word (e.g. 'eviction', 'dissolution', 'guardianship').",
      };
    }

    return {
      note:
        "Cite these forms inline with their bracketed markers, e.g. [f1]. Name the form number and title, " +
        "and say whether the form is mandatory or optional and its effective date when it matters.",
      sources: hits.map((h, i) => ({
        marker: `[f${i + 1}]`,
        citation: `Judicial Council form ${h.number} — ${h.title}`,
        number: h.number,
        title: h.title,
        ...(h.category ? { category: h.category } : {}),
        use: h.mandatory ? "Mandatory use" : "Optional use",
        ...(h.effective ? { effective: h.effective } : {}),
        ...(h.description ? { description: h.description } : {}),
        ...(h.pdf_url ? { pdf_url: h.pdf_url } : {}),
        ...(h.info_url ? { info_url: h.info_url } : {}),
        ...(h.languages && h.languages.length ? { translations: h.languages } : {}),
      })),
    };
  },
});
