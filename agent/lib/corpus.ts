import fs from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";

type Section = {
  kind: string;
  section?: string;
  citation?: string;
  text?: string;
  history?: string;
  repealed?: boolean;
};

const lawCache = new Map<string, Section[]>();
const lawLoading = new Map<string, Promise<Section[]>>();
const jsonlCache = new Map<string, Array<Record<string, unknown>>>();
const jsonlLoading = new Map<string, Promise<Array<Record<string, unknown>>>>();

function appOrigin(): string {
  const u = process.env.VERCEL_URL || process.env.NEXT_PUBLIC_SITE_URL;
  if (u) return u.startsWith("http") ? u : `https://${u}`;
  return "https://raw.githubusercontent.com/saintus-create/CALEGINFO/main/public";
}

async function fetchGz(url: string): Promise<Buffer> {
  const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

async function readGz(rel: string): Promise<string> {
  const local = path.join(process.cwd(), "public", rel);
  try {
    return gunzipSync(fs.readFileSync(local)).toString("utf8");
  } catch {
    const buf = await fetchGz(`https://raw.githubusercontent.com/saintus-create/CALEGINFO/main/public/${rel}`);
    return gunzipSync(buf).toString("utf8");
  }
}

async function parseJsonl(rel: string, text: string): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try { out.push(JSON.parse(t)); } catch { /* skip malformed record */ }
  }
  return out;
}

export async function loadCode(abbr: string): Promise<Section[]> {
  const key = abbr.toUpperCase();
  const cached = lawCache.get(key);
  if (cached) return cached;

  const pending = lawLoading.get(key);
  if (pending) return pending;

  const promise = (async () => {
    const text = await readGz(`corpus/law/${key}.jsonl.gz`);
    const out: Section[] = [];
    for (const line of text.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try { out.push(JSON.parse(t)); } catch { /* skip malformed record */ }
    }
    lawCache.set(key, out);
    return out;
  })();

  lawLoading.set(key, promise);
  try {
    return await promise;
  } finally {
    lawLoading.delete(key);
  }
}

export async function loadJsonl(rel: string): Promise<Array<Record<string, unknown>>> {
  const cached = jsonlCache.get(rel);
  if (cached) return cached;

  const pending = jsonlLoading.get(rel);
  if (pending) return pending;

  const promise = (async () => {
    const text = await readGz(rel);
    const out = await parseJsonl(rel, text);
    jsonlCache.set(rel, out);
    return out;
  })();

  jsonlLoading.set(rel, promise);
  try {
    return await promise;
  } finally {
    jsonlLoading.delete(rel);
  }
}

/** Statewide Judicial Council forms (number, title, description, dates, PDFs). */
export async function loadForms(): Promise<Array<Record<string, unknown>>> {
  return loadJsonl("corpus/forms/FORMS.jsonl.gz");
}

/**
 * Abbreviations as packed in public/corpus/law/<ABBR>.jsonl.gz and listed in
 * corpus/manifest.json — must stay in sync with lib/engine.js CODE_NAMES.
 */
export const CODE_NAMES: Record<string, string> = {
  CONS: "California Constitution", BPC: "Business and Professions Code", CIV: "Civil Code",
  CCP: "Code of Civil Procedure", COM: "Commercial Code", CORP: "Corporations Code",
  EDC: "Education Code", ELEC: "Elections Code", EVID: "Evidence Code", FAM: "Family Code",
  FIN: "Financial Code", FGC: "Fish and Game Code", FAC: "Food and Agricultural Code",
  GOV: "Government Code", HNC: "Harbors and Navigation Code", HSC: "Health and Safety Code",
  INS: "Insurance Code", LAB: "Labor Code", MVC: "Military and Veterans Code", PEN: "Penal Code",
  PROB: "Probate Code", PCC: "Public Contract Code", PRC: "Public Resources Code",
  PUC: "Public Utilities Code", RTC: "Revenue and Taxation Code", SHC: "Streets and Highways Code",
  UIC: "Unemployment Insurance Code", VEH: "Vehicle Code", WAT: "Water Code",
  WIC: "Welfare and Institutions Code",
};

const ALL_ABBRS = Object.keys(CODE_NAMES);

export function codesFor(hint?: string[]): string[] {
  if (!hint || !hint.length) return ALL_ABBRS;
  const up = hint.map((c) => c.toUpperCase());
  return ALL_ABBRS.filter((a) => up.includes(a));
}
