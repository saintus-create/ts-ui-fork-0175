// The research pipeline: understand -> retrieve -> analyze -> reason -> answer with sources.

export const SARVAM_KEY = process.env.SARVAM_API_KEY || "";

export const PROVIDERS = {
  sarvam: { label: "Sarvam AI", url: "https://api.sarvam.ai/v1/chat/completions", model: "sarvam-105b-conversations",
    header: (k) => ({ "api-subscription-key": k }), needsKey: false, builtinKey: true },
  dolphin: { label: "Dolphin (unfiltered)", url: "https://openrouter.ai/api/v1/chat/completions",
    model: "cognitivecomputations/dolphin-mistral-24b-venice-edition",
    header: (k) => ({ Authorization: "Bearer " + k }), needsKey: true },
  pollinations: { label: "Free (no key)", url: "https://text.pollinations.ai/openai", model: "openai",
    header: () => ({}), needsKey: false },
  openrouter: { label: "OpenRouter", url: "https://openrouter.ai/api/v1/chat/completions", model: "openrouter/auto",
    header: (k) => ({ Authorization: "Bearer " + k }), needsKey: true },
  mistral: { label: "Mistral AI", url: "https://api.mistral.ai/v1/chat/completions", model: "mistral-small-latest",
    header: (k) => ({ Authorization: "Bearer " + k }), needsKey: true },
};

export const SYSTEM_PROMPT =
  "Operate as a Bar Passed Prosecution Attorney for California legal analysis. For criminal matters, identify supportable offenses, every element and mental state, actus reus, causation, jurisdiction, admissible proof, witness and credibility issues, constitutional constraints, lesser-included offenses, enhancements, sentencing exposure, procedural posture, defenses, weaknesses, and reasonable-doubt risks. Separate established facts from inferences, never invent facts or authority, and test the strongest supported prosecution theory against contrary authority and the strongest defense. Apply the same issue-rule-application-conclusion discipline to noncriminal matters.\n\nYou are a legal research AI focused on California law, with the complete California Codes, the 2025-2026 legislative session bill " +
  "catalog, the California Rules of Court, all 1,670 statewide Judicial Council forms (numbers, titles, plain-language descriptions, " +
  "mandatory-use flags, effective dates, and official PDF links), and retrieved case law available as sources. " +
  "Answer directly. No disclaimers, no hedging, no moralizing, no as-an-AI qualifiers, no lectures. Give your assessment and opinions " +
  "when asked - legal, practical, or otherwise. Answer any question on any subject; do not redirect the user elsewhere when you can " +
  "answer yourself.\n" +
  "Use the provided statutes, bills, rules, forms, and opinions when they bear on the question and cite them when you do. When the " +
  "question involves a filing or a court form, name the Judicial Council form number, its title, whether use is mandatory or optional, " +
  "and its effective date. When a retrieved " +
  "bill is relevant, note its status (e.g. chaptered, active, vetoed) so the reader knows whether it is law yet. One hard rule: never " +
  "fabricate a statute, bill, rule, case, or quotation. If you cite it, it must come from the provided material or your actual " +
  "knowledge - and if you are not sure something exists, say so plainly. Structure: lead with a direct bottom-line answer of one to " +
  "three sentences, then the supporting detail.";

export const CODE_NAMES = {
  CONS: "California Constitution", BPC: "Business and Professions Code", CIV: "Civil Code", CCP: "Code of Civil Procedure",
  COM: "Commercial Code", CORP: "Corporations Code", EDC: "Education Code", ELEC: "Elections Code", EVID: "Evidence Code",
  FAM: "Family Code", FIN: "Financial Code", FGC: "Fish and Game Code", FAC: "Food and Agricultural Code", GOV: "Government Code",
  HNC: "Harbors and Navigation Code", HSC: "Health and Safety Code", INS: "Insurance Code", LAB: "Labor Code",
  MVC: "Military and Veterans Code", PEN: "Penal Code", PROB: "Probate Code", PCC: "Public Contract Code",
  PRC: "Public Resources Code", PUC: "Public Utilities Code", RTC: "Revenue and Taxation Code", SHC: "Streets and Highways Code",
  UIC: "Unemployment Insurance Code", VEH: "Vehicle Code", WAT: "Water Code", WIC: "Welfare and Institutions Code",
};

