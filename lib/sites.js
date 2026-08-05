/**
 * Where JobVault is allowed to run.
 *
 * Earlier versions matched `<all_urls>`, which meant the content script loaded on
 * every page you visited: your bank, your email, everything. It only ever had
 * anything useful to do on an applicant tracking system, so the reach was cost
 * without benefit, and it is why cards appeared in places they had no business
 * appearing.
 *
 * This list is the manifest's content-script scope. Anything not on it gets
 * nothing until you explicitly ask, either once via the toolbar or permanently by
 * adding the site yourself.
 *
 * `all_frames` stays on, which matters more than it looks: when a company embeds
 * a Greenhouse or Lever form in careers.example.com, the iframe's own URL is the
 * Greenhouse one. The frame matches, the host page does not, and the form still
 * gets filled without JobVault loading on the wrapper page.
 */

export const ATS = [
  // Workday. The tenant is the leading label: nvidia.wd5.myworkdayjobs.com.
  { name: "Workday", match: ["*://*.myworkdayjobs.com/*", "*://*.myworkdaysite.com/*", "*://*.myworkday.com/*", "*://*.wd1.myworkdayjobs.com/*"], host: /(myworkdayjobs|myworkdaysite|myworkday)\.com$/ },
  { name: "Greenhouse", match: ["*://boards.greenhouse.io/*", "*://job-boards.greenhouse.io/*", "*://*.greenhouse.io/*"], host: /greenhouse\.io$/ },
  { name: "Lever", match: ["*://jobs.lever.co/*", "*://*.lever.co/*"], host: /lever\.co$/ },
  { name: "Ashby", match: ["*://jobs.ashbyhq.com/*", "*://*.ashbyhq.com/*"], host: /ashbyhq\.com$/ },
  { name: "SmartRecruiters", match: ["*://*.smartrecruiters.com/*"], host: /smartrecruiters\.com$/ },
  { name: "Workable", match: ["*://*.workable.com/*"], host: /workable\.com$/ },
  { name: "iCIMS", match: ["*://*.icims.com/*"], host: /icims\.com$/ },
  { name: "Taleo", match: ["*://*.taleo.net/*"], host: /taleo\.net$/ },
  { name: "SuccessFactors", match: ["*://*.successfactors.com/*", "*://*.successfactors.eu/*", "*://*.sapsf.com/*", "*://*.sapsf.eu/*"], host: /(successfactors\.(com|eu)|sapsf\.(com|eu))$/ },
  { name: "BambooHR", match: ["*://*.bamboohr.com/*"], host: /bamboohr\.com$/ },
  { name: "Jobvite", match: ["*://*.jobvite.com/*"], host: /jobvite\.com$/ },
  { name: "Teamtailor", match: ["*://*.teamtailor.com/*"], host: /teamtailor\.com$/ },
  { name: "Breezy", match: ["*://*.breezy.hr/*"], host: /breezy\.hr$/ },
  { name: "Recruitee", match: ["*://*.recruitee.com/*"], host: /recruitee\.com$/ },
  { name: "Personio", match: ["*://*.personio.de/*", "*://*.personio.com/*"], host: /personio\.(de|com)$/ },
  { name: "Pinpoint", match: ["*://*.pinpointhq.com/*"], host: /pinpointhq\.com$/ },
  { name: "Eightfold", match: ["*://*.eightfold.ai/*"], host: /eightfold\.ai$/ },
  { name: "Rippling", match: ["*://*.rippling.com/*"], host: /rippling\.com$/ },
  { name: "Oracle Cloud", match: ["*://*.oraclecloud.com/*"], host: /oraclecloud\.com$/ },
  { name: "Dayforce", match: ["*://*.dayforcehcm.com/*"], host: /dayforcehcm\.com$/ },
  { name: "UKG", match: ["*://*.ultipro.com/*", "*://*.ukg.net/*"], host: /(ultipro\.com|ukg\.net)$/ },
  { name: "ADP", match: ["*://*.adp.com/*"], host: /adp\.com$/ },
  { name: "Paylocity", match: ["*://*.paylocity.com/*"], host: /paylocity\.com$/ },
  { name: "Paycom", match: ["*://*.paycom.com/*"], host: /paycom\.com$/ },
  { name: "Phenom", match: ["*://*.phenompeople.com/*"], host: /phenompeople\.com$/ },
  { name: "Avature", match: ["*://*.avature.net/*"], host: /avature\.net$/ },
  { name: "Cornerstone", match: ["*://*.csod.com/*"], host: /csod\.com$/ },
];

/** Flat match-pattern list for manifest.json. Keep the manifest in step with this. */
export const ATS_MATCHES = ATS.flatMap((a) => a.match);

/** Which ATS a hostname belongs to, or "" when it is not a known one. */
export function atsName(host) {
  const h = String(host || "").toLowerCase();
  for (const a of ATS) if (a.host.test(h)) return a.name;
  return "";
}

export function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase(); } catch { return ""; }
}

export const isKnownAts = (url) => Boolean(atsName(hostOf(url)));

/** An origin pattern for chrome.permissions, used when adding a site by hand. */
export function originPattern(url) {
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) return "";
    return `${u.protocol}//${u.hostname}/*`;
  } catch { return ""; }
}

/**
 * A URL that is safe to hand to chrome.tabs.create, or "" if it is not.
 *
 * Job URLs arrive from web pages and from imported backup files, so they are
 * untrusted input that later gets opened in a tab by a privileged extension
 * page. Restricting to http and https rules out javascript:, data:, blob: and
 * file:, and the parse doubles as validation so a malformed string cannot throw
 * from inside a click handler.
 */
export function safeExternalUrl(url) {
  try {
    const u = new URL(String(url || ""));
    if (u.protocol !== "http:" && u.protocol !== "https:") return "";
    return u.href;
  } catch {
    return "";
  }
}
