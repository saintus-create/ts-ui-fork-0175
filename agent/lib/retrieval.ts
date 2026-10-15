/**
 * Multi-stage retrieval for the law corpus.
 *
 * Treats retrieval as a search-engine problem rather than a single vector lookup:
 *
 *   Stage 1  Question interpretation    — parse terms, phrases, intent, code hints
 *   Stage 2  Hybrid retrieval           — BM25 lexical scoring fused with metadata
 *   Stage 3  Query enrichment (PRF)     — mine *discriminative* expansion terms from
 *                                         the top of the first pass, SPLADE-style,
 *                                         and feed them back as an inspectable
 *                                         expanded query
 *   Stage 4  Reranking                  — an IDF-weighted cross-encoder-style pass
 *                                         over the top candidates (optional LLM hook)
 *   Stage 5  Natural-language screening — include/exclude criteria over the set
 *   Stage 6  Structured records         — citations, passages, and score provenance
 *
 * Deterministic and key-free: for a fixed corpus and query the ranking is
 * reproducible and the expanded terms are returned for inspection. Optional dense
 * embedding / LLM-rerank stages activate only when an endpoint is configured.
 */

import { termsOf, measuresIn, ruleNumsIn } from "./search";

// ---------------------------------------------------------------- tokenisation

const STOP = new Set(
  "what which who whom whose when where why how is are was were be been being am do does did done can could shall should would will may might must i you he she it we they me him her us them my your his its our their this that these those a an the and or but if then than so as of in to for on at by with from into about over under again further once here there all any both each few more most other some such no nor not only own same too very just dont shouldnt now".split(
    " ",
  ),
);

/**
 * Words that carry no topical signal in a statute: they recur in nearly every
 * section and, left in a query, they drown the real terms. Kept out of both the
 * content terms and the pseudo-relevance expansion vocabulary.
 */
const BOILERPLATE = new Set(
  "section sections subdivision subdivisions paragraph subparagraph clause subclause chapter article part division title code codes means mean meaning pursuant following follows provided provide provides including include includes included purposes purpose person persons party parties action actions state states subject property within against thereof herein hereby hereto whereof thereto said other others any all may shall must under upon into from with without this that these those and or of to in for on at by as is are was were be been being has have had not no nor more less than then when where which who whom whose what how why applicable apply applies unless specified otherwise requirements requirement required department local".split(
    " "),
);

function norm(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9\s§.]/g, " ").replace(/\s+/g, " ").trim();
}

/** whole-word occurrences of term in hay (capped for speed) */
function countTerm(hay: string, term: string, cap = 8): number {
  if (!term) return 0;
  let n = 0;
  let i = hay.indexOf(term);
  while (i !== -1 && n < cap) {
    const before = i > 0 ? hay[i - 1] : " ";
    const after = i + term.length < hay.length ? hay[i + term.length] : " ";
    if (!/[a-z0-9]/.test(before) && !/[a-z0-9]/.test(after)) n++;
    i = hay.indexOf(term, i + term.length);
  }
  return n;
}

function stem(t: string): string {
  return t.length > 4 && t.endsWith("s") ? t.slice(0, -1) : t;
}

/** matches of a query term: the exact word or its simple plural stem */
function termHits(hay: string, term: string, cap = 8): number {
  return Math.max(countTerm(hay, term, cap), countTerm(hay, stem(term), cap));
}

function tokens(text: string): string[] {
  // expansion vocabulary is alphabetic only — cross-reference numbers, section
  // numbers and dates are not topical terms and pollute the second pass
  return norm(text)
    .split(" ")
    .filter((w) => w.length >= 6 && /^[a-z]+$/.test(w));
}

// ------------------------------------------------------- stage 1: interpretation

export type QueryIntent =
  | "definition"
  | "elements"
  | "procedure"
  | "interpretation"
  | "comparison"
  | "general";

export interface QueryPlan {
  raw: string;
  terms: string[];
  phrases: string[];
  intent: QueryIntent;
  codeHints: string[];
  sectionRefs: string[];
  measures: string[];
  ruleNums: string[];
  mode: "hybrid" | "keyword";
}

