import { safeExternalUrl } from "./lib/sites.js";

/**
 * Opens a stored URL, or explains why it will not. Stored URLs come from pages
 * and from imported backups, so they are checked rather than trusted.
 */
function openExternal(url, label = "that link") {
  const safe = safeExternalUrl(url);
  if (!safe) return toast(`${label} is not a web address JobVault will open.`);
  chrome.tabs.create({ url: safe });
}

const $ = (s) => document.querySelector(s);
const send = (m) => new Promise((r) => chrome.runtime.sendMessage(m, (res) => r(res || { ok: false, error: "No response from the vault." })));

let vault = null;
let state = null;
let tab = null;
let summary = null;

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function toast(text) {
  const t = $("#toast");
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.hidden = true), 2400);
}

function show(view) {
  for (const v of ["onboard", "lock", "main"]) $(`#view-${v}`).hidden = v !== view;
  $("#lockBtn").hidden = view !== "main";
  $("#dashBtn").hidden = view !== "main";
}

const el = (tag, cls, html) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  return e;
};

function button(cls, label, onClick, title) {
  const b = el("button", cls, esc(label));
  if (title) b.title = title;
  b.type = "button";
  b.onclick = onClick;
  return b;
}

const STATUS = {
  saved: "Saved", applied: "Applied", assessment: "Assessment", interview: "Interview",
  offer: "Offer", rejected: "Rejected", ghosted: "No reply", withdrawn: "Withdrawn",
};

function ago(ts) {
  if (!ts) return "";
  const d = Math.floor((Date.now() - ts) / 86400000);
  if (d <= 0) return "today";
  if (d === 1) return "yesterday";
  if (d < 30) return `${d} days ago`;
  const m = Math.floor(d / 30);
  return `${m} month${m === 1 ? "" : "s"} ago`;
}

/** Hostname with the tenant segment in brass. */
function tenantHTML(host) {
  const h = String(host || "").toLowerCase();
  if (!h) return "";
  const labels = h.split(".");
  const isWorkday = /myworkdayjobs\.com$|myworkdaysite\.com$|\.wd\d+\./.test(h);
  if (labels.length > 2 && labels[0] !== "www" && (isWorkday || labels.length > 3)) {
    return `<b>${esc(labels[0])}</b>${esc("." + labels.slice(1).join("."))}`;
  }
  return esc(h);
}

// -------------------------------------------------------------------- init

async function init() {
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  state = await send({ type: "getState" });
  $("#footVersion").textContent = "v" + (state.version || "");
  renderUpdatePill(state.update);

  if (!state.hasVault) return show("onboard");
  if (!state.unlocked) return showLock();
  await enterMain();
}

function renderUpdatePill(update) {
  const pill = $("#updatePill");
  if (!update || !update.behind) return (pill.hidden = true);
  pill.hidden = false;
  $("#updateText").textContent = update.latestVersion
    ? `Update available \u2014 v${update.latestVersion}`
    : `New commit on ${update.branch} \u2014 ${update.latestShortSha || ""}`;
}
$("#updateGo").onclick = () => send({ type: "openDashboard", hash: "#settings" });

function showLock() {
  show("lock");
  const usePin = state.hasPin && !state.pinLocked;
  $("#lk-pin-block").hidden = !usePin;
  $("#lk-master-block").hidden = usePin;
  $("#lk-use-pin").hidden = !state.hasPin;
  setTimeout(() => (usePin ? $("#lk-pin") : $("#lk-pass")).focus(), 60);
  if (state.pinLocked) $("#lk-msg").textContent = "Too many PIN tries. Use your master password.";
}

async function enterMain() {
  const res = await send({ type: "getVault" });
  if (!res.ok) { state = await send({ type: "getState" }); return showLock(); }
  vault = res.vault;
  show("main");
  renderRecent();
  renderPending();
  makePassword();
  await loadPageContext();
}

// --------------------------------------------------------------- onboarding