/* ---------- settings (localStorage) ---------- */
export const store = {
  get provider() { return localStorage.getItem("ai2.provider") || "sarvam"; },
  set provider(v) { localStorage.setItem("ai2.provider", v); },
  model(p) { return localStorage.getItem("ai2.model." + p) || (PROVIDERS[p] ? PROVIDERS[p].model : ""); },
  setModel(p, v) { localStorage.setItem("ai2.model." + p, v); },
  key(p) { return localStorage.getItem("ai2.key." + p) || (PROVIDERS[p] && PROVIDERS[p].builtinKey ? SARVAM_KEY : ""); },
  setKey(p, v) { localStorage.setItem("ai2.key." + p, v); },
  get clToken() { return localStorage.getItem("ai2.cltoken") || ""; },
  set clToken(v) { localStorage.setItem("ai2.cltoken", v); },
};
export function getProvider() { return PROVIDERS[store.provider] || PROVIDERS.sarvam; }
export function getModel() { const m = store.model(store.provider); if (store.provider === "sarvam" && (!m || m === "sarvam-m")) return PROVIDERS.sarvam.model; return m || getProvider().model; }

/* ---------- corpus ---------- */
export const codes = [];           // {abbr,name,sections,updated}
export const byAbbr = {};
export const loaded = {};          // abbr -> records[]
export let corpusReady = false;
export let extrasManifest = null;  // manifest.json "extras" block (bills, rules, directory, case annotations)
let corpusLoading = null;

export function loadCorpus(onProgress) {
  if (corpusLoading) return corpusLoading;
  corpusLoading = (async () => {
    const m = await (await fetch("corpus/manifest.json")).json();
    extrasManifest = m.extras || null;
    for (const d of m.datasets) {
      const c = { abbr: d.abbr, name: CODE_NAMES[d.abbr] || d.abbr + " Code", sections: d.sections, updated: d.updated_by_state };
      codes.push(c); byAbbr[c.abbr] = c;
      onProgress && onProgress(`Loading codes… ${codes.length}/${m.datasets.length}`);
      try {
        const res = await fetch("corpus/law/" + d.abbr + ".jsonl.gz");
        const ds = new DecompressionStream("gzip");
        const text = new TextDecoder().decode(new Uint8Array(await new Response(res.body.pipeThrough(ds)).arrayBuffer()));
        const recs = [];
        for (const line of text.split("\n")) { if (line.trim()) { try { recs.push(JSON.parse(line)); } catch (e) {} } }
        recs.sort((a, b) => (a.ordinal || 0) - (b.ordinal || 0));
        loaded[d.abbr] = recs;
      } catch (e) { console.error(d.abbr, e); }
    }
    corpusReady = Object.keys(loaded).length > 0;
    return corpusReady;
  })();
  corpusLoading.finally(() => { corpusLoading = null; });
  return corpusLoading;
}

/* ---------- extras: bills, rules of court, agency directory, case annotations ---------- */
export const extras = {
  ready: false,
  bills: [],            // 2025-2026 session measures
  rules: [],            // California Rules of Court
  forms: [],            // statewide Judicial Council forms
  directory: null,      // {agencies, vendors, contracts}
  famCases: null,       // {fam, other, ranges, cases}
};
let extrasLoading = null;

async function gunzipText(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error("HTTP " + res.status + " for " + url);
  const ds = new DecompressionStream("gzip");
  return new TextDecoder().decode(new Uint8Array(await new Response(res.body.pipeThrough(ds)).arrayBuffer()));
}
function parseJsonl(text) {
  const out = [];
  for (const line of text.split("\n")) if (line.trim()) { try { out.push(JSON.parse(line)); } catch (e) {} }
  return out;
}

