// Compares your resume against a posting. Returns a score, the terms you
// already cover, the ones worth adding, and the hard requirements you appear to
// miss. Used by the background worker and the dashboard so both always agree.

const STOP = new Set(
  ("a an the and or but if then else of to in on at for with without from by as is are was were be been being " +
    "this that these those we you your our their they them it its will can may must should would could have has " +
    "had do does did not no yes more most other across within into over under about who what when where why how " +
    "all any each both few many much such own same than too very just also including include includes required " +
    "require requirements responsibilities responsible preferred qualifications skills skill company companies " +
    "job jobs candidate candidates position new use using used help support ensure provide provided deliver drive " +
    "build built create created manage managed lead led role team work working experience years year ability " +
    "strong excellent good plus etc please apply applicant employer opportunity equal benefits salary hour week " +
    "day month full time part remote hybrid onsite office location per our who join us looking seeking ideal " +
    // Postings are padded with words that sound like requirements but name no
    // actual skill. Left in, they dilute the score: a resume can cover every
    // real skill and still lose half the available weight to vocabulary like
    // "demonstrated proficiency". Everything below is scored by the notes
    // instead, where a degree or a years-of-experience gap is stated plainly.
    "professional knowledge knowledgeable equivalent familiarity familiar proficiency proficient expertise " +
    "expert understanding demonstrated proven solid deep hands related field discipline practical relevant " +
    "ideally minimum least degree bachelor bachelors master masters phd doctorate diploma university college " +
    "school education graduate undergraduate similar comparable track record background history quality " +
    "high level levels senior junior mid staff principal lead first class world best top great " +
    "environment fast paced culture mission values people person individual self starter motivated passionate " +
    "detail oriented oriented driven dynamic innovative exciting growth impact meaningful " +
    "responsibilities duties tasks activities including limited following below above " +
    "you we they our us your their please note applicants encouraged welcome diverse inclusive " +
    "closely partner partners across teams stakeholders internal external customer customers client clients " +
    "day days week weeks month months year years annually quarterly " +
    "well written verbal oral interpersonal organizational analytical")
    .split(/\s+/)
);

const SHORT_OK = new Set([
  "ai", "ml", "ux", "ui", "qa", "hr", "js", "go", "aws", "gcp", "sql", "css", "api", "seo", "sre",
  "etl", "bi", "c#", "c++", "r", "s3", "ci", "cd", "db", "os", "vm", "3d",
]);

const LEXICON = [
  "javascript", "typescript", "python", "java", "react", "angular", "vue", "svelte", "node", "express",
  "django", "flask", "spring", "rails", "dotnet", ".net",
  "kubernetes", "docker", "terraform", "ansible", "aws", "azure", "gcp", "cloud", "devops", "ci/cd",
  "microservices", "serverless", "lambda",
  "postgres", "postgresql", "mysql", "mongodb", "redis", "sql", "nosql", "graphql", "rest", "api",
  "kafka", "spark", "hadoop", "airflow", "snowflake", "dbt", "databricks",
  "machine learning", "deep learning", "data science", "data analysis", "data engineering", "analytics",
  "tableau", "power bi", "looker", "excel", "pandas", "numpy", "scikit", "tensorflow", "pytorch",
  "nlp", "llm", "computer vision", "statistics", "modeling", "forecasting", "a/b testing", "sql server",
  "product management", "project management", "agile", "scrum", "kanban", "jira", "confluence",
  "roadmap", "stakeholder", "kpi", "okr", "user stories", "backlog",
  "figma", "sketch", "adobe", "wireframe", "prototype", "user research", "usability", "accessibility",
  "design system", "interaction design", "visual design",
  "marketing", "seo", "sem", "content", "campaign", "social media", "brand", "copywriting",
  "salesforce", "hubspot", "crm", "google analytics", "email marketing",
  "sales", "pipeline", "negotiation", "account management", "customer success", "onboarding", "retention",
  "prospecting", "quota",
  "finance", "accounting", "budgeting", "forecast", "valuation", "audit", "compliance", "risk",
  "financial modeling", "gaap", "ifrs", "quickbooks", "sap",
  "communication", "leadership", "collaboration", "problem solving", "mentoring", "cross functional",
  "presentation", "documentation",
  "security", "penetration testing", "encryption", "networking", "linux", "unix", "git", "github",
  "testing", "automation", "unit testing", "selenium", "cypress", "playwright",
  "html", "css", "tailwind", "sass", "bootstrap", "webpack", "vite", "next.js", "redux",
  "rust", "golang", "kotlin", "swift", "objective-c", "php", "ruby", "scala", "perl", "matlab",
  "c#", "c++", "assembly", "embedded", "firmware", "verilog", "vhdl", "cad", "solidworks", "autocad",
];
const LEX_SET = new Set(LEXICON);