$("#ob-create").onclick = async () => {
  const p1 = $("#ob-pass").value, p2 = $("#ob-pass2").value;
  const pin = $("#ob-pin").value.trim();
  const msg = $("#ob-msg");
  msg.className = "msg";
  if (p1.length < 8) return (msg.textContent = "Use at least 8 characters.");
  if (p1 !== p2) return (msg.textContent = "The two passwords do not match.");
  if (pin && !/^\d{4,12}$/.test(pin)) return (msg.textContent = "The PIN must be 4 to 12 digits.");
  const res = await send({ type: "createVault", password: p1, defaultEmail: $("#ob-email").value.trim() });
  if (!res.ok) return (msg.textContent = res.error);
  if (pin) await send({ type: "setupPin", pin });
  state = await send({ type: "getState" });
  await enterMain();
  send({ type: "openDashboard", hash: "#profile" });
};

// ------------------------------------------------------------------ unlock

async function unlockMaster() {
  const res = await send({ type: "unlock", password: $("#lk-pass").value });
  if (!res.ok) return ($("#lk-msg").textContent = res.error);
  $("#lk-pass").value = "";
  state = await send({ type: "getState" });
  await enterMain();
}
async function unlockPin() {
  const res = await send({ type: "unlockPin", pin: $("#lk-pin").value });
  $("#lk-pin").value = "";
  if (!res.ok) {
    $("#lk-msg-pin").textContent = res.error;
    if (res.needMaster) { $("#lk-pin-block").hidden = true; $("#lk-master-block").hidden = false; $("#lk-pass").focus(); }
    return;
  }
  state = await send({ type: "getState" });
  await enterMain();
}
$("#lk-unlock").onclick = unlockMaster;
$("#lk-pin-unlock").onclick = unlockPin;
// A DOM0 handler that returns false is treated as preventDefault(), so a concise
// arrow body like `(e) => e.key === "Enter" && go()` evaluates to false on every
// other key and silently eats the keystroke. Braces, always. scripts/verify.sh
// fails the build if this idiom reappears.
$("#lk-pass").onkeydown = (e) => { if (e.key === "Enter") unlockMaster(); };
$("#lk-pin").onkeydown = (e) => { if (e.key === "Enter") unlockPin(); };
$("#lk-use-master").onclick = () => { $("#lk-pin-block").hidden = true; $("#lk-master-block").hidden = false; $("#lk-pass").focus(); };
$("#lk-use-pin").onclick = () => { $("#lk-master-block").hidden = true; $("#lk-pin-block").hidden = false; $("#lk-pin").focus(); };

$("#lockBtn").onclick = async () => {
  await send({ type: "lock" });
  vault = null;
  state = await send({ type: "getState" });
  showLock();
};
$("#dashBtn").onclick = () => send({ type: "openDashboard" });
$("#footDash").onclick = () => send({ type: "openDashboard" });

// ------------------------------------------------------------- page context

/** Ask the content script what kind of page this is. */
async function askPage() {
  if (!tab?.id) return null;
  if (/^(chrome|edge|brave|about|chrome-extension|devtools|view-source):/i.test(tab.url || "")) {
    return { unsupported: true };
  }
  try {
    const res = await chrome.tabs.sendMessage(tab.id, { type: "pageSummary" });
    return res?.ok ? res : { unreachable: true };
  } catch {
    return { unreachable: true };
  }
}