const CODE_HINT_RE =
  /\b(family|penal|civil|government|insurance|education|evidence|welfare|business|professions|health|safety|revenue|taxation|vehicle|water|labor|elections|probate|streets|highways|public\s+contract|harbors|navigation|military|veterans|food|agricultural|corporations|financial|commercial|fish|game|resources|utilities|unemployment)\s+code\b/g;

const CODE_WORD_TO_ABBR: Record<string, string> = {
  family: "FAM", penal: "PEN", civil: "CIV", government: "GOV", insurance: "INS",
  education: "EDU", evidence: "ETD", welfare: "WEL", business: "BPC", professions: "BPC",
  health: "HSC", safety: "HSC", revenue: "RTC", taxation: "RTC", vehicle: "VEH",
  water: "WAT", labor: "LAB", elections: "ELEC", probate: "PROB", streets: "SHC",
  highways: "SHC", public: "PUBCON", harbors: "HNC", navigation: "HNC", military: "MIL",
  veterans: "MIL", food: "FAC", agricultural: "FAC", corporations: "CORP",
  financial: "FIN", commercial: "COM", fish: "FGC", game: "FGC", resources: "PUBRES",
  utilities: "PUC", unemployment: "UIC",
};

// Everyday words vs the words the statutes actually use.
//
// Pen. Code 802(a) answers a "misdemeanor" limitations question without ever
// saying "misdemeanor" — it says "an offense not punishable by ... imprisonment
// in the state prison". A keyword search for the user's word therefore cannot
// reach the section that answers the question, and a neighbouring provision (the
// felony rule in 801, which does say "imprisonment in the state prison") wins on
// term overlap. Measured: that produced a confident, cited, wrong answer —
// "three years" for a misdemeanor. These map the everyday term to the statutory
// phrasing so the right section is reachable.
const LEGAL_EQUIVALENTS: Array<[RegExp, string[]]> = [
  [
    /\bmisdemeanou?rs?\b/i,
    ["not punishable by imprisonment in the state prison", "imprisonment in the county jail"],
  ],
  [/\bfelon(?:y|ies)\b/i, ["punishable by imprisonment in the state prison"]],
  [/\bstatute of limitations\b/i, ["shall be commenced within", "commenced within"]],
  [/\b(?:elements?|requirements?|prima facie)\b/i, ["every person who", "is guilty of"]],
  [/\bdeadline\b/i, ["shall be filed within", "no later than"]],
  [/\bnotice\b/i, ["written notice", "reasonable notice"]],
];