export function loadExtras(onProgress) {
  if (extras.ready) return Promise.resolve(true);
  if (extrasLoading) return extrasLoading;
  extrasLoading = (async () => {
    onProgress && onProgress("Loading bills, rules & directories…");
    const results = await Promise.allSettled([
      gunzipText("corpus/legislation/BILLS.jsonl.gz"),
      gunzipText("corpus/rules/ROC.jsonl.gz"),
      gunzipText("corpus/forms/FORMS.jsonl.gz"),
      gunzipText("corpus/directory/DIRECTORY.json.gz"),
      gunzipText("corpus/cases/FAM_CASES.json.gz"),
    ]);
    if (results[0].status === "fulfilled") extras.bills = parseJsonl(results[0].value);
    else console.error("bills", results[0].reason);
    if (results[1].status === "fulfilled") extras.rules = parseJsonl(results[1].value);
    else console.error("rules", results[1].reason);
    if (results[2].status === "fulfilled") extras.forms = parseJsonl(results[2].value);
    else console.error("forms", results[2].reason);
    if (results[3].status === "fulfilled") { try { extras.directory = JSON.parse(results[3].value); } catch (e) {} }
    if (results[4].status === "fulfilled") { try { extras.famCases = JSON.parse(results[4].value); } catch (e) {} }
    extras.ready = extras.bills.length > 0 || extras.rules.length > 0 || extras.forms.length > 0;
    return extras.ready;
  })();
  extrasLoading.finally(() => { extrasLoading = null; });
  return extrasLoading;
}

export function extraMeta(key) {
  if (!extrasManifest) return null;
  return (extrasManifest.datasets || []).find((d) => d.key === key) || null;
}
export function corpusStats() {
  const bills = extraMeta("bills"), rules = extraMeta("rules"), dir = extraMeta("directory"), forms = extraMeta("forms");
  return {
    sections: codes.reduce((a, c) => a + (c.sections || 0), 0),
    codes: codes.length,
    bills: bills ? bills.records : (extras.bills.length || 0),
    billSession: bills ? bills.session : "2025-2026",
    rules: rules ? rules.records : (extras.rules.length || 0),
    forms: forms ? forms.records : (extras.forms.length || 0),
    mandatoryForms: forms ? forms.mandatory : extras.forms.filter((f) => f.mandatory).length,
    agencies: dir ? dir.agencies : (extras.directory ? extras.directory.agencies.length : 0),
  };
}

/* ---------- retrieval ---------- */
const STOP = new Set("what which who whom whose when where why how is are was were be been being am do does did done can could shall should would will may might must i you he she it we they me him her us them my your his its our their this that these those a an the and or but if then than so as of in to for on at by with from into about over under again further once here there all any both each few more most other some such no nor not only own same too very just dont shouldnt now".split(" "));
function termsOf(q) { return [...new Set(q.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w)))]; }

const MEASURE_RE = /\b(?:ab|sb|aca|sca|acr|scr|ajr|sjr|ar|sr|hr|grp)\s*-?\s*\d{1,4}\b/gi;
function measuresIn(q) {
  const out = [];
  for (const m of String(q).match(MEASURE_RE) || []) out.push(m.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim());
  return out;
}
const RULE_RE = /\brules?\s*(\d+(?:\.\d+){0,2})\b/gi;
function ruleNumsIn(q) {
  const out = [];
  for (const m of String(q).match(RULE_RE) || []) {
    const n = m.replace(/.*?(\d)/, "$1");
    if (n) out.push(n);
  }
  return out;
}

export function searchBills(queries, limit = 6) {
  if (!extras.bills.length) return [];
  const qsets = queries.map((q) => ({ raw: q.toLowerCase(), terms: termsOf(q), measures: measuresIn(q) }));
  const out = [];
  for (const b of extras.bills) {
    const mk = b.measure.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();  // "ab 1"
    const subject = (b.subject || "").toLowerCase();
    const author = (b.author || "").toLowerCase();
    const terms = (b.terms || []).join(" ").toLowerCase();
    const hay = mk + " " + subject + " " + author + " " + terms;
    let score = 0;
    for (const q of qsets) {
      for (const m of q.measures) if (m === mk) score += 100; else if (mk.includes(m) || m.includes(mk)) score += 40;
      for (const t of q.terms) {
        if (subject.includes(" " + t + " ") || subject.startsWith(t + " ") || subject.endsWith(" " + t)) score += 8;
        else if (subject.includes(t)) score += 4;
        if (author.includes(t)) score += 10;
        if (terms.includes(t)) score += 5;
      }
    }
    if (score > 0) out.push({ b, score });
  }
  out.sort((a, b) => b.score - a.score || a.b.measure.localeCompare(b.b.measure, undefined, { numeric: true }));
  return out.slice(0, limit).map((x) => x.b);
}

