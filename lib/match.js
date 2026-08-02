// Compares resume text against a job description and returns a score plus the
// terms you already cover and the ones worth adding. Used by both the page
// (through the background worker) and the popup, so results always agree.

const STOP = new Set(
  "a an the and or but if then else of to in on at for with without from by as is are was were be been being this that these those we you your our their they them it its will can may must should would could have has had do does did not no yes more most other across within into over under about who what when where why how all any each both few many much such own same than too very just also including include includes required require requirements responsibilities responsible preferred qualifications skills skill company companies job jobs candidate candidates position new use using used help support ensure provide provided deliver drive build built create created manage managed lead led role team work working experience years year ability strong excellent good plus etc"
    .split(/\s+/)
);

const SHORT_OK = new Set([
  "ai", "ml", "ux", "ui", "qa", "hr", "js", "go", "aws", "gcp", "sql", "css",
  "api", "seo", "sre", "etl", "bi", "c#", "c++", "r", "s3", "ci", "cd",
]);

const LEXICON = [
  "javascript", "typescript", "python", "java", "react", "angular", "vue", "node", "express", "django", "flask", "spring",
  "kubernetes", "docker", "terraform", "ansible", "aws", "azure", "gcp", "cloud", "devops", "ci/cd", "microservices",
  "postgres", "mysql", "mongodb", "redis", "sql", "nosql", "graphql", "rest", "api", "kafka", "spark", "hadoop",
  "machine learning", "deep learning", "data science", "data analysis", "analytics", "tableau", "power bi", "excel",
  "pandas", "numpy", "tensorflow", "pytorch", "nlp", "llm", "statistics", "modeling", "forecasting",
  "product management", "project management", "agile", "scrum", "jira", "roadmap", "stakeholder", "kpi", "okr",
  "figma", "sketch", "wireframe", "prototype", "user research", "usability", "accessibility", "design system",
  "marketing", "seo", "content", "campaign", "social media", "brand", "copywriting", "salesforce", "hubspot", "crm",
  "sales", "pipeline", "negotiation", "account management", "customer success", "onboarding", "retention",
  "finance", "accounting", "budgeting", "forecast", "valuation", "audit", "compliance", "risk",
  "communication", "leadership", "collaboration", "problem solving", "mentoring", "cross functional",
  "security", "penetration testing", "encryption", "networking", "linux", "git", "testing", "automation",
  "html", "css", "tailwind", "sass", "webpack", "next.js", "redux", "rust", "golang", "kotlin", "swift", "php", "ruby", "scala", "c#", "c++",
];
const LEX_SET = new Set(LEXICON);

function normalize(text) {
  return (" " + String(text || "").toLowerCase() + " ")
    .replace(/[^a-z0-9+#./ ]/g, " ")
    .replace(/\s+/g, " ");
}

// present in the resume, tolerating simple plurals (api / apis, team / teams)
function inResume(resume, term) {
  if (term.includes(" ")) return resume.includes(" " + term + " ");
  const variants = new Set([term]);
  if (term.length > 3 && term.endsWith("s")) variants.add(term.slice(0, -1));
  if (term.length >= 3) variants.add(term + "s");
  for (const v of variants) {
    if (resume.includes(" " + v + " ") || resume.includes(" " + v) || resume.includes(v + " ")) return true;
  }
  return false;
}

function isLexicon(t) {
  return LEX_SET.has(t) || (t.endsWith("s") && LEX_SET.has(t.slice(0, -1)));
}

export function computeMatch(resumeText, jdText) {
  const jd = normalize(jdText);
  const resume = normalize(resumeText);
  const keywords = new Map(); // term -> weight

  // multi word skills present in the posting
  for (const term of LEXICON) {
    if (term.includes(" ") && jd.includes(" " + term + " ")) keywords.set(term, 3);
  }

  // single tokens, ranked by how often the posting repeats them
  const freq = new Map();
  for (const raw of jd.trim().split(" ")) {
    const t = raw.replace(/^[.]+|[.]+$/g, "");
    if (!t) continue;
    if (t.length < 3 && !SHORT_OK.has(t)) continue;
    if (STOP.has(t)) continue;
    if (/^\d+$/.test(t)) continue;
    freq.set(t, (freq.get(t) || 0) + 1);
  }
  const singles = [...freq.entries()].sort((a, b) => b[1] - a[1]);
  for (const [t, c] of singles) {
    if (keywords.size >= 30) break;
    const weight = (isLexicon(t) ? 2 : 0.6) + Math.min(c - 1, 2) * 0.5;
    if (!keywords.has(t)) keywords.set(t, weight);
  }

  // check each against the resume
  const have = [];
  const missing = [];
  let got = 0;
  let total = 0;
  for (const [term, weight] of keywords) {
    total += weight;
    if (inResume(resume, term)) {
      got += weight;
      have.push({ term, weight });
    } else {
      missing.push({ term, weight });
    }
  }

  const score = total ? Math.round((got / total) * 100) : 0;
  const byWeight = (a, b) => b.weight - a.weight;
  return {
    score,
    have: have.sort(byWeight).map((x) => x.term).slice(0, 18),
    missing: missing.sort(byWeight).map((x) => x.term).slice(0, 14),
  };
}