// Headings that introduce the part of a posting you are actually screened on.
const HARD_SECTION = /(minimum|basic|required|must[- ]have|essential)\s*(qualifications|requirements|skills|experience)?|^requirements|^qualifications/i;
const SOFT_SECTION = /(preferred|nice[- ]to[- ]have|bonus|desired|plus)\s*(qualifications|requirements|skills|experience)?/i;

function normalize(text) {
  return (" " + String(text || "").toLowerCase() + " ")
    .replace(/[^a-z0-9+#./ -]/g, " ")
    .replace(/\s+/g, " ");
}

function inResume(resume, term) {
  if (term.includes(" ")) return resume.includes(" " + term + " ");
  const variants = new Set([term]);
  if (term.length > 3 && term.endsWith("s")) variants.add(term.slice(0, -1));
  if (term.length >= 3) variants.add(term + "s");
  if (term.length > 4 && term.endsWith("ing")) variants.add(term.slice(0, -3));
  for (const v of variants) {
    if (resume.includes(" " + v + " ") || resume.includes(" " + v) || resume.includes(v + " ")) return true;
  }
  return false;
}

const isLexicon = (t) => LEX_SET.has(t) || (t.endsWith("s") && LEX_SET.has(t.slice(0, -1)));

/**
 * Splits a posting into a hard-requirement zone and everything else, using the
 * headings postings actually use. Terms inside the hard zone count for more,
 * because those are the ones a recruiter filters on.
 */
function zones(jdRaw) {
  const lines = String(jdRaw || "").split(/\n|(?<=[.;:])\s{2,}|•|\u2022/);
  let mode = "body";
  const hard = [];
  const body = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.length < 90 && HARD_SECTION.test(trimmed)) { mode = "hard"; continue; }
    if (trimmed.length < 90 && SOFT_SECTION.test(trimmed)) { mode = "body"; continue; }
    (mode === "hard" ? hard : body).push(trimmed);
  }
  // No recognizable headings: treat sentences carrying requirement language as hard.
  if (!hard.length) {
    for (const line of lines) {
      if (/\b(must have|required|minimum of|at least|you have|you bring)\b/i.test(line)) hard.push(line);
    }
  }
  return { hard: hard.join(" \n "), all: String(jdRaw || "") };
}

/** "5+ years", "minimum 3 years", "three years" -> the largest number asked for. */
function yearsRequired(text) {
  const words = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
  let max = 0;
  const re = /(\d{1,2})\s*\+?\s*(?:to\s*\d{1,2}\s*)?(?:years?|yrs?)/gi;
  let m;
  while ((m = re.exec(text))) max = Math.max(max, parseInt(m[1], 10));
  const wre = new RegExp(`\\b(${Object.keys(words).join("|")})\\s+(?:\\+\\s*)?(?:years?|yrs?)`, "gi");
  while ((m = wre.exec(text))) max = Math.max(max, words[m[1].toLowerCase()]);
  return max > 20 ? 0 : max;
}

function yearsClaimed(resumeText) {
  const explicit = yearsRequired(resumeText);
  // Fall back to the span between the earliest and latest four-digit years.
  const yrs = (String(resumeText).match(/\b(19|20)\d{2}\b/g) || []).map(Number).filter((y) => y >= 1975 && y <= 2100);
  const span = yrs.length >= 2 ? Math.max(...yrs) - Math.min(...yrs) : 0;
  return Math.max(explicit, Math.min(span, 40));
}

const DEGREE = /\b(bachelor|b\.?s\.?c?\b|b\.?a\.?\b|master|m\.?s\.?c?\b|mba|ph\.?d|doctorate|associate degree|diploma)\b/i;

