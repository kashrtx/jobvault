// The set of answers every application portal asks for. Defined once here so
// the editor, the fill engine, and the completeness meter can never drift apart.

const YES_NO = ["Yes", "No"];
const DECLINE = "I don't wish to answer";

export const GROUPS = [
  {
    id: "identity",
    label: "Name and contact",
    blurb: "The four or five fields every portal opens with.",
    fields: [
      { key: "firstName", label: "First name", type: "text", w: 1, core: true },
      { key: "middleName", label: "Middle name", type: "text", w: 1 },
      { key: "lastName", label: "Last name", type: "text", w: 1, core: true },
      { key: "preferredName", label: "Preferred name", type: "text", w: 1 },
      { key: "email", label: "Email", type: "email", w: 2, core: true },
      { key: "phone", label: "Phone", type: "tel", w: 1, core: true, hint: "Digits only is safest" },
      {
        key: "phoneType",
        label: "Phone type",
        type: "select",
        w: 1,
        options: ["Mobile", "Home", "Work"],
      },
      { key: "phoneCountryCode", label: "Phone country code", type: "text", w: 1, hint: "e.g. +1" },
      { key: "pronouns", label: "Pronouns", type: "text", w: 1 },
    ],
  },
  {
    id: "address",
    label: "Address",
    blurb: "Workday will not let you past step one without this.",
    fields: [
      { key: "addressLine1", label: "Street address", type: "text", w: 2, core: true },
      { key: "addressLine2", label: "Apartment or unit", type: "text", w: 2 },
      { key: "city", label: "City", type: "text", w: 1, core: true },
      { key: "state", label: "Province or state", type: "text", w: 1, core: true },
      { key: "postalCode", label: "Postal code", type: "text", w: 1, core: true },
      { key: "country", label: "Country", type: "text", w: 1, core: true },
    ],
  },
  {
    id: "links",
    label: "Links",
    fields: [
      { key: "linkedin", label: "LinkedIn", type: "url", w: 2, core: true },
      { key: "github", label: "GitHub", type: "url", w: 2 },
      { key: "portfolio", label: "Portfolio", type: "url", w: 2 },
      { key: "website", label: "Other site", type: "url", w: 2 },
    ],
  },
  {
    id: "work",
    label: "Current situation",
    fields: [
      { key: "currentCompany", label: "Current employer", type: "text", w: 2 },
      { key: "currentTitle", label: "Current title", type: "text", w: 2 },
      { key: "yearsExperience", label: "Years of experience", type: "number", w: 1 },
      {
        key: "desiredSalary",
        label: "Expected salary",
        type: "text",
        w: 1,
        hint: "A number, or leave blank to answer by hand",
      },
      { key: "noticePeriod", label: "Notice period", type: "text", w: 1, hint: "e.g. 2 weeks" },
      { key: "earliestStartDate", label: "Earliest start date", type: "date", w: 1 },
    ],
  },
  {
    id: "eligibility",
    label: "Eligibility and logistics",
    blurb: "The screener questions that appear in a different order every time.",
    fields: [
      { key: "workAuthorized", label: "Authorized to work in the country", type: "select", w: 1, options: YES_NO, core: true },
      { key: "needsSponsorship", label: "Will need visa sponsorship", type: "select", w: 1, options: YES_NO, core: true },
      { key: "willingToRelocate", label: "Willing to relocate", type: "select", w: 1, options: YES_NO },
      {
        key: "remotePreference",
        label: "Work arrangement",
        type: "select",
        w: 1,
        options: ["Remote", "Hybrid", "On-site", "No preference"],
      },
      { key: "over18", label: "18 or older", type: "select", w: 1, options: YES_NO },
      { key: "hasDriversLicense", label: "Has a driver's licence", type: "select", w: 1, options: YES_NO },
      {
        key: "previouslyEmployed",
        label: "Previously worked at this company",
        type: "select",
        w: 1,
        options: YES_NO,
        hint: "Almost always No",
      },
      {
        key: "source",
        label: "How you heard about the role",
        type: "text",
        w: 1,
        hint: "e.g. LinkedIn, Company website",
      },
      { key: "referredBy", label: "Referred by", type: "text", w: 2 },
    ],
  },
  {
    id: "eeo",
    label: "Voluntary disclosures",
    blurb: "Answer once. Every field here is optional and stays encrypted with the rest.",
    fields: [
      {
        key: "gender",
        label: "Gender",
        type: "select",
        w: 1,
        options: ["Male", "Female", "Non-binary", DECLINE],
      },
      { key: "hispanicLatino", label: "Hispanic or Latino", type: "select", w: 1, options: [...YES_NO, DECLINE] },
      {
        key: "ethnicity",
        label: "Race or ethnicity",
        type: "select",
        w: 2,
        options: [
          "American Indian or Alaska Native",
          "Asian",
          "Black or African American",
          "Hispanic or Latino",
          "Native Hawaiian or Other Pacific Islander",
          "White",
          "Two or More Races",
          DECLINE,
        ],
      },
      {
        key: "veteranStatus",
        label: "Veteran status",
        type: "select",
        w: 2,
        options: ["I am not a protected veteran", "I identify as one or more of the classifications of a protected veteran", DECLINE],
      },
      {
        key: "disabilityStatus",
        label: "Disability status",
        type: "select",
        w: 2,
        options: ["No, I do not have a disability", "Yes, I have a disability, or have had one in the past", DECLINE],
      },
    ],
  },
];