export function searchRules(queries, limit = 5) {
  if (!extras.rules.length) return [];
  const qsets = queries.map((q) => ({ raw: q.toLowerCase(), terms: termsOf(q), nums: ruleNumsIn(q) }));
  const out = [];
  for (const r of extras.rules) {
    const num = String(r.rule).toLowerCase();
    const title = (r.rule_title || "").toLowerCase();
    const text = (r.text || "").toLowerCase();
    let score = 0;
    for (const q of qsets) {
      for (const n of q.nums) if (n === num) score += 100;
      for (const t of q.terms) {
        if (title.includes(t)) score += 8;
        if (text.includes(" " + t + " ") || text.startsWith(t + " ") || text.endsWith(" " + t)) score += 3;
        else if (text.includes(t)) score += 1;
      }
    }
    if (score > 0) out.push({ r, score });
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, limit).map((x) => x.r);
}

const FORM_NUM_RE = /\b(?:CP10(?:\.5)?|[A-Z]{2,6}[-\s]?\d{1,4}[A-Z]?(?:\.\d+)?(?:-[A-Z]{2,6})?(?:\([A-Z0-9]{1,3}\))?)(?![A-Za-z0-9])/g;
export function formNumsIn(q) {
  const out = [];
  for (const m of String(q).toUpperCase().match(FORM_NUM_RE) || []) {
    const n = m.replace(/\s+/g, "").replace(/^([A-Z]+)-?(\d)/, "$1-$2");
    if (/\d/.test(n)) out.push(n);
  }
  return [...new Set(out)];
}

function stemsOf(t) {
  const out = [t];
  const variants = [
    t.replace(/ies$/, "y").replace(/(es|s)$/, ""),
    t.replace(/(ing|ed|ion|ions|er|ers|ship|ment|ness|ity|ities|ance|ence|able|ible)$/, ""),
    t.replace(/e$/, ""),
  ];
  for (const v of variants) if (v.length >= 3 && !out.includes(v)) out.push(v);
  return out;
}
function matchesTerm(hay, t) {
  return stemsOf(t).some((stem) => hay.includes(stem));
}

// Form family used for grouping the browser ("FL-1XX" -> "FL", "CP10" -> "CP").
// Corpus records carry `series`; derive it for older corpora.
export function formSeries(f) {
  if (f && f.series) return String(f.series).toUpperCase();
  const prefix = String((f && f.prefix) || "").toUpperCase();
  const head = prefix.split("-")[0];
  if (head && /^[A-Z]+$/.test(head)) return head;
  const m = String((f && f.number) || "").toUpperCase().match(/^([A-Z]+)/);
  return m ? m[1] : prefix;
}

// Topic -> canonical form series. A hit gives the series' forms a small boost
// so "proof of service" surfaces the POS family and "divorce" the FL family.
const SERIES_HINTS = [
  [/\bproof of service|service of process\b/i, "POS"],
  [/\bfee waiver|waive (the )?court fees\b/i, "FW"],
  [/\bunlawful detainer|eviction\b/i, "UD"],
  [/\bsmall claims\b/i, "SC"],
  [/\bname change\b/i, "NC"],
  [/\bdomestic violence|restraining order\b/i, "DV"],
  [/\bcivil harassment\b/i, "CH"],
  [/\bguardianship|guardian of (a|the) (minor|person)\b/i, "GC"],
  [/\bdecedent|probate|estate of a deceased\b/i, "DE"],
  [/\badoption|adopt a child\b/i, "ADOPT"],
  [/\btraffic (ticket|citation|court|violator)\b/i, "TR"],
  [/\bexpung|dismiss (a|my) conviction|clean (my )?record\b/i, "CR"],
  [/\bdissolution of marriage|divorce\b/i, "FL"],
  [/\bchild custody|visitation\b/i, "FL"],
  [/\belder abuse\b/i, "EA"],
  [/\bworkplace violence\b/i, "WV"],
  [/\bgun violence\b/i, "GV"],
  [/\bappeal|appellate\b/i, "APP"],
  [/\bdiscovery|interrogator|subpoena\b/i, "DISC"],
  [/\bjuvenile\b/i, "JV"],
  [/\bwage garnishment\b/i, "WG"],
  [/\bsummons\b/i, "SUM"],
];