async function loadPageContext() {
  const body = $("#page-body");
  summary = await askPage();
  body.innerHTML = "";
  $("#page-ats").hidden = !summary?.ats;
  if (summary?.ats) $("#page-ats").textContent = summary.ats;

  if (!summary || summary.unsupported) {
    body.appendChild(el("p", "panel-sub", "Browser pages are off limits to extensions. Open a careers site and JobVault wakes up."));
    return;
  }
  if (summary.unreachable) {
    // JobVault only loads itself on known applicant tracking systems, so an
    // unreachable tab is usually a career site running something bespoke rather
    // than a fault. Offer to run here instead of just reporting a problem.
    const st = await send({ type: "siteStatus", url: tab.url });
    if (st.ok && !st.supported) {
      body.appendChild(el("div", "panel-title", esc(st.host || "this site")));
      body.appendChild(el("p", "panel-sub",
        "This is not one of the job systems JobVault loads on by default, which is why it is not already watching. Run it here and it will look for a form."));
      body.appendChild(button("btn primary wide", "Look at this page now", async () => {
        const res = await send({ type: "runHere", tabId: tab.id });
        if (!res.ok) return toast(res.error);
        await new Promise((r) => setTimeout(r, 400));
        loadPageContext();
      }));
      body.appendChild(button("btn ghost wide", "Always run on this site", async () => {
        const res = await send({ type: "addSite", pattern: st.pattern });
        if (!res.ok) return toast(res.error);
        toast(`JobVault will run on ${st.host} from now on.`);
        await send({ type: "runHere", tabId: tab.id });
        await new Promise((r) => setTimeout(r, 400));
        loadPageContext();
      }));
      return;
    }
    body.appendChild(el("p", "panel-sub", "JobVault cannot see this tab yet. That happens right after the extension reloads."));
    body.appendChild(button("btn ghost wide", "Reload the tab", async () => {
      await chrome.tabs.reload(tab.id);
      window.close();
    }));
    return;
  }

  const ctx = await send({ type: "pageContext", url: summary.url });
  const host = summary.host;
  const tracked = ctx.ok ? ctx.job : null;

  // 1. a login or sign-up screen
  if (summary.hasLoginForm) {
    const matches = ctx.matches || [];
    if (matches.length) {
      body.appendChild(el("div", "panel-title", esc(matches[0].company)));
      body.appendChild(el("p", "panel-sub", `${esc(matches[0].email || "no email saved")} \u00b7 saved login`));
      body.appendChild(el("div", "tenant", tenantHTML(matches[0].host)));
      let chosen = matches[0].id;
      if (matches.length > 1) {
        const sel = document.createElement("select");
        matches.forEach((m) => {
          const o = document.createElement("option");
          o.value = m.id;
          o.textContent = `${m.company} \u00b7 ${m.email || "no email"}${m.exact ? "" : " (other subdomain)"}`;
          sel.appendChild(o);
        });
        sel.onchange = () => (chosen = sel.value);
        body.appendChild(sel);
      }
      body.appendChild(button("btn primary wide", "Fill this login", () => act("fillLoginNow", { id: chosen })));
      return;
    }
    body.appendChild(el("div", "panel-title", summary.isSignup ? `New account at ${esc(ctx.company || host)}` : `No saved login for ${esc(ctx.company || host)}`));
    body.appendChild(el("div", "tenant", tenantHTML(host)));
    body.appendChild(el("p", "panel-sub", summary.isSignup
      ? "JobVault will pick a strong password and remember it once you finish signing up."
      : "Sign in normally and JobVault will offer to save it."));
    if (summary.isSignup) {
      body.appendChild(button("btn primary wide", "Fill email and a strong password", () => act("fillLoginNow")));
    } else {
      body.appendChild(button("btn ghost wide", "Fill my email", () => act("fillLoginNow")));
    }
    return;
  }

  // 2. an application form
  if (summary.appFields >= 4) {
    body.appendChild(el("div", "panel-title", "Application form"));
    body.appendChild(el("p", "panel-sub",
      `${summary.appFields} field${summary.appFields === 1 ? "" : "s"} on this page match your profile.` +
      (ctx.profileFields ? ` You have <b>${ctx.profileFields}</b> answers saved.` : "")));
    if (!ctx.profileFields) {
      body.appendChild(button("btn primary wide", "Fill in your profile first", () => send({ type: "openDashboard", hash: "#profile" })));
    } else {
      body.appendChild(button("btn primary wide", "Fill the form", () => act("fillApplicationNow")));
    }
    if (summary.isPosting || tracked) {
      body.appendChild(button("btn ghost wide", tracked ? "Mark as applied" : "Also save to tracker", async () => {
        if (tracked) { await send({ type: "updateJob", id: tracked.id, patch: { status: "applied" } }); toast("Marked as applied"); }
        else act("saveJobNow");
      }));
    }
    return;
  }

  // 3. a job posting
  if (summary.isPosting && summary.job) {
    body.appendChild(el("div", "panel-title", esc(summary.job.title || "Job posting")));
    const parts = [summary.job.company, summary.job.location].filter(Boolean).map(esc).join(" \u00b7 ");
    if (parts) body.appendChild(el("p", "panel-sub", parts));
    if (tracked) {
      const sub = el("p", "panel-sub", "");
      sub.innerHTML = `<span class="pip st-${esc(tracked.status)}">${esc(STATUS[tracked.status] || tracked.status)}</span> \u00b7 already in your tracker`;
      body.appendChild(sub);
      const row = el("div", "btn-row");
      row.appendChild(button("btn primary", "Mark as applied", async () => {
        await send({ type: "updateJob", id: tracked.id, patch: { status: "applied" } });
        toast("Marked as applied");
        loadPageContext();
      }));
      row.appendChild(button("btn ghost", "Open tracker", () => send({ type: "openDashboard", hash: "#jobs" })));
      body.appendChild(row);
    } else {
      body.appendChild(button("btn primary wide", "Save this job", () => act("saveJobNow")));
      if (ctx.hasResume) {
        body.appendChild(button("btn ghost wide", "Check it against my resume", async () => {
          const scraped = await chrome.tabs.sendMessage(tab.id, { type: "scrapeJob" });
          if (!scraped?.jdText) return toast("Could not read the posting text");
          const m = await send({ type: "matchJob", text: scraped.jdText });
          if (!m?.result) return toast("Add your resume in the dashboard first");
          toast(`${m.result.score}% match \u00b7 ${m.result.mustHaveMissing.length} requirement gaps`);
        }));
      }
    }
    return;
  }

  // 4. nothing special
  body.appendChild(el("div", "panel-title", esc(ctx.company || host || "This page")));
  body.appendChild(el("div", "tenant", tenantHTML(host)));
  body.appendChild(el("p", "panel-sub", "No login or application form spotted here. Shortcuts still work if you think one is hiding."));
  const row = el("div", "btn-row");
  row.appendChild(button("btn ghost", "Try login", () => act("fillLoginNow")));
  row.appendChild(button("btn ghost", "Try form", () => act("fillApplicationNow")));
  body.appendChild(row);
}