export const WORK_HISTORY_FIELDS = [
  { key: "title", label: "Job title", type: "text", w: 2 },
  { key: "company", label: "Company", type: "text", w: 2 },
  { key: "location", label: "Location", type: "text", w: 2 },
  { key: "from", label: "From", type: "month", w: 1 },
  { key: "to", label: "To", type: "month", w: 1, hint: "Leave blank if current" },
  { key: "current", label: "Current role", type: "check", w: 1 },
  { key: "description", label: "What you did", type: "textarea", w: 2 },
];

export const EDUCATION_FIELDS = [
  { key: "school", label: "School", type: "text", w: 2 },
  { key: "degree", label: "Degree", type: "text", w: 1, hint: "e.g. Bachelor's" },
  { key: "field", label: "Field of study", type: "text", w: 1 },
  { key: "from", label: "From", type: "month", w: 1 },
  { key: "to", label: "To", type: "month", w: 1 },
  { key: "gpa", label: "GPA", type: "text", w: 1 },
];

export function emptyProfile() {
  const values = {};
  for (const g of GROUPS) for (const f of g.fields) values[f.key] = "";
  return {
    emails: [],
    defaultEmail: "",
    values,
    workHistory: [],
    education: [],
  };
}

export function normalizeProfile(p) {
  const base = emptyProfile();
  if (!p) return base;
  base.emails = Array.isArray(p.emails) ? p.emails.filter(Boolean) : [];
  base.defaultEmail = p.defaultEmail || base.emails[0] || "";
  base.workHistory = Array.isArray(p.workHistory) ? p.workHistory : [];
  base.education = Array.isArray(p.education) ? p.education : [];
  Object.assign(base.values, p.values || {});
  // A vault from 1.x only ever had a list of emails. Seed the new email field
  // from the default so the very first fill is not blank.
  if (!base.values.email) base.values.email = base.defaultEmail;
  return base;
}

/** Flat map handed to the content script. Nothing empty, nothing extra. */
export function fillValues(profile, overrideEmail) {
  const p = normalizeProfile(profile);
  const out = {};
  for (const [k, v] of Object.entries(p.values)) {
    if (v !== "" && v != null) out[k] = String(v);
  }
  if (overrideEmail) out.email = overrideEmail;
  if (out.firstName && out.lastName) out.fullName = `${out.firstName} ${out.lastName}`;
  if (out.preferredName && out.lastName) out.preferredFullName = `${out.preferredName} ${out.lastName}`;
  return out;
}

/** Share of the fields marked core that are actually answered. */
export function completeness(profile) {
  const p = normalizeProfile(profile);
  const core = GROUPS.flatMap((g) => g.fields.filter((f) => f.core));
  const done = core.filter((f) => String(p.values[f.key] || "").trim());
  const missing = core.filter((f) => !String(p.values[f.key] || "").trim()).map((f) => f.label);
  return { done: done.length, total: core.length, pct: Math.round((done.length / core.length) * 100), missing };
}