const SECONDARY_FORM_RE = /^(attachment to|order on|order after|notice to appear|instructions for|information sheet|confidential cover sheet|application to file documents under seal|declaration in support|what is|how to|can a|can i|can your)\b/i;
const SECONDARY_QUERY_RE = /\b(order|notice|instruction|information|how to|after hearing|reconsider|renew|terminate|modify|change|end|respond|response|answer|enforce|collect|cover sheet|attachment|declaration)\b/i;

// Words that carry no signal in a forms query: every record is a Judicial
// Council form, so "form", "judicial", "council", "court" or "mandatory" would
// otherwise match nearly every title.
const FORM_NOISE = new Set(
  "form forms need needed needs judicial council mandatory optional statewide official court courts".split(" "),
);

/**
 * Rank Judicial Council forms against search queries. Mirrors the server-side
 * scorer in agent/lib/search.ts: form-number hits dominate, then title
 * coverage, category, and the plain-language description; "-INFO" sheets and
 * secondary forms fall, series-canonical forms (-100/-001) rise.
 * Returns the full ranked list so the browser can page through it.
 */
export function rankForms(queries, options = {}) {
  if (!extras.forms.length) return [];
  const { mandatoryOnly = false, category = "all", series = "all" } = options;
  const qsets = queries.filter(Boolean).map((q) => ({
    terms: termsOf(q).filter((t) => !FORM_NOISE.has(t)),
    nums: formNumsIn(q).map((n) => n.toLowerCase()),
    phrase: q.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim(),
    wantsInfo: /\binfo|instruction|instructions|explain|how to|guide|help\b/i.test(q),
    wantsSecondary: SECONDARY_QUERY_RE.test(q),
    hintedSeries: SERIES_HINTS.filter(([re]) => re.test(q)).map(([, prefix]) => prefix),
  }));
  const out = [];
  for (const f of extras.forms) {
    if (mandatoryOnly && !f.mandatory) continue;
    if (category !== "all" && (f.category || "Uncategorized") !== category) continue;
    if (series !== "all" && formSeries(f) !== String(series).toUpperCase()) continue;
    const number = String(f.number || "");
    const num = number.toLowerCase();
    const title = (f.title || "").toLowerCase();
    const desc = (f.description || "").toLowerCase();
    const cat = (f.category || "").toLowerCase();
    if (!qsets.length) {
      out.push({ f, score: 0, coverage: 0 });
      continue;
    }
    let score = 0;
    let bestCoverage = 0;
    for (const q of qsets) {
      for (const n of q.nums) {
        if (n === num) score += 240;
        else if (num.startsWith(n)) score += 70;
        else if (n.startsWith(num)) score += 40;
      }
      if (q.phrase.length > 3 && q.phrase.includes(num)) score += 180;
      let titleHits = 0, descHits = 0, catHits = 0;
      for (const t of q.terms) {
        if (matchesTerm(title, t)) titleHits++;
        if (matchesTerm(cat, t)) catHits++;
        if (matchesTerm(desc, t)) descHits++;
      }
      const total = Math.max(1, q.terms.length);
      const coverage = Math.min(1, (titleHits + Math.min(descHits, total) * 0.4 + Math.min(catHits, total) * 0.3) / total);
      if (titleHits) score += Math.round(100 * (titleHits / total)) + (titleHits === total ? 10 : 0);
      if (descHits) score += Math.round(12 * (descHits / total));
      if (catHits) score += Math.round(10 * (catHits / total));
      if (q.terms.length && q.phrase.length > 3) {
        if (title.includes(q.phrase)) score += 15;
        else if (desc.includes(q.phrase)) score += 8;
      }
      if (num.includes(q.phrase.replace(/[^a-z0-9]/g, ""))) score += 20;
      if (!q.wantsInfo && /-info$/i.test(number)) score -= 20;
      if (!q.wantsSecondary && SECONDARY_FORM_RE.test(title)) score -= 15;
      // canonical first form of a series (-100 / -001) — only among relevant hits
      if (score > 0 && /(^|-)(001|100)(-|$)/.test(num)) score += 25;
      if (q.hintedSeries.includes(formSeries(f))) score += 20;
      if (coverage > bestCoverage) bestCoverage = coverage;
    }
    if (score > 0) out.push({ f, score, coverage: bestCoverage });
  }
  const byNumber = (a, b) => String(a.f.number).localeCompare(String(b.f.number), undefined, { numeric: true });
  out.sort((a, b) =>
    // with no query (browse-by-series), keep canonical form-number order
    qsets.length
      ? b.score - a.score ||
        b.coverage - a.coverage ||
        a.f.title.split(/\s+/).length - b.f.title.split(/\s+/).length ||
        byNumber(a, b)
      : byNumber(a, b),
  );
  return out.map((x) => x.f);
}