/** Fire a content-script action, then close so the page is visible underneath. */
async function act(type, extra = {}) {
  try {
    await chrome.tabs.sendMessage(tab.id, { type, ...extra });
    window.close();
  } catch {
    toast("Reload the tab, then try again");
  }
}

// ------------------------------------------------------------------ pending

async function renderPending() {
  const res = await send({ type: "getPending" });
  const p = res.pending;
  $("#pending").hidden = !p;
  if (!p) return;
  $("#pending-detail").textContent = `${p.company || p.host} \u00b7 ${p.email || "no email"}`;
  $("#pending-save").onclick = async () => {
    const r = await send({ type: "savePending" });
    if (!r.ok) return toast(r.error);
    $("#pending").hidden = true;
    vault = (await send({ type: "getVault" })).vault;
    toast("Login saved");
  };
  $("#pending-dismiss").onclick = async () => {
    await send({ type: "clearPending" });
    $("#pending").hidden = true;
  };
}

// -------------------------------------------------------------------- lists

function jobRow(job) {
  const row = el("div", "row");
  const main = el("div", "row-main");
  main.appendChild(el("div", "row-title", esc(job.title || "Untitled role")));
  const sub = el("div", "row-sub");
  sub.innerHTML =
    `<span class="pip st-${esc(job.status)}">${esc(STATUS[job.status] || job.status)}</span>` +
    `<span>${esc(job.company || job.host)}</span>` +
    (job.appliedAt || job.savedAt ? `<span class="faint">${esc(ago(job.appliedAt || job.savedAt))}</span>` : "");
  main.appendChild(sub);
  row.appendChild(main);
  if (job.matchScore != null) {
    const b = el("span", "score-badge", `${job.matchScore}%`);
    b.title = "Resume match when you saved it";
    row.appendChild(b);
  }
  const actions = el("div", "row-actions");
  // The old version had no concept of a saved job, so there was nothing to open.
  if (job.url) {
    actions.appendChild(button("mini go", "Open", () => {
      openExternal(job.url, "That job link");
      window.close();
    }, job.url));
  }
  actions.appendChild(button("mini", "Edit", () => send({ type: "openDashboard", hash: "#jobs/" + job.id })));
  row.appendChild(actions);
  return row;
}