export function computeMatch(resumeText, jdText) {
  const { hard, all } = zones(jdText);
  const jd = normalize(all);
  const jdHard = normalize(hard);
  const resume = normalize(resumeText);

  const keywords = new Map(); // term -> { weight, hard }
  const bump = (term, weight, isHard) => {
    const prev = keywords.get(term);
    if (prev) {
      prev.weight = Math.max(prev.weight, weight);
      prev.hard = prev.hard || isHard;
    } else keywords.set(term, { weight, hard: isHard });
  };

  for (const term of LEXICON) {
    if (!term.includes(" ")) continue;
    if (jdHard.includes(" " + term + " ")) bump(term, 4.5, true);
    else if (jd.includes(" " + term + " ")) bump(term, 3, false);
  }

  const freq = new Map();
  for (const raw of jd.trim().split(" ")) {
    const t = raw.replace(/^[.\-]+|[.\-]+$/g, "");
    if (!t || STOP.has(t) || /^\d+$/.test(t)) continue;
    if (t.length < 3 && !SHORT_OK.has(t)) continue;
    freq.set(t, (freq.get(t) || 0) + 1);
  }
  // Sort by lexicon membership first, then frequency, so the 34-term budget goes
  // to named skills rather than whichever filler word happened to repeat most.
  const ranked = [...freq.entries()].sort((a, b) => {
    const la = isLexicon(a[0]) ? 1 : 0;
    const lb = isLexicon(b[0]) ? 1 : 0;
    return lb - la || b[1] - a[1];
  });
  for (const [t, count] of ranked) {
    if (keywords.size >= 34) break;
    const isHard = jdHard.includes(" " + t + " ");
    const lex = isLexicon(t);
    // A named tool carries the score. An unrecognised word contributes a little,
    // because it might be a skill this lexicon has not heard of, but not enough
    // to sink a resume that covers everything the posting actually named.
    const base = lex ? 3.4 : 0.45;
    const hardBonus = isHard ? (lex ? 1.8 : 0.2) : 0;
    bump(t, base + Math.min(count - 1, 3) * (lex ? 0.5 : 0.1) + hardBonus, isHard);
  }

  const have = [];
  const missing = [];
  let got = 0;
  let total = 0;
  for (const [term, info] of keywords) {
    total += info.weight;
    const row = { term, weight: info.weight, hard: info.hard, lex: isLexicon(term) };
    if (inResume(resume, term)) { got += info.weight; have.push(row); } else missing.push(row);
  }

  const score = total ? Math.round((got / total) * 100) : 0;
  const byWeight = (a, b) => b.weight - a.weight || Number(b.hard) - Number(a.hard);

  // ------------------------------------------------------ actionable notes
  const notes = [];
  const needYears = yearsRequired(hard || all);
  const gotYears = yearsClaimed(resumeText);
  if (needYears) {
    if (gotYears && gotYears + 1 < needYears) {
      notes.push({
        kind: "warn",
        text: `Asks for ${needYears} years. Your resume reads as roughly ${gotYears}. Worth applying, but lead with the strongest relevant project.`,
      });
    } else {
      notes.push({ kind: "ok", text: `Asks for ${needYears} years of experience, and your resume supports that.` });
    }
  }
  if (DEGREE.test(hard || all) && !DEGREE.test(resumeText)) {
    notes.push({ kind: "warn", text: "A degree is listed under requirements but your resume text does not name one. Add your education section." });
  }
  // Only named skills go on the must-have list. Telling someone they are missing
  // the word "collaborate" is noise that makes the useful lines easy to ignore.
  const hardMissing = missing.filter((m) => m.hard && m.lex);
  if (hardMissing.length) {
    const names = hardMissing.slice(0, 3).map((m) => m.term).join(", ");
    notes.push({
      kind: "warn",
      text: hardMissing.length <= 3
        ? `Listed under requirements but not on your resume: ${names}.`
        : `${hardMissing.length} required skills are not on your resume, starting with ${names}.`,
    });
  }
  if (!notes.length) notes.push({ kind: "ok", text: "Nothing in the requirements section stands out as a gap." });

  return {
    score,
    have: have.sort(byWeight).map((x) => x.term).slice(0, 20),
    missing: missing.sort(byWeight).map((x) => x.term).slice(0, 16),
    mustHaveMissing: hardMissing.sort(byWeight).map((x) => x.term).slice(0, 10),
    yearsRequired: needYears,
    yearsOnResume: gotYears,
    notes,
  };
}

export function verdict(score) {
  if (score >= 75) return "Strong fit";
  if (score >= 55) return "Solid fit";
  if (score >= 35) return "Partial fit";
  return "Light fit";
}