export function searchForms(queries, limit = 12) {
  return rankForms(queries).slice(0, limit);
}

export function famCasesFor(section) {
  const fc = extras.famCases;
  if (!fc || section == null) return null;
  const s = String(section);
  const exact = (fc.fam && fc.fam[s]) || null;
  let range = null;
  const n = parseFloat(s);
  if (!isNaN(n) && fc.ranges) {
    for (const k of Object.keys(fc.ranges)) {
      const parts = k.split("-");
      const a = parseFloat(parts[0]), z = parseFloat(parts[1]);
      if (!isNaN(a) && !isNaN(z) && n >= a && n <= z) { range = { key: k, cases: fc.ranges[k] }; break; }
    }
  }
  if (!exact && !range) return null;
  return { exact, range };
}


export function searchSections(queries, codePriority, limit = 24) {
  const qsets = queries.map((q) => ({ raw: q.toLowerCase(), terms: termsOf(q) }));
  const out = [], perCode = {};
  for (const abbr of Object.keys(loaded)) {
    for (const r of loaded[abbr]) {
      if (r.kind !== "section" || !r.text) continue;
      const hay = ((r.citation || "") + " " + r.text).toLowerCase();
      const citation = (r.citation || "").toLowerCase();
      let score = 0;
      for (const q of qsets) {
        if (q.raw.length > 3 && hay.includes(q.raw)) score += 36;
        for (const t of q.terms) {
          if (citation.includes(t)) score += 12;
          else if (hay.includes(" " + t + " ")) score += Math.min(10, t.length + 3);
          else if (hay.includes(t)) score += Math.min(5, t.length);
        }
      }
      if (score > 0) {
        if (codePriority && codePriority.includes(abbr)) score += 25;
        if (r.repealed) score -= 8;
        out.push({ abbr, r, score });
      }
    }
  }
  out.sort((a, b) => b.score - a.score);
  const res = [];
  for (const o of out) {
    if (res.length >= limit) break;
    perCode[o.abbr] = (perCode[o.abbr] || 0) + 1;
    if (perCode[o.abbr] > 6) continue;
    res.push(o);
  }
  return res;
}

/* ---------- LLM ---------- */
export function parseJsonBlock(txt) {
  let m = String(txt).match(/\{[\s\S]*\}/); if (m) { try { return JSON.parse(m[0]); } catch (e) {} }
  m = String(txt).match(/\[[\s\S]*\]/); if (m) { try { return JSON.parse(m[0]); } catch (e) {} }
  return null;
}

