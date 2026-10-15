import { defineTool } from "eve/tools";
import { z } from "zod";
import { CODE_NAMES, loadCode } from "../lib/corpus";

export default defineTool({
  description:
    "Read one specific California statute in full, by code abbreviation and section number — e.g. CIV 1946 or CCP 1161. " +
    "Use after search_statutes to pull the complete text of a section you want to quote.",
  inputSchema: z.object({
    code: z.string().min(3).max(5).describe("Code abbreviation, e.g. CIV, CCP, PEN, FAM"),
    section: z.string().describe("Section number, e.g. 1946 or 3294"),
  }),
  async execute({ code, section }) {
    const abbr = code.toUpperCase();
    const records = await loadCode(abbr).catch(() => null);
    if (!records) return { found: false, note: `Unknown code ${abbr}.` };
    const hits = records.filter((r) => String(r.section || "") === String(section).trim());
    if (!hits.length) return { found: false, note: `No section ${section} in ${abbr}.` };
    return {
      found: true,
      sources: hits.slice(0, 3).map((r, i) => ({
        marker: `[s${i + 1}]`,
        citation: String(r.citation || abbr + " § " + r.section),
        text: String(r.text || "").slice(0, 4000),
        ...(r.history ? { legislative_history: String(r.history).slice(0, 300) } : {}),
        repealed: Boolean(r.repealed),
      })),
      code: CODE_NAMES[abbr] || abbr,
    };
  },
});
