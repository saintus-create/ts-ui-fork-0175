import { z } from "zod";
import searchStatutes from "./search_statutes";
import searchBills from "./search_bills";
import searchRules from "./search_rules";
import searchForms from "./search_forms";
import searchCases from "./search_cases";
import { runResearchAgents } from "../lib/agents";

/**
 * The research engine creates an evidence ledger before answer generation.
 * The ledger is deliberately explicit about what a source can establish,
 * what remains unknown, and what must be verified next.
 */

export const researchInputSchema = z.object({
  question: z.string().min(2),
});

type AuthorityType =
  | "statute"
  | "case"
  | "rule"
  | "bill"
  | "form"
  // Words and Phrases (West's California Digest 2d): a finding aid that reports
  // how courts construed a term. It is not authority itself, which is why it
  // carries its own type rather than posing as a case.
  | "words_and_phrases";
type ResearchMode = "direct" | "analytical" | "deep";
type VerificationState = "retrieved" | "needs_followup" | "unverified";
type RelationshipType =
  | "interprets"
  | "amends"
  | "supersedes"
  | "distinguishes"
  | "potentially_conflicts"
  | "chronologically_related";

type ResearchSource = {
  source_id: string;
  marker: string;
  authority_type: AuthorityType;
  authority_role: "primary" | "binding_interpretation" | "procedural" | "legislative";
  citation: string;
  title: string;
  date: string | null;
  status: string | null;
  jurisdiction: string;
  temporal_fit: "current" | "historical" | "unknown";
  binding_weight: "constitutional" | "statute" | "supreme_court" | "court_of_appeal" | "rule" | "form" | "legislative_material" | "secondary";
  relevant_passage: string;
  supported_proposition: string;
  relevance_reason: string;
  verification: VerificationState;
  url: string | null;
};

type Proposition = {
  proposition_id: string;
  source_ids: string[];
  statement: string;
  support_type: "direct_text" | "case_statement" | "legislative_record";
  status: "supported" | "needs_verification";
};

type Relationship = {
  relationship_id: string;
  type: RelationshipType;
  from_source_id: string;
  to_source_id: string;
  reason: string;
  verification: VerificationState;
};

type ChronologyEvent = {
  event_id: string;
  source_id: string;
  date: string | null;
  event: "enacted" | "amended" | "effective" | "interpreted" | "repealed" | "status_change" | "unknown";
  description: string;
};



type ResearchTaskKind =
  | "governing_law"
  | "temporal_status"
  | "interpretation"
  | "procedure"
  | "legislative_history"
  | "application"
  | "comparison"
  | "conflict_resolution"
  | "forms";

type ResearchTaskStatus = "pending" | "complete" | "incomplete" | "blocked";

type ResearchTask = {
  task_id: string;
  kind: ResearchTaskKind;
  question: string;
  queries: string[];
  required_authority: AuthorityType[];
  completion_criteria: string[];
  source_ids: string[];
  proposition_ids: string[];
  status: ResearchTaskStatus;
  attempts: number;
  blocking: boolean;
  missing_evidence: string[];
};

type StructuredIssue = ResearchRecord["issue"] & {
  relevant_law: string[];
};

type EvidenceGap = {
  gap_id: string;
  issue: string;
  why_it_matters: string;
  required_authority: AuthorityType | "any";
  search_queries: string[];
  status: "open" | "addressed";
};

export type ResearchRecord = {
  schema_version: "2.0";
  question: string;
  issue: {
    legal_issue: string;
    relevant_law: string[];
    jurisdiction: string;
    timeframe: string | null;
    procedural_posture: string | null;
    actors: string[];
    factual_predicates: string[];
    requested_comparison: string | null;
  };
  mode: ResearchMode;
  research_plan: string[];
  tasks: ResearchTask[];
  sources: ResearchSource[];
  propositions: Proposition[];
  relationships: Relationship[];
  chronology: ChronologyEvent[];
  evidence_gaps: EvidenceGap[];
  verification_tasks: string[];
  research_errors: string[];
  synthesis_requirements: string[];
  answer_contract: {
    must_cite_propositions: boolean;
    citation_format: string;
    may_use_uncited_general_knowledge: false;
    unsupported_claim_action: "research_or_state_unverified";
  };
};