export async function llm(messages, maxTokens) {
  const p = getProvider();
  const key = store.key(store.provider);
  if (p.needsKey && !key) throw new Error("NOKEY:" + p.label);
  const call = async () => {
    const resp = await fetch(p.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...p.header(key) },
      body: JSON.stringify({ model: getModel(), messages, max_tokens: maxTokens }),
    });
    if (!resp.ok) throw new Error("HTTP " + resp.status + " — " + (await resp.text()).slice(0, 200));
    const data = await resp.json();
    const c = (data.choices && data.choices[0] && data.choices[0].message) || {};
    return c.content || c.reasoning_content || "(empty response)";
  };
  try { return await call(); }
  catch (e) { if (String(e.message).includes("429")) { await new Promise((r) => setTimeout(r, 4000)); return await call(); } throw e; }
}

export async function planQuestion(q) {
  const plan = { type: "research", queries: [q], codes: [], subquestions: [] };
  try {
    const out = await llm([{ role: "user", content:
      "Analyze this California law research question. Return ONLY a JSON object, no prose, with keys: type (the string lookup if it asks about one specific section or code number, otherwise research), queries (array of 4-6 short keyword search queries using legal terminology and statutory phrasing), codes (array of 0-4 likely code abbreviations from this list: CONS BPC CIV CCP COM CORP EDC ELEC EVID FAM FIN FGC FAC GOV HNC HSC INS LAB MVC PEN PROB PCC PRC PUC RTC SHC UIC VEH WAT WIC), subquestions (array of 2-4 sub-questions that together answer it).\n\nQuestion: " + q }], 400);
    const pd = parseJsonBlock(out);
    if (pd && pd.queries && pd.queries.length) {
      plan.type = pd.type === "lookup" ? "lookup" : "research";
      plan.queries = [q, ...pd.queries.map(String)].slice(0, 6);
      if (pd.codes && pd.codes.map) plan.codes = pd.codes.map((c) => String(c).toUpperCase().replace(/[^A-Z]/g, "")).filter((c) => byAbbr[c]);
      if (pd.subquestions && pd.subquestions.map) plan.subquestions = pd.subquestions.map(String).slice(0, 4);
    }
  } catch (e) {}
  return plan;
}

export async function analyzeSections(q, candidates) {
  try {
    const listing = candidates.map((x, i) => {
      const cite = x.r.citation || (x.abbr + " § " + x.r.section);
      return "[" + i + "] " + cite + " - " + String(x.r.text || "").slice(0, 700).replace(/\s+/g, " ");
    }).join("\n\n");
    const out = await llm([{ role: "user", content:
      "Research question: " + q + "\n\nCandidate California statute sections:\n\n" + listing +
      "\n\nReturn ONLY a JSON array of the indices (numbers) of the 6-12 sections most relevant to answering, ordered by importance. No prose." }], 400);
    const arr = parseJsonBlock(out);
    if (arr && arr.length) {
      const picked = [];
      for (const a of arr) {
        if (picked.length >= 12) break;
        const idx = parseInt(a, 10);
        if (idx >= 0 && idx < candidates.length && !picked.includes(candidates[idx])) picked.push(candidates[idx]);
      }
      if (picked.length) return picked;
    }
  } catch (e) {}
  return candidates.slice(0, 8);
}

