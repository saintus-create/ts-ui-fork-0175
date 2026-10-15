export type ProsecutionMode = "criminal" | "general";

const CRIMINAL_TERMS = /\b(charge|charges|charged|charging|crime|criminal|prosecut|defendant|suspect|accused|guilt|guilty|murder|manslaughter|robbery|burglary|assault|battery|rape|theft|fraud|dui|dwi|felony|misdemeanor|sentenc|enhancement|probable cause|reasonable doubt|suppression|search and seizure|brady|giglio|impeach|criminal complaint|indictment|information)\b/i;
const REQUIRED_HEADINGS = ["Bottom line", "Potential charges", "Element-by-element analysis", "Defense", "Open gaps"];

export function classifyProsecutionMode(question: string): ProsecutionMode {
  return CRIMINAL_TERMS.test(question) ? "criminal" : "general";
}

export function prosecutionContract(question: string): string {
  if (classifyProsecutionMode(question) !== "criminal") return "";
  return [
    "PROSECUTION-GRADE OUTPUT CONTRACT:",
    "Treat this as a charging and trial-readiness problem, not a generic legal summary.",
    "Required sections: Bottom line; Posture and assumptions; Potential charges; Element-by-element analysis; Admissibility and constitutional issues; Defense and disclosure; Lesser offenses, enhancements, and sentencing exposure; Open gaps.",
    "Map every element and mental state to supporting and contrary evidence. Identify exculpatory, impeachment, mitigating, contradictory, Brady/Giglio/Kyles, suppression, and reasonable-doubt issues before concluding.",
    "Separate probable cause, chargeability, admissible proof, and trial sufficiency. Do not treat a model score or generated inference as evidence. Cite every substantive proposition to the verified research record.",
    `Question: ${question}`,
  ].join("\n");
}

export function prosecutionHeadingGaps(text: string, question: string): string[] {
  if (classifyProsecutionMode(question) !== "criminal") return [];
  const normalized = text.toLowerCase();
  return REQUIRED_HEADINGS.filter((heading) => !normalized.includes(heading.toLowerCase()));
}