export function interpretQuery(
  question: string,
  opts: { codes?: string[]; mode?: "hybrid" | "keyword" } = {},
): QueryPlan {
  const raw = String(question || "");
  const lower = raw.toLowerCase();

  const terms = termsOf(raw).filter((t) => !BOILERPLATE.has(t) && !STOP.has(t));

  const words = norm(raw).split(" ").filter(Boolean);
  const phrases: string[] = [];
  for (let i = 0; i < words.length - 1; i++) {
    const a = words[i], b = words[i + 1];
    if (a.length > 3 && b.length > 3 && !STOP.has(a) && !STOP.has(b) && !BOILERPLATE.has(a) && !BOILERPLATE.has(b)) {
      phrases.push(`${a} ${b}`);
      const c = words[i + 2];
      if (c && c.length > 3 && !STOP.has(c) && !BOILERPLATE.has(c)) phrases.push(`${a} ${b} ${c}`);
    }
  }

  const intent: QueryIntent =
    /\b(elements?|consists? of|what are the requirements|to prove|prima facie)\b/i.test(lower)
      ? "elements"
      : /\b(difference|versus|vs\.?|compare|distinguish)\b/i.test(lower)
        ? "comparison"
        : /\b(deadline|file|filing|serv(e|ice)|notice|hearing|motion|procedure|appeal|continuance|discovery|venue)\b/i.test(lower)
          ? "procedure"
          : /\b(define|definition|mean(s|ing)?|what is|what's|include)\b/i.test(lower)
            ? "definition"
            : /\b(interpret|court|held|hold|apply|construe|case law)\b/i.test(lower)
              ? "interpretation"
              : "general";

  const hinted = new Set<string>();
  for (const m of lower.match(CODE_HINT_RE) || []) {
    const abbr = CODE_WORD_TO_ABBR[m.replace(/\s+code$/, "").trim()];
    if (abbr) hinted.add(abbr);
  }
  for (const c of opts.codes || []) hinted.add(c.toUpperCase());

  const sectionRefs = Array.from(
    new Set((raw.match(/(?:§|section)\s*(\d+[\w.-]*)/gi) || []).map((s) => s.replace(/.*?(\d)/, "$1"))),
  );

  // Statutory phrasings lead: they are the highest-value signal for the section
  // that actually answers the question, so they must survive the slice below.
  const equivalents = LEGAL_EQUIVALENTS.filter(([re]) => re.test(lower)).flatMap(([, extra]) => extra);

  return {
    raw,
    terms,
    phrases: Array.from(new Set([...equivalents, ...phrases])).slice(0, 14),
    intent,
    codeHints: Array.from(hinted),
    sectionRefs,
    measures: measuresIn(raw),
    ruleNums: ruleNumsIn(raw),
    mode: opts.mode || "hybrid",
  };
}

// ------------------------------------------------ stage 2: hybrid retrieval (BM25)

export interface Signals {
  bm25: number;
  expansion: number;
  phrase: number;
  definition: number;
  metadata: number;
  rerank: number;
}

export interface RetrievedDoc {
  abbr: string;
  r: Record<string, unknown>;
  score: number;
  signals: Signals;
  matchedExpansion: string[];
}

const K1 = 1.2;
const B = 0.75;

function historyYear(r: Record<string, unknown>): number | null {
  const years = (String(r.history || "").match(/\b(1[89]\d{2}|20\d{2})\b/g) || [])
    .map(Number)
    .filter((y) => y >= 1850 && y <= 2100);
  return years.length ? Math.max(...years) : null;
}

function isDefinitionText(t: string): boolean {
  return (
    t.includes("means any of the following") ||
    /[\u201c"][^\u201d"]{1,60}[\u201d"]\s+means\s/.test(t) ||
    (/\bmeans\b/.test(t) && /\b(as used in|for purposes of|in this (chapter|article|part|division|title))\b/.test(t))
  );
}

interface Cand {
  abbr: string;
  r: Record<string, unknown>;
  hay: string;
  len: number;
  tf: Map<string, number>;
}

export function hybridRetrieve(
  records: Array<{ abbr: string; r: Record<string, unknown> }>,
  plan: QueryPlan,
  opts: { limit?: number; rerankPool?: number; expand?: boolean; rerank?: boolean } = {},
): { docs: RetrievedDoc[]; expandedTerms: string[]; stats: Record<string, number> } {
  const limit = opts.limit ?? 16;
  const rerankPool = opts.rerankPool ?? Math.max(100, limit * 6);
  const doExpand = opts.expand !== false && plan.mode === "hybrid";
  const doRerank = opts.rerank !== false;

  const qterms = Array.from(new Set(plan.terms));
  const df = new Map<string, number>();
  let nDocs = 0;
  let totalLen = 0;
  const cands: Cand[] = [];

  for (const { abbr, r } of records) {
    if (!r.text) continue;
    // statutes carry kind="section"; rules/bills may omit kind entirely
    if (r.kind && r.kind !== "section") continue;
    // headings matter: a section is retrievable by the topic words of the
    // division/part/title/chapter/article it sits under, not just its own text
    const structural = [r.division, r.part, r.title, r.chapter, r.article, r.path]
      .map((x) => String(x || ""))
      .filter(Boolean)
      .join(" ");
    const hay = norm(String(r.citation || "") + " " + structural + " " + String(r.text));
    nDocs++;
    totalLen += hay.length;

    const tf = new Map<string, number>();
    for (const t of qterms) {
      const n = termHits(hay, t);
      if (n > 0) {
        tf.set(t, n);
        df.set(t, (df.get(t) || 0) + 1);
      }
    }
    if (tf.size) cands.push({ abbr, r, hay, len: hay.length, tf });
  }

  const avgdl = nDocs ? totalLen / nDocs : 1;
  const idfOf = (t: string) => {
    const d = df.get(t) || 0;
    return Math.log(1 + (nDocs - d + 0.5) / (d + 0.5));
  };

  const scored = cands.map((c) => {
    let bm25 = 0;
    for (const [t, f] of c.tf) {
      const denom = f + K1 * (1 - B + (B * c.len) / avgdl);
      bm25 += idfOf(t) * ((f * (K1 + 1)) / denom);
    }
    let phrase = 0;
    for (const p of plan.phrases) {
      const n = countTerm(c.hay, p, 3);
      if (n > 0) phrase += 4 + Math.min(6, p.split(" ").length * 2) * n;
    }
    const textLower = String(c.r.text || "").toLowerCase();
    const definition =
      (isDefinitionText(textLower) ? 5 : 0) +
      (qterms.some((t) => textLower.includes(`“${t}” means`) || textLower.includes(`"${t}" means`)) ? 10 : 0);
    let metadata = 0;
    if (plan.codeHints.includes(c.abbr)) metadata += 8;
    const yr = historyYear(c.r);
    if (yr) metadata += Math.max(0, (yr - 1950) / 15);
    if (c.r.repealed) metadata -= 5;
    return {
      abbr: c.abbr,
      r: c.r,
      hay: c.hay,
      base: bm25 + phrase + definition + metadata,
      signals: { bm25, expansion: 0, phrase, definition, metadata, rerank: 0 } as Signals,
      matchedExpansion: [] as string[],
    };
  });

  scored.sort((a, b) => b.base - a.base);

  // ---- Stage 3: query enrichment (discriminative pseudo-relevance terms)
  let expandedTerms: string[] = [];
  if (doExpand && scored.length > 3) {
    const top = scored.slice(0, Math.min(25, scored.length));
    const poolDf = new Map<string, number>();
    const qset = new Set(qterms.flatMap((t) => [t, stem(t)]));
    for (const d of top) {
      for (const tok of new Set(tokens(String(d.r.text || "")))) {
        if (qset.has(tok) || qset.has(stem(tok))) continue;
        if (STOP.has(tok) || BOILERPLATE.has(tok)) continue;
        if (/^\d+$/.test(tok)) continue;
        poolDf.set(tok, (poolDf.get(tok) || 0) + 1);
      }
    }
    const poolSize = top.length;
    expandedTerms = Array.from(poolDf.entries())
      // keep terms that recur across several top docs but are not universal —
      // discriminative topical terms, never boilerplate or one-off noise
      .filter(([, n]) => n >= 3 && n <= Math.floor(poolSize * 0.4))
      .map(([t, n]) => ({ t, w: Math.log(poolSize / n) }))
      .sort((a, b) => b.w - a.w || a.t.localeCompare(b.t))
      .slice(0, 6)
      .map((x) => x.t);

    if (expandedTerms.length) {
      for (const d of scored) {
        let ex = 0;
        for (const t of expandedTerms) {
          if (termHits(d.hay, t, 2) > 0) {
            ex += 1;
            d.matchedExpansion.push(t);
          }
        }
        d.signals.expansion = ex;
        d.base += ex * 1.0; // modest: enrichment must not outvote the query terms
      }
      scored.sort((a, b) => b.base - a.base);
    }
  }

  // ---- Stage 4: reranking (IDF-weighted, cross-encoder style)
  const pool = scored.slice(0, rerankPool);
  if (doRerank && pool.length) {
    const maxBase = Math.max(...pool.map((d) => d.base)) || 1;
    const totalIdf = qterms.reduce((s, t) => s + idfOf(t), 0) || 1;
    for (const d of pool) {
      // IDF-weighted coverage: matching a rare query term counts far more
      let covered = 0;
      for (const t of qterms) if (termHits(d.hay, t, 1) > 0) covered += idfOf(t);
      const coverage = covered / totalIdf;

      // proximity: tightest window between distinct query terms
      const positions: number[] = [];
      for (const t of qterms) {
        const i = d.hay.indexOf(stem(t));
        if (i !== -1) positions.push(i);
      }
      let proximity = 0;
      if (positions.length >= 2) {
        positions.sort((a, b) => a - b);
        let minSpan = Infinity;
        for (let i = 1; i < positions.length; i++) minSpan = Math.min(minSpan, positions[i] - positions[i - 1]);
        proximity = 1 / (1 + minSpan / 80);
      }
      const title = norm(String(d.r.title || ""));
      const titleHit = qterms.some((t) => title.includes(t)) ? 1 : 0;

      const rerank = 0.6 * coverage + 0.25 * proximity + 0.15 * titleHit;
      d.signals.rerank = Number(rerank.toFixed(4));
      d.base = 0.8 * (d.base / maxBase) + 0.2 * rerank;
    }
    pool.sort((a, b) => b.base - a.base || String(a.r.citation || "").localeCompare(String(b.r.citation || "")));
  }

  return {
    docs: pool.slice(0, limit).map((d) => ({
      abbr: d.abbr,
      r: d.r,
      score: Number(d.base.toFixed(4)),
      signals: d.signals,
      matchedExpansion: d.matchedExpansion,
    })),
    expandedTerms,
    stats: { scanned: nDocs, candidates: cands.length, reranked: pool.length },
  };
}

// ------------------------------------------------- stage 5: screening

export interface ScreenCriteria {
  include?: string[];
  exclude?: string[];
}

export function screenDocs(docs: RetrievedDoc[], criteria: ScreenCriteria): RetrievedDoc[] {
  const inc = (criteria.include || []).map((c) => termsOf(c)).filter((t) => t.length);
  const exc = (criteria.exclude || []).map((c) => termsOf(c)).filter((t) => t.length);
  if (!inc.length && !exc.length) return docs;
  return docs.filter((d) => {
    const hay = norm(String(d.r.text || "") + " " + String(d.r.citation || ""));
    for (const group of exc) if (group.some((t) => termHits(hay, t, 1) > 0)) return false;
    for (const group of inc) if (!group.some((t) => termHits(hay, t, 1) > 0)) return false;
    return true;
  });
}

// ---------------------------------------- optional dense / LLM hooks (key-free fallback)

export function embeddingsConfigured(): boolean {
  return !!(process.env.EMBEDDING_API_BASE && (process.env.EMBEDDING_API_KEY || process.env.OPENAI_API_KEY));
}

export function llmRerankConfigured(): boolean {
  return (
    process.env.RETRIEVAL_LLM_RERANK === "1" &&
    !!(process.env.SARVAM_API_KEY || process.env.OPENAI_API_KEY || process.env.OPENROUTER_API_KEY)
  );
}

/** Optional dense fusion — no-op unless an embeddings endpoint is configured. */
export async function fuseEmbeddings(
  docs: RetrievedDoc[],
  query: string,
  weight = 0.35,
): Promise<RetrievedDoc[]> {
  if (!embeddingsConfigured() || !docs.length) return docs;
  try {
    const base = process.env.EMBEDDING_API_BASE as string;
    const model = process.env.EMBEDDING_MODEL || "text-embedding-3-small";
    const key = (process.env.EMBEDDING_API_KEY || process.env.OPENAI_API_KEY) as string;
    const texts = [query, ...docs.map((d) => String(d.r.text || "").slice(0, 2000))];
    const res = await fetch(`${base.replace(/\/$/, "")}/embeddings`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, input: texts }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return docs;
    const json = (await res.json()) as { data?: Array<{ embedding: number[] }> };
    const vecs = json.data?.map((d) => d.embedding) || [];
    if (vecs.length !== texts.length) return docs;
    const cos = (a: number[], b: number[]) => {
      let s = 0, na = 0, nb = 0;
      for (let i = 0; i < a.length; i++) { s += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
      return s / (Math.sqrt(na) * Math.sqrt(nb) || 1);
    };
    const qv = vecs[0];
    return docs
      .map((d, i) => ({ ...d, score: Number(((1 - weight) * d.score + weight * cos(qv, vecs[i + 1])).toFixed(4)) }))
      .sort((a, b) => b.score - a.score);
  } catch {
    return docs;
  }
}