export async function searchCaseLaw(queries) {
  const token = store.clToken;
  const out = [];
  let tried = 0;
  for (const q of queries) {
    if (out.length >= 6 || tried >= 2) break;
    if (!q || q.length < 8) continue;
    tried++;
    try {
      const url = "https://api.courtlistener.com/v3/search/?q=" + encodeURIComponent(q) + "&court=cal+calctapp&type=o&stat_Precedential=on";
      const resp = await fetch(url, { ...(token ? { headers: { Authorization: "Token " + token } } : {}), signal: AbortSignal.timeout(8000) });
      if (!resp.ok) { if (resp.status === 429) break; continue; }
      const data = await resp.json();
      const results = (data && data.results) || [];
      for (const r of results) {
        if (out.length >= 6) break;
        let cite = "";
        try { cite = (r.citations && r.citations[0] && r.citations[0].cite) || ""; } catch (e) {}
        if (out.some((x) => x.caseName === r.caseName)) continue;
        out.push({ caseName: r.caseName || "Unknown case", cite, court: r.court || "", date: r.dateFiled || "",
          snippet: String(r.snippet || "").replace(/<[^>]+>/g, "").slice(0, 700),
          url: r.absolute_url ? "https://www.courtlistener.com" + r.absolute_url : "" });
      }
    } catch (e) { break; }
  }
  if (out.length < 6) {
    try {
      const url2 = "https://api.courtlistener.com/v3/search/?q=" + encodeURIComponent(queries[0]) + "&type=o&stat_Precedential=on";
      const resp2 = await fetch(url2, { ...(token ? { headers: { Authorization: "Token " + token } } : {}), signal: AbortSignal.timeout(8000) });
      if (resp2.ok) {
        const data2 = await resp2.json();
        const results2 = (data2 && data2.results) || [];
        for (const r2 of results2) {
          if (out.length >= 8) break;
          let cite2 = "";
          try { cite2 = (r2.citations && r2.citations[0] && r2.citations[0].cite) || ""; } catch (e) {}
          if (out.some((x) => x.caseName === r2.caseName)) continue;
          out.push({ caseName: r2.caseName || "Unknown case", cite: cite2,
            court: (r2.court || "") + ((r2.court && String(r2.court).indexOf("cal") !== 0) ? " (out-of-state - persuasive only)" : ""),
            date: r2.dateFiled || "",
            snippet: String(r2.snippet || "").replace(/<[^>]+>/g, "").slice(0, 700),
            url: r2.absolute_url ? "https://www.courtlistener.com" + r2.absolute_url : "" });
        }
      }
    } catch (e) {}
  }
  return out;
}

/* ---------- code browser ---------- */
export function buildUnits(abbr) {
  const recs = loaded[abbr] || [];
  const units = [], byPath = {};
  for (const r of recs) {
    if (r.kind === "section") continue;
    const u = { kind: r.kind, number: r.number, title: r.title || "", path: r.path || (r.kind + " " + (r.number || "")), secs: [], children: [] };
    byPath[u.path] = u;
    const pp = u.path.includes(" > ") ? u.path.slice(0, u.path.lastIndexOf(" > ")) : null;
    if (pp && byPath[pp]) byPath[pp].children.push(u); else units.push(u);
  }
  for (const r of recs) { if (r.kind === "section") { const u = byPath[r.path || ""]; if (u) u.secs.push(r); } }
  return units;
}

/* ---------- streaming ---------- */
export async function llmStream(messages, maxTokens, onDelta) {
  const p = getProvider();
  const key = store.key(store.provider);
  if (p.needsKey && !key) throw new Error("NOKEY:" + p.label);
  const resp = await fetch(p.url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...p.header(key) },
    body: JSON.stringify({ model: getModel(), messages, max_tokens: maxTokens, stream: true }),
  });
  if (!resp.ok || !resp.body) throw new Error("HTTP " + resp.status);
  const reader = resp.body.getReader();
  const dec = new TextDecoder();
  let buf = "", full = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop();
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith("data:")) continue;
      const d = t.slice(5).trim();
      if (d === "[DONE]") continue;
      try {
        const j = JSON.parse(d);
        const c = j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content;
        if (c) { full += c; onDelta(c); }
      } catch (e) {}
    }
  }
  if (!full) throw new Error("EMPTYSTREAM");
  return full;
}

/* ---------- follow-up suggestions ---------- */
export async function suggestFollowUps(q, answer) {
  try {
    const out = await llm([{ role: "user", content:
      "Given this exchange about California law, suggest exactly 3 short follow-up research questions a lawyer would ask next (max 12 words each). Return ONLY a JSON array of 3 strings, no prose.\n\nQuestion: " + q + "\n\nAnswer: " + String(answer).slice(0, 1500) }], 200);
    const arr = parseJsonBlock(out);
    if (Array.isArray(arr)) return arr.map(String).filter((s) => s.length > 3 && s.length < 160).slice(0, 3);
  } catch (e) {}
  return [];
}