function loginRow(entry) {
  const row = el("div", "row");
  const main = el("div", "row-main");
  main.appendChild(el("div", "row-title", esc(entry.company || entry.host)));
  const sub = el("div", "row-sub");
  sub.innerHTML = `<span class="mono">${tenantHTML(entry.host)}</span>`;
  main.appendChild(sub);
  row.appendChild(main);
  const actions = el("div", "row-actions");
  actions.appendChild(button("mini", "Copy", async () => {
    try { await navigator.clipboard.writeText(entry.password || ""); toast("Password copied"); }
    catch { toast("Could not copy"); }
  }, "Copy the password"));
  actions.appendChild(button("mini go", "Open", () => {
    openExternal(entry.url || `https://${entry.host}`, "That site");
    window.close();
  }));
  row.appendChild(actions);
  return row;
}

function renderRecent() {
  const box = $("#recent");
  box.innerHTML = "";
  const jobs = [...(vault.jobs || [])]
    .sort((a, b) => (b.updatedAt || b.savedAt || 0) - (a.updatedAt || a.savedAt || 0))
    .slice(0, 6);
  $("#recent-empty").hidden = jobs.length > 0;
  jobs.forEach((j) => box.appendChild(jobRow(j)));
  const savedCount = (vault.jobs || []).filter((j) => j.status === "saved" && j.url).length;
  $("#openSaved").hidden = savedCount === 0;
  $("#openSaved").textContent = `Open all saved (${savedCount})`;
}

$("#openSaved").onclick = async () => {
  const urls = (vault.jobs || []).filter((j) => j.status === "saved" && j.url).map((j) => j.url);
  if (!urls.length) return;
  const res = await send({ type: "openUrls", urls });
  toast(`Opened ${res.count} tab${res.count === 1 ? "" : "s"}`);
};

$("#search").oninput = () => {
  const q = $("#search").value.trim().toLowerCase();
  const box = $("#results");
  box.innerHTML = "";
  $("#recent-wrap").hidden = Boolean(q);
  if (!q) return;
  const jobs = (vault.jobs || []).filter((j) =>
    [j.title, j.company, j.host, j.location, j.notes].some((f) => String(f || "").toLowerCase().includes(q))
  ).slice(0, 6);
  const logins = Object.values(vault.logins || {}).filter((e) =>
    [e.company, e.host, e.email].some((f) => String(f || "").toLowerCase().includes(q))
  ).slice(0, 6);
  if (!jobs.length && !logins.length) {
    return box.appendChild(el("p", "empty", `Nothing matches \u201c${esc(q)}\u201d.`));
  }
  if (jobs.length) {
    box.appendChild(el("div", "eyebrow", "Jobs"));
    jobs.forEach((j) => box.appendChild(jobRow(j)));
  }
  if (logins.length) {
    box.appendChild(el("div", "eyebrow", "Logins"));
    logins.forEach((e) => box.appendChild(loginRow(e)));
  }
};

// --------------------------------------------------------------- generator

async function makePassword() {
  const opts = {
    length: parseInt($("#gen-len").value, 10),
    avoidAmbiguous: vault?.settings?.avoidAmbiguous !== false,
  };
  const res = await send({ type: "generatePassword", opts });
  if (!res.ok) return;
  $("#gen-out").textContent = res.password;
  $("#gen-bits").textContent = `${res.bits} bits of entropy`;
}
$("#gen-refresh").onclick = makePassword;
$("#gen-len").oninput = () => { $("#gen-len-label").textContent = $("#gen-len").value; makePassword(); };
$("#gen-copy").onclick = async () => {
  try { await navigator.clipboard.writeText($("#gen-out").textContent); toast("Password copied"); }
  catch { toast("Could not copy"); }
};

send({ type: "ping" });
init();