function clean(value: unknown, max = 1600): string {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

/** dedupe values by a computed key (first occurrence wins) */
function unique<T>(arr: readonly T[], key: (x: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const x of arr) {
    const k = key(x);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(x);
  }
  return out;
}

function terms(question: string): string[] {
  return question
    .replace(/[^\p{L}\p{N}\s§.-]/gu, " ")
    .split(/\s+/)
    .map((x) => x.trim())
    .filter((x) => x.length >= 3)
    .filter((x) => !/^(difference|differences|different|between|versus|vs|compared|compare|comparison|similar|alike|same|tell|every|charges|charge|charged|charging|file|filed|filing|apply|applies|what|when|where|which|does|did|can|could|would|should|how|why|the|and|for|with|from|about|under|into|have|has|this|that|there|their|they|are|was|were|is|of|to|a|an|in|on|or|be|as|by|it)$/i.test(x));
}

function inferMode(issue: StructuredIssue, question: string): ResearchMode {
  if (issue.timeframe || issue.requested_comparison || /history|historical|amend|effective|retroactive|superseded|repealed|conflict/i.test(question)) return "deep";
  if (issue.procedural_posture || /interpret|apply|valid|invalid|void|constitutional|due process|exception|elements|standard|require/i.test(question)) return "analytical";
  return "direct";
}

function inferIssue(question: string): StructuredIssue {
  const normalized = clean(question, 1200);
  const actors = Array.from(new Set(
    (normalized.match(/\b(?:court|judge|police|officer|prosecutor|district attorney|defendant|petitioner|respondent|agency|legislature|governor|county|city|state|party|parties)\b/gi) || [])
      .map((x) => x.toLowerCase()),
  ));

  const dates = normalized.match(/\b(?:19|20)\d{2}\b/g) || [];
  const dateRanges = normalized.match(/\b(?:19|20)\d{2}\s*(?:-|to|through|–)\s*(?:19|20)\d{2}\b/gi) || [];
  const timeframe = dateRanges.length ? Array.from(new Set(dateRanges)).join("; ") : dates.length ? Array.from(new Set(dates)).join(", ") : null;

  const legalRefs = normalized.match(/\b(?:[A-Z][A-Za-z]{1,5}\s+Code|California Code of Civil Procedure|California Penal Code|California Family Code|California Evidence Code|California Constitution|Code of Civil Procedure|Penal Code|Family Code|Evidence Code)\s*(?:§|section)?\s*[\w.-]+(?:\([a-z0-9]+\))*/gi) || [];
  const sectionRefs = normalized.match(/(?:§|section)\s*\d+[\w.-]*(?:\([a-z0-9]+\))*/gi) || [];
  const relevantLaw = Array.from(new Set([...legalRefs, ...sectionRefs].map(clean))).slice(0, 8);

  const posturePatterns = [
    /\b(?:on appeal|appeal|appellate|trial|hearing|motion|warrant|arrest|petition|complaint|restraining order|judgment|sentencing|conviction|dismissal|pretrial|pre-trial|diversion|discovery|service|notice)\b[^.;?]*/i,
  ];
  const proceduralPosture = clean(posturePatterns.find((p) => p.test(normalized))?.exec(normalized)?.[0] || "", 300) || null;

  const comparison = /\b(?:compare|versus|vs\.?|difference|different|same|conflict|contradict|relationship|relative to|compared with)\b/i.test(normalized)
    ? clean(normalized, 360)
    : relevantLaw.length > 1 ? relevantLaw.join(" vs. ") : null;

  const clauses = normalized
    .split(/\?|;|\n|(?<=\.)\s+(?=[A-Z])/)
    .map((x) => clean(x, 240))
    .filter(Boolean);
  const facts = clauses.filter((x) =>
    /\b(?:on|before|after|when|while|because|alleged|occurred|happened|arrested|served|filed|entered|issued|sent|received|contacted|did|was|were|is|are)\b/i.test(x),
  ).slice(0, 8);

  // prefer the interrogative clause (what/whether/how ...) over past-tense
  // fact clauses — the legal issue is the question, not the facts
  const legalIssue = clean(
    clauses.find((x) => /\b(?:what|whether|how|why|which|when|where)\b/i.test(x)) ||
    clauses.find((x) => /\b(?:does|did|can|could|may|is|are|was|were|under|violate|apply|require|mean)\b/i.test(x)) ||
    normalized,
    500,
  );

  return {
    legal_issue: legalIssue,
    relevant_law: relevantLaw,
    jurisdiction: /federal|u\.s\.c\.|united states|constitution of the united states/i.test(normalized)
      ? "California law with federal authority if implicated"
      : /california|\bca\b|cal\.?/i.test(normalized)
        ? "California"
        : "California unless the sources establish otherwise",
    timeframe,
    procedural_posture: proceduralPosture,
    actors,
    factual_predicates: facts.length ? facts : [normalized],
    requested_comparison: comparison,
  };
}

function task(
  taskId: string,
  kind: ResearchTaskKind,
  question: string,
  queries: string[],
  requiredAuthority: AuthorityType[],
  completionCriteria: string[],
  blocking = true,
): ResearchTask {
  return {
    task_id: taskId,
    kind,
    question,
    queries: unique(queries.filter((q) => q.trim().length >= 2), (q) => q.toLowerCase()).slice(0, 4),
    required_authority: requiredAuthority,
    completion_criteria: completionCriteria,
    source_ids: [],
    proposition_ids: [],
    status: "pending",
    attempts: 0,
    blocking,
    missing_evidence: [],
  };
}

// lay legal words vs statutory words: expand common colloquial terms so
// charging questions retrieve the full offense family (homicide -> murder,
// manslaughter, ...)
const LEGAL_SYNONYMS: Record<string, string[]> = {
  homicide: ["murder", "manslaughter"],
  murder: ["homicide", "manslaughter"],
  manslaughter: ["murder", "homicide"],
  theft: ["larceny", "embezzlement", "robbery"],
  larceny: ["theft", "embezzlement"],
  embezzlement: ["theft", "larceny"],
  robbery: ["theft", "larceny"],
  burglary: ["theft", "robbery"],
  assault: ["battery"],
  battery: ["assault"],
  dui: ["driving under the influence"],
  "restraining order": ["protective order", "domestic violence"],
  "protective order": ["restraining order", "domestic violence"],
  eviction: ["unlawful detainer"],
  divorce: ["dissolution of marriage"],
  custody: ["visitation", "guardianship"],
  harassment: ["stalking", "civil harassment"],
  stalking: ["harassment"],
};

function expandLegalTerms(words: string[]): string[] {
  const out: string[] = [];
  for (const w of words) {
    out.push(w);
    for (const s of LEGAL_SYNONYMS[w.toLowerCase()] || []) out.push(s);
  }
  return unique(out, (x) => x.toLowerCase()).slice(0, 14);
}

function planTasks(issue: StructuredIssue, question: string): ResearchTask[] {
  // search terms lead with the LEGAL words from the issue clause (homicide,
  // charges, defenses) — fact words (homeowner, intruder) alone retrieve junk
  const law = issue.relevant_law.length
    ? issue.relevant_law
    : expandLegalTerms(terms(issue.legal_issue));
  const base = unique([issue.legal_issue, ...issue.relevant_law, ...issue.factual_predicates], (x) => x.toLowerCase());
  const tasks: ResearchTask[] = [
    task("task-1", "governing_law",
      `What California law governs this issue: ${issue.legal_issue}?`,
      // governing-law searches use LEGAL terms only — fact words (homeowner,
      // intruder) retrieve landlord-tenant junk and drown the penal code
      unique([...law, ...issue.relevant_law], (x) => x.toLowerCase()),
      ["statute"],
      ["At least one operative statutory or constitutional provision directly addresses the issue.", "The retrieved text identifies the relevant provision rather than merely a topical match."]),
  ];

  if (issue.timeframe) {
    tasks.push(task("task-2", "temporal_status",
      `What law was operative during ${issue.timeframe}?`,
      unique([...law.map((x) => `${x} effective date`), ...base.slice(0, 2).map((x) => `${x} amendment effective`)], (x) => x.toLowerCase()),
      ["statute", "bill"],
      ["Operative statutory text is identified.", "Effective-date or amendment evidence establishes which version applied to the relevant date."]));
  }

  const interpretationNeeded =
    !!issue.procedural_posture ||
    /mean|interpret|apply|valid|invalid|void|constitutional|due process|exception|element|standard|require|whether|case law|held|holding|defin|charge|charged|crime|offense|guilty|defens|penalt|sentenc|felon|misdemeanor|violat|arrest|warrant|search|seizure|evidence|liab|right/i.test(
      question,
    );
  if (interpretationNeeded) {
    tasks.push(task(`task-${tasks.length + 1}`, "interpretation",
      `How have controlling California appellate courts interpreted or applied the governing law?`,
      unique([...law, ...base.slice(0, 3)].map((x) => `${x} California Court of Appeal Supreme Court`), (x) => x.toLowerCase()),
      ["case"],
      ["A relevant published California appellate or Supreme Court opinion is retrieved when interpretation is legally material.", "The proposition is tied to the opinion's actual reported text or holding, not keyword similarity."]));
  }

  if (issue.procedural_posture || /procedure|procedural|notice|service|deadline|hearing|warrant|filing|motion|appeal|trial|discovery/i.test(question)) {
    tasks.push(task(`task-${tasks.length + 1}`, "procedure",
      `What procedural rules govern the identified posture: ${issue.procedural_posture || "the procedure implicated by the question"}?`,
      unique([`${issue.procedural_posture || ""} California Rules of Court`, ...base.slice(0, 2).map((x) => `${x} notice service hearing deadline`)], (x) => x.toLowerCase()),
      ["rule"],
      ["A relevant California Rule of Court is retrieved when court procedure is implicated.", "The rule addresses the actual procedural mechanism at issue."]));
  }

  // Judicial Council forms: any explicit form number/series, form-filing
  // language ("what form do I file", "mandatory form"), or self-help procedure.
  const formsNeeded =
    /\bforms?\b|judicial council form|fillable|form number|self-help|pleading paper|\b(?:ADOPT|ADR|APP|AT|CH|CM|CR|DE|DISC|DV|EA|EFS|EJ|EJT|EPO|FL|FW|GC|GDC|GV|HC|ICWA|INT|JV|JURY|MC|MIL|NC|PLD|POS|RA|SC|SUBP|SUM|UD|VL|WG|WV|CP10)[-\s]?\d{1,4}\b/i.test(
      question,
    );
  if (formsNeeded) {
    // Query the forms corpus with the filer's own topic words: "domestic
    // violence restraining order", not the raw question, and never the words
    // every form shares ("judicial council form").
    const formNoise = new Set([
      "form", "forms", "court", "courts", "judicial", "council", "mandatory",
      "optional", "statewide", "official", "need", "needed", "needs",
    ]);
    const formTopic = terms(question)
      .filter((w) => !formNoise.has(w.toLowerCase()))
      .slice(0, 6)
      .join(" ");
    const posture = String(issue.procedural_posture || "")
      .split(/\s*[,;]\s*|\band\b/i)[0]
      .trim();
    const formQueries = unique(
      [
        formTopic,
        posture.length > 3 ? `${posture} form` : "",
        ...law.filter((x) => !/judicial|council/i.test(x)).slice(0, 1).map((x) => `${x} form`),
        issue.legal_issue.length <= 90 ? `${issue.legal_issue} form` : "",
      ]
        .filter((x) => x.length > 3)
        // drop candidates made only of shared form words ("forms form")
        .filter((x) => terms(x).some((w) => !formNoise.has(w.toLowerCase()))),
      (x) => x.toLowerCase(),
    ).slice(0, 3);
    tasks.push(task(`task-${tasks.length + 1}`, "forms",
      `Which Judicial Council form(s) implement this request, and are they mandatory?`,
      formQueries,
      ["form"],
      ["The specific Judicial Council form number is retrieved from the forms corpus.", "Mandatory versus optional use and the form's effective date are established."],
      false));
  }

  if (issue.timeframe || /amend|amended|legislative history|legislature|bill|chaptered|new law|recent law|current law|former|prior/i.test(question)) {
    tasks.push(task(`task-${tasks.length + 1}`, "legislative_history",
      `Which amendments or legislative actions changed the governing provision, and when?`,
      unique([...law.map((x) => `${x} amendment bill chaptered`), ...base.slice(0, 2).map((x) => `${x} legislative history`)], (x) => x.toLowerCase()),
      ["bill", "statute"],
      ["Relevant amendment or legislative record is retrieved.", "The record permits the amendment/status to be distinguished from merely proposed legislation."]));
  }

  if (issue.factual_predicates.length) {
    tasks.push(task(`task-${tasks.length + 1}`, "application",
      `What supported authority connects the governing law to these facts: ${issue.factual_predicates.slice(0, 3).join(" | ")}?`,
      unique([...law, ...issue.factual_predicates.slice(0, 3)], (x) => x.toLowerCase()),
      ["statute", ...(interpretationNeeded ? ["case" as AuthorityType] : [])],
      ["Each material application proposition is supported by retrieved authority.", "The record distinguishes the source's rule from the model's application of facts."],
      false));
  }

  if (issue.requested_comparison) {
    tasks.push(task(`task-${tasks.length + 1}`, "comparison",
      `What documented differences or relationships must be established for the requested comparison?`,
      unique([issue.requested_comparison, ...law], (x) => x.toLowerCase()),
      ["statute", "case"],
      ["Each side of the comparison has identified authority.", "Differences are based on text, dates, jurisdiction, posture, or holding rather than shared words."],
      false));
  }

  return tasks;
}

function refreshTaskStatus(tasks: ResearchTask[], sources: ResearchSource[], propositions: Proposition[]) {
  for (const t of tasks) {
    const matching = sources.filter((s) => t.required_authority.includes(s.authority_type) && (
      t.queries.some((q) => terms(q).some((term) => (s.citation + " " + s.title + " " + s.relevant_passage).toLowerCase().includes(term.toLowerCase()))) ||
      t.required_authority.length === 1
    ));
    t.source_ids = unique(matching, (s) => s.source_id).map((s) => s.source_id);
    t.proposition_ids = propositions.filter((p) => p.source_ids.some((id) => t.source_ids.includes(id))).map((p) => p.proposition_id);
    t.missing_evidence = [];

    for (const authority of t.required_authority) {
      if (!t.source_ids.some((id) => sources.find((s) => s.source_id === id)?.authority_type === authority)) {
        t.missing_evidence.push(`No retrieved ${authority} authority.`);
      }
    }

    if (t.kind === "temporal_status" && !sources.some((s) => t.source_ids.includes(s.source_id) && (s.date || s.status || s.relevant_passage))) {
      t.missing_evidence.push("No date/status evidence establishing the operative version.");
    }
    if (t.kind === "interpretation" && !sources.some((s) => t.source_ids.includes(s.source_id) && s.authority_type === "case" && s.relevant_passage.length > 20)) {
      t.missing_evidence.push("No usable judicial interpretation passage.");
    }
    if (t.kind === "procedure" && !sources.some((s) => t.source_ids.includes(s.source_id) && s.authority_type === "rule" && s.relevant_passage.length > 20)) {
      t.missing_evidence.push("No usable procedural rule text.");
    }
    if (t.kind === "forms" && !sources.some((s) => t.source_ids.includes(s.source_id) && s.authority_type === "form")) {
      t.missing_evidence.push("No Judicial Council form retrieved for the filing step.");
    }
    t.status = t.missing_evidence.length ? (t.attempts ? "incomplete" : "pending") : "complete";
  }
}

function followupQueriesForTask(t: ResearchTask, sources: ResearchSource[]): string[] {
  const have = sources.filter((s) => t.source_ids.includes(s.source_id)).map((s) => s.citation).filter(Boolean);
  const missing = t.missing_evidence.join(" ");
  return unique([
    ...t.queries,
    ...have.slice(0, 3).map((c) => `${c} ${missing}`),
    `${t.question} ${missing}`,
  ], (x) => x.toLowerCase()).slice(0, 3);
}
/** map a raw corpus search result into the research source shape */
function sourceFrom(
  s: Record<string, unknown>,
  authority: AuthorityType,
  index: number,
): ResearchSource {
  const citation = String(s.citation || s.measure || s.title || `Source ${index + 1}`);
  const passage = String(s.text || s.snippet || s.description || s.subject || "");
  const binding: ResearchSource["binding_weight"] =
    authority === "statute"
      ? "statute"
      : authority === "bill"
        ? "legislative_material"
        : authority === "rule"
          ? "rule"
          : authority === "form"
            ? "form"
            : authority === "words_and_phrases"
              ? "secondary"
              : "court_of_appeal";
  const role: ResearchSource["authority_role"] =
    authority === "statute"
      ? "primary"
      : authority === "bill"
        ? "legislative"
        : authority === "rule" || authority === "form"
          ? "procedural"
          : "binding_interpretation";
  return {
    source_id: `s${index + 1}`,
    marker: String(s.marker || `[s${index + 1}]`),
    authority_type: authority,
    authority_role: role,
    citation,
    title: String(s.title || s.caseName || s.subject || citation),
    date: s.dateFiled ? String(s.dateFiled) : s.date ? String(s.date) : null,
    status: s.status ? String(s.status) : null,
    jurisdiction: "California",
    temporal_fit: "unknown",
    binding_weight: binding,
    relevant_passage: passage.slice(0, 1200),
    supported_proposition: `${citation} provides: ${passage.slice(0, 300)}`,
    relevance_reason:
      "Term-overlap retrieval from the topic search; relevance to the question requires verification.",
    verification: "retrieved",
    url: s.url ? String(s.url) : null,
  };
}

/** run a corpus search call, collecting failures into the error ledger */
async function runSearch(
  label: string,
  fn: () => unknown,
  errors: string[],
): Promise<Record<string, unknown>[]> {
  try {
    const out = (await fn()) as { sources?: Record<string, unknown>[] } | null | undefined;
    return Array.isArray(out?.sources) ? out.sources : [];
  } catch (e) {
    errors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`);
    return [];
  }
}

/** record an open evidence gap for an incomplete task */
function addGap(
  gaps: EvidenceGap[],
  issue: string,
  whyItMatters: string,
  authority: AuthorityType | "any",
  queries: string[],
) {
  gaps.push({
    gap_id: `g${gaps.length + 1}`,
    issue,
    why_it_matters: whyItMatters,
    required_authority: authority,
    search_queries: queries,
    status: "open",
  });
}

export async function buildResearchRecord(question: string): Promise<ResearchRecord> {
  const issue = inferIssue(question);
  const mode = inferMode(issue, question);
  const tasks = planTasks(issue, question);
  const errors: string[] = [];
  const sources: ResearchSource[] = [];
  const propositions: Proposition[] = [];
  const relationships: Relationship[] = [];
  const chronology: ChronologyEvent[] = [];
  const gaps: EvidenceGap[] = [];

  const addSources = (raw: Record<string, unknown>[], authority: AuthorityType) => {
    for (const s of raw) {
      const candidate = sourceFrom(s, authority, sources.length);
      const identity = candidate.citation || candidate.title || candidate.relevant_passage;
      if (!sources.some((x) => (x.citation || x.title || x.relevant_passage) === identity)) sources.push(candidate);
    }
  };

  const runAuthority = async (
    t: ResearchTask,
    authority: AuthorityType,
    queries: string[],
  ) => {
    if (authority === "statute") {
      return runSearch(`${t.task_id} California Codes`, () => searchStatutes.execute({ queries, limit: 16 }, undefined as never), errors);
    }
    if (authority === "case") {
      return runSearch(`${t.task_id} California case law`, () => searchCases.execute({ queries: queries.slice(0, 3) }, undefined as never), errors);
    }
    if (authority === "rule") {
      return runSearch(`${t.task_id} California Rules of Court`, () => searchRules.execute({ queries, limit: 8 }, undefined as never), errors);
    }
    if (authority === "form") {
      return runSearch(`${t.task_id} Judicial Council forms`, () => searchForms.execute({ queries: queries.slice(0, 3), limit: 10 }, undefined as never), errors);
    }
    return runSearch(`${t.task_id} California legislative materials`, () => searchBills.execute({ queries, limit: 8 }, undefined as never), errors);
  };

  // Cache identical authority/query bundles for one request. Adaptive passes
  // often rediscover the same query after a task is refreshed.
  const authorityCache = new Map<string, Promise<Record<string, unknown>[]>>();
  const cachedAuthority = (
    t: ResearchTask,
    authority: AuthorityType,
    queries: string[],
  ) => {
    const key = authority + "\0" + unique(
      queries.map((q) => q.trim().toLowerCase()).filter(Boolean),
      (q) => q,
    ).join("\0");
    const pending = authorityCache.get(key);
    if (pending) return pending;
    const promise = runAuthority(t, authority, queries);
    authorityCache.set(key, promise);
    return promise;
  };

  // The initial pass samples the first two focused queries from each task and
  // combines them per authority, eliminating near-duplicate network requests.
  const MAX_AUTHORITY_QUERIES: Record<AuthorityType, number> = {
    statute: 4,
    case: 3,
    rule: 4,
    form: 3,
    bill: 4,
    words_and_phrases: 3,
  };
  const rebuildPropositions = () => {
    propositions.splice(0, propositions.length, ...sources.map((s, i): Proposition => ({
      proposition_id: `p${i + 1}`,
      source_ids: [s.source_id],
      statement: s.supported_proposition,
      support_type:
        s.authority_type === "case" || s.authority_type === "words_and_phrases"
          ? "case_statement"
          : s.authority_type === "bill"
            ? "legislative_record"
            : "direct_text",
      status: s.verification === "retrieved" ? "supported" : "needs_verification",
    })));
  };

  const runTask = async (t: ResearchTask) => {
    t.attempts++;
    const queries = followupQueriesForTask(t, sources);
    const authorities = unique(t.required_authority, (x) => x);
    const results = await Promise.all(
      authorities.map((authority) => cachedAuthority(t, authority, queries)),
    );
    results.forEach((raw, i) => addSources(raw, authorities[i]));
  };

  // Group the initial retrieval pass by authority. Task-specific adaptive
  // retries still run separately when the shared pass leaves a gap.
  const runInitialAuthorityBatches = async () => {
    const authorities = unique(
      tasks.flatMap((t) => t.required_authority),
      (authority) => authority,
    );

    await Promise.all(
      authorities.map(async (authority) => {
        const owners = tasks.filter((t) => t.required_authority.includes(authority));
        if (!owners.length) return;

        const maxQueries = MAX_AUTHORITY_QUERIES[authority];
        const selected: string[] = [];
        for (const t of owners) {
          if (selected.length >= maxQueries) break;
          if (t.queries[0]) selected.push(t.queries[0]);
        }
        for (const t of owners) {
          if (selected.length >= maxQueries) break;
          if (t.queries[1]) selected.push(t.queries[1]);
        }

        const queries = unique(selected, (q) => q.trim().toLowerCase()).slice(0, maxQueries);
        if (!queries.length) return;

        owners.forEach((t) => { t.attempts++; });
        const raw = await cachedAuthority(owners[0], authority, queries);
        addSources(raw, authority);
      }),
    );
  };

  // Agentic retrieval. Two agents run concurrently and choose their own tools
  // and queries within a step budget, which is how a source that the
  // hand-written plan never named (Words and Phrases) becomes reachable. Their
  // sources join this record and face the same gate as everything else. If the
  // agent pass fails, nothing changes: the deterministic planner below still
  // runs exactly as it did before.
  try {
    const agentResults = await runResearchAgents(question);
    for (const result of agentResults) {
      for (const source of result.sources) {
        addSources([source.raw], source.authority as AuthorityType);
      }
    }
  } catch (error) {
    console.error("[research] agent pass failed; falling back to the planner alone", error);
  }

  await runInitialAuthorityBatches();
  rebuildPropositions();
  refreshTaskStatus(tasks, sources, propositions);

  // Adaptive passes remain sequential because each pass depends on the evidence
  // collected by the previous pass, but searches within a pass are concurrent.
  for (let pass = 0; pass < 2; pass++) {
    const incomplete = tasks.filter((t) => t.status === "pending" || t.status === "incomplete");
    if (!incomplete.length) break;
    await Promise.all(incomplete.map(runTask));
    rebuildPropositions();
    refreshTaskStatus(tasks, sources, propositions);
  }

  // Build conservative source relationships. These remain verification targets
  // until the underlying opinion/text establishes the actual legal relationship.
  const statutes = sources.filter((s) => s.authority_type === "statute");
  const cases = sources.filter((s) => s.authority_type === "case");
  for (const c of cases.slice(0, 12)) {
    for (const s of statutes.slice(0, 6)) {
      const overlap = terms(c.relevant_passage + " " + c.title).filter((term) => (s.citation + " " + s.title + " " + s.relevant_passage).toLowerCase().includes(term.toLowerCase()));
      if (overlap.length >= 2) relationships.push({
        relationship_id: `rel${relationships.length + 1}`,
        type: "interprets",
        from_source_id: c.source_id,
        to_source_id: s.source_id,
        reason: `The sources share substantive terms (${overlap.slice(0, 4).join(", ")}); the opinion must be checked to establish the actual interpretive relationship.`,
        verification: "needs_followup",
      });
    }
  }

  for (const s of sources) {
    if (s.temporal_fit === "historical" || /repealed|superseded/i.test(s.citation + " " + (s.status || ""))) {
      chronology.push({
        event_id: `t${chronology.length + 1}`,
        source_id: s.source_id,
        date: s.date,
        event: "status_change",
        description: "Historical/repealed signal requires date reconstruction before it can establish operative law.",
      });
    }
    if (s.authority_type === "bill") chronology.push({
      event_id: `t${chronology.length + 1}`,
      source_id: s.source_id,
      date: s.date,
      event: "status_change",
      description: `Legislative material status: ${s.status || "unknown"}; verify enactment and effective date.`,
    });
  }

  for (const t of tasks.filter((x) => x.status !== "complete")) {
    addGap(gaps, t.question, t.missing_evidence.join(" ") || "Completion criteria were not satisfied.", t.required_authority[0] || "any", t.queries);
  }

  const verificationTasks = tasks.filter((t) => t.status !== "complete")
    .map((t) => `${t.task_id}: ${t.missing_evidence.join(" ")} Search next: ${t.queries.join(" | ")}`);
  if (errors.length) verificationTasks.push(...errors.map((e) => `Research service issue requiring retry: ${e}`));

  const synthesis = [
    "The research task ledger is authoritative for what the answer may assert.",
    "Every substantive legal proposition must be traceable to one or more propositions in the record and cited with its source marker.",
    "A task is complete only when its completion criteria are satisfied; relevance alone does not satisfy a task.",
    "Incomplete tasks must trigger targeted follow-up or an explicit statement that the proposition remains unverified.",
    "Do not treat shared keywords as proof of interpretation, amendment, supersession, distinction, or conflict.",
    "Do not treat proposed or pending legislation as enacted law.",
  ];

  return {
    schema_version: "2.0",
    question,
    issue,
    mode,
    research_plan: tasks.map((t) => `${t.task_id} [${t.kind}]: ${t.question} — completion: ${t.completion_criteria.join("; ")}`),
    tasks,
    sources,
    propositions,
    relationships,
    chronology,
    evidence_gaps: gaps,
    verification_tasks: verificationTasks,
    research_errors: errors,
    synthesis_requirements: synthesis,
    answer_contract: {
      must_cite_propositions: true,
      citation_format: "Use the source marker shown for the supporting proposition, e.g. [1], [c1], [r1], [b1], [f1].",
      may_use_uncited_general_knowledge: false,
      unsupported_claim_action: "research_or_state_unverified",
    },
  };
}



/** Tool facade used by the chat route: runs the structured research pass. */
export const research = {
  inputSchema: researchInputSchema,
  async execute({ question }: { question: string }, _options?: unknown) {
    return buildResearchRecord(question);
  },
};

export default research;
