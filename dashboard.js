import { GROUPS, WORK_HISTORY_FIELDS, EDUCATION_FIELDS, normalizeProfile, completeness } from "./lib/profile.js";
import { computeMatch, verdict } from "./lib/match.js";

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));
const send = (m) => new Promise((r) => chrome.runtime.sendMessage(m, (res) => r(res || { ok: false, error: "No response from the vault." })));

let vault = null;
let state = null;
let update = null;
let build = null;
let jobFilter = "all";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };

function button(cls, label, onClick, title) {
  const b = el("button", cls, esc(label));
  b.type = "button";
  if (title) b.title = title;
  b.onclick = onClick;
  return b;
}

function toast(text) {
  const t = $("#toast");
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.hidden = true), 2600);
}

const STATUS = {
  saved: "Saved", applied: "Applied", assessment: "Assessment", interview: "Interview",
  offer: "Offer", rejected: "Rejected", ghosted: "No reply", withdrawn: "Withdrawn",
};
const STATUS_ORDER = ["saved", "applied", "assessment", "interview", "offer", "rejected", "ghosted", "withdrawn"];

const DAY = 86400000;
function ago(ts) {
  if (!ts) return "";
  const d = Math.floor((Date.now() - ts) / DAY);
  if (d <= 0) return "today";
  if (d === 1) return "yesterday";
  if (d < 30) return `${d} days ago`;
  const m = Math.floor(d / 30);
  return `${m} month${m === 1 ? "" : "s"} ago`;
}
const dateStr = (ts) => (ts ? new Date(ts).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "");
const dateInput = (ts) => (ts ? new Date(ts).toISOString().slice(0, 10) : "");

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

// --------------------------------------------------------------------- boot

async function boot() {
  state = await send({ type: "getState" });
  $("#headVersion").textContent = "v" + (state.version || "");
  if (!state.hasVault) {
    $("#gate").hidden = false;
    $("#gate-lede").textContent = "No vault on this browser yet. Open JobVault from the toolbar to create one.";
    $("#gate-pin-block").hidden = true;
    $("#gate-master-block").hidden = true;
    return;
  }
  if (!state.unlocked) return showGate();
  await enter();
}

function showGate() {
  $("#gate").hidden = false;
  $("#app").hidden = true;
  const usePin = state.hasPin && !state.pinLocked;
  $("#gate-pin-block").hidden = !usePin;
  $("#gate-master-block").hidden = usePin;
  setTimeout(() => (usePin ? $("#gate-pin") : $("#gate-pass")).focus(), 60);
  if (state.pinLocked) $("#gate-msg").textContent = "Too many PIN tries. Use your master password.";
}

async function tryUnlock(payload) {
  const res = await send(payload);
  if (!res.ok) {
    $("#gate-msg").textContent = res.error;
    if (res.needMaster) { $("#gate-pin-block").hidden = true; $("#gate-master-block").hidden = false; }
    return;
  }
  $("#gate-pass").value = $("#gate-pin").value = "";
  $("#gate-msg").textContent = "";
  state = await send({ type: "getState" });
  await enter();
}
$("#gate-go").onclick = () => tryUnlock({ type: "unlock", password: $("#gate-pass").value });
$("#gate-pin-go").onclick = () => tryUnlock({ type: "unlockPin", pin: $("#gate-pin").value });
$("#gate-pass").onkeydown = (e) => e.key === "Enter" && $("#gate-go").click();
$("#gate-pin").onkeydown = (e) => e.key === "Enter" && $("#gate-pin-go").click();
$("#gate-use-master").onclick = () => { $("#gate-pin-block").hidden = true; $("#gate-master-block").hidden = false; $("#gate-pass").focus(); };

async function enter() {
  const res = await send({ type: "getVault" });
  if (!res.ok) { state = await send({ type: "getState" }); return showGate(); }
  vault = res.vault;
  update = res.update;
  build = res.build;
  if (state.readError) {
    // Never let an unreadable vault look like an empty one; that invites the
    // user to start over and overwrite recoverable data.
    $("#gate").hidden = false;
    $("#gate-lede").textContent = state.readError;
    $("#gate-pin-block").hidden = true;
    $("#gate-master-block").hidden = true;
    $("#gate-msg").textContent = "Open Settings from another window to restore an automatic backup.";
    return;
  }
  $("#gate").hidden = true;
  $("#app").hidden = false;
  renderHeadUpdate();
  renderCounts();
  renderJobs();
  renderLogins();
  renderProfile();
  renderResume();
  renderAnswers();
  renderSettings();
  renderSafety();
  route();
}

$("#headLock").onclick = async () => { await send({ type: "lock" }); location.reload(); };

// ------------------------------------------------------------------ routing

const PANELS = ["welcome", "jobs", "logins", "profile", "resume", "answers", "settings"];

function goto(name, sub) {
  location.hash = "#" + name + (sub ? "/" + sub : "");
}

function route() {
  const raw = (location.hash || "#jobs").slice(1);
  const [name, sub] = raw.split("/");
  const target = PANELS.includes(name) ? name : "jobs";
  for (const p of PANELS) $("#p-" + p).hidden = p !== target;
  $$(".nav").forEach((n) => n.classList.toggle("on", n.dataset.goto === target));
  if (target === "jobs" && sub) {
    const job = (vault?.jobs || []).find((j) => j.id === sub);
    if (job) openJobEditor(job);
  }
  window.scrollTo({ top: 0 });
}
window.addEventListener("hashchange", route);
document.addEventListener("click", (e) => {
  const t = e.target.closest("[data-goto]");
  if (t) goto(t.dataset.goto);
});

function renderCounts() {
  const jobs = vault.jobs || [];
  $("#navJobs").textContent = jobs.length || "";
  $("#navLogins").textContent = Object.keys(vault.logins || {}).length || "";
  $("#navAnswers").textContent = (vault.snippets || []).length || "";
  const c = completeness(vault.profile);
  $("#navProfile").textContent = c.pct + "%";
}

// ------------------------------------------------------------------ persist

/**
 * Autosave.
 *
 * Only the sections actually edited are sent, and they are merged server-side
 * into a fresh read. Sending the whole vault meant an open dashboard would
 * overwrite anything the background had changed while it sat there: a job saved
 * from a page, a status flipped by a confirmation screen.
 *
 * `flush` exists because an extension reload kills this page instantly. The
 * service worker asks every open page to flush before reloading for an update,
 * which is what stops a seamless update from eating the edit you just made.
 */
let saveTimer = null;
let dirtySections = new Set();
let flushing = null;

const SECTION_OF = {
  profile: () => vault.profile,
  resume: () => vault.resume,
  snippets: () => vault.snippets,
  settings: () => vault.settings,
  updates: () => vault.updates,
  logins: () => vault.logins,
};

async function writeNow({ quiet = false } = {}) {
  if (!dirtySections.size) return true;
  const sections = {};
  for (const name of dirtySections) sections[name] = SECTION_OF[name]();
  dirtySections = new Set();
  const res = await send({ type: "patchVault", sections });
  if (!res.ok) {
    // Put them back so the next flush retries rather than dropping the edit.
    for (const name of Object.keys(sections)) dirtySections.add(name);
    toast(res.error || "Could not save");
    return false;
  }
  if (!quiet) {
    const note = $("#profileSaved");
    note.hidden = false;
    clearTimeout(writeNow._t);
    writeNow._t = setTimeout(() => (note.hidden = true), 1400);
  }
  renderCounts();
  return true;
}

function persist(section, { quiet = false } = {}) {
  if (section) dirtySections.add(section);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => writeNow({ quiet }), 320);
}

/** Write immediately and resolve when nothing is left pending. */
async function flush() {
  clearTimeout(saveTimer);
  if (flushing) return flushing;
  flushing = writeNow({ quiet: true }).finally(() => { flushing = null; });
  return flushing;
}

chrome.runtime.onMessage.addListener((msg, _s, reply) => {
  if (msg?.type === "jvFlushForReload") {
    flush().then(() => reply({ ok: true, flushed: true }));
    return true;
  }
  return false;
});

// A closing tab is another way to lose a debounced edit.
window.addEventListener("pagehide", () => { if (dirtySections.size) writeNow({ quiet: true }); });

// --------------------------------------------------------------------- modal

function modal(title, buildBody, onSave, saveLabel = "Save") {
  $("#modalTitle").textContent = title;
  const body = $("#modalBody");
  body.innerHTML = "";
  buildBody(body);
  $("#modalSave").textContent = saveLabel;
  $("#modal").hidden = false;
  const close = () => { $("#modal").hidden = true; document.removeEventListener("keydown", onKey); };
  const onKey = (e) => { if (e.key === "Escape") close(); };
  document.addEventListener("keydown", onKey);
  $("#modalCancel").onclick = close;
  $("#modalSave").onclick = async () => { if ((await onSave(body)) !== false) close(); };
  setTimeout(() => body.querySelector("input, textarea, select")?.focus(), 50);
}

function fieldRow(parent, label, id, opts = {}) {
  const wrap = el("label", "fld");
  wrap.appendChild(el("span", "lbl", esc(label)));
  const input = document.createElement(opts.textarea ? "textarea" : opts.options ? "select" : "input");
  input.id = id;
  input.className = opts.textarea ? "area" : "field";
  if (opts.type && !opts.options && !opts.textarea) input.type = opts.type;
  if (opts.placeholder) input.placeholder = opts.placeholder;
  if (opts.options) {
    for (const o of opts.options) {
      const opt = document.createElement("option");
      opt.value = typeof o === "string" ? o : o.value;
      opt.textContent = typeof o === "string" ? o : o.label;
      input.appendChild(opt);
    }
  }
  if (opts.value != null) input.value = opts.value;
  wrap.appendChild(input);
  if (opts.hint) wrap.appendChild(el("span", "hint", esc(opts.hint)));
  parent.appendChild(wrap);
  return input;
}

// ---------------------------------------------------------------------- jobs

function dueFollowUps() {
  const days = vault.settings?.followUpDays ?? 7;
  if (!days) return [];
  return (vault.jobs || []).filter((j) => {
    if (j.status !== "applied" || j.followUpDone) return false;
    const at = j.followUpAt || (j.appliedAt ? j.appliedAt + days * DAY : 0);
    return at && Date.now() >= at;
  }).sort((a, b) => (a.appliedAt || 0) - (b.appliedAt || 0));
}

function renderJobs() {
  const jobs = vault.jobs || [];
  const counts = { all: jobs.length };
  for (const s of STATUS_ORDER) counts[s] = jobs.filter((j) => j.status === s).length;

  const chips = $("#jobsFilters");
  chips.innerHTML = "";
  const mk = (key, label) => {
    const c = el("button", "chip" + (jobFilter === key ? " on" : ""), `${esc(label)}<em>${counts[key] || 0}</em>`);
    c.type = "button";
    c.onclick = () => { jobFilter = key; renderJobs(); };
    chips.appendChild(c);
  };
  mk("all", "All");
  for (const s of STATUS_ORDER) if (counts[s]) mk(s, STATUS[s]);

  const applied = jobs.filter((j) => j.appliedAt).length;
  const interviews = jobs.filter((j) => ["interview", "offer"].includes(j.status)).length;
  $("#jobsSummary").textContent = jobs.length
    ? `${jobs.length} tracked \u00b7 ${applied} applied \u00b7 ${interviews} reached an interview` +
      (applied ? ` \u00b7 ${Math.round((interviews / applied) * 100)}% interview rate` : "")
    : "Nothing tracked yet.";

  // follow-ups
  const due = dueFollowUps();
  $("#followBox").hidden = due.length === 0;
  if (due.length) {
    const first = due[0];
    $("#followTitle").textContent = due.length === 1 ? "One application is going quiet" : `${due.length} applications are going quiet`;
    $("#followText").textContent = `${first.company} \u2014 ${first.title}, applied ${ago(first.appliedAt)}.`;
    $("#followOpen").onclick = () => { if (first.url) chrome.tabs.create({ url: first.url }); else openJobEditor(first); };
    $("#followSnooze").onclick = async () => {
      await send({ type: "snoozeFollowUp", id: first.id, days: 7 });
      vault = (await send({ type: "getVault" })).vault;
      renderJobs();
      toast("Snoozed for a week");
    };
  }

  const q = $("#jobsSearch").value.trim().toLowerCase();
  const sort = $("#jobsSort").value;
  let list = jobs.filter((j) => jobFilter === "all" || j.status === jobFilter);
  if (q) {
    list = list.filter((j) => [j.company, j.title, j.host, j.location, j.notes, j.source]
      .some((f) => String(f || "").toLowerCase().includes(q)));
  }
  const cmp = {
    updated: (a, b) => (b.updatedAt || b.savedAt || 0) - (a.updatedAt || a.savedAt || 0),
    applied: (a, b) => (b.appliedAt || 0) - (a.appliedAt || 0),
    company: (a, b) => String(a.company).localeCompare(String(b.company)),
    match: (a, b) => (b.matchScore ?? -1) - (a.matchScore ?? -1),
    deadline: (a, b) => (a.deadline || Infinity) - (b.deadline || Infinity),
  }[sort];
  list = [...list].sort(cmp);

  const box = $("#jobsList");
  box.innerHTML = "";
  $("#jobsEmpty").hidden = list.length > 0;
  $("#jobsEmpty").textContent = jobs.length
    ? "Nothing matches that filter."
    : "Open a job posting and press Alt+Shift+S, or add one by hand.";

  for (const job of list) box.appendChild(jobRow(job));
}

function jobRow(job) {
  const row = el("div", "row");
  const main = el("div", "row-main");
  main.appendChild(el("div", "row-title", esc(job.title || "Untitled role")));
  const sub = el("div", "row-sub");
  const bits = [
    `<span class="pip st-${esc(job.status)}">${esc(STATUS[job.status] || job.status)}</span>`,
    `<strong style="color:var(--text);font-weight:600">${esc(job.company || job.host)}</strong>`,
  ];
  if (job.location) bits.push(`<span>${esc(job.location)}</span>`);
  if (job.appliedAt) bits.push(`<span class="faint">applied ${esc(ago(job.appliedAt))}</span>`);
  else if (job.savedAt) bits.push(`<span class="faint">saved ${esc(ago(job.savedAt))}</span>`);
  if (job.host) bits.push(`<span class="tenant">${tenantHTML(job.host)}</span>`);
  if (job.deadline && job.deadline > Date.now()) bits.push(`<span class="deadline">closes ${esc(dateStr(job.deadline))}</span>`);
  sub.innerHTML = bits.join("");
  main.appendChild(sub);
  row.appendChild(main);

  const actions = el("div", "row-actions");
  if (job.matchScore != null) {
    const b = el("span", "score-badge", `${job.matchScore}%`);
    b.title = "Resume match at the time you saved it";
    actions.appendChild(b);
  }
  const sel = document.createElement("select");
  for (const s of STATUS_ORDER) {
    const o = document.createElement("option");
    o.value = s; o.textContent = STATUS[s];
    sel.appendChild(o);
  }
  sel.value = job.status;
  sel.title = "Change the status";
  sel.onchange = async () => {
    const res = await send({ type: "updateJob", id: job.id, patch: { status: sel.value } });
    if (!res.ok) return toast(res.error);
    vault = (await send({ type: "getVault" })).vault;
    renderJobs();
  };
  actions.appendChild(sel);
  // The complaint that started this rebuild: a saved job you cannot open.
  if (job.url) actions.appendChild(button("mini go", "Open", () => chrome.tabs.create({ url: job.url }), job.url));
  actions.appendChild(button("mini", "Details", () => openJobEditor(job)));
  actions.appendChild(button("mini bad", "Delete", async () => {
    if (!confirm(`Remove ${job.company} \u2014 ${job.title} from the tracker?`)) return;
    await send({ type: "deleteJob", id: job.id });
    vault = (await send({ type: "getVault" })).vault;
    renderJobs();
    renderCounts();
  }));
  row.appendChild(actions);
  return row;
}

function openJobEditor(job) {
  modal(`${job.company || "Job"} \u2014 ${job.title || ""}`, (body) => {
    const inputs = {};
    inputs.company = fieldRow(body, "Company", "je-company", { value: job.company || "" });
    inputs.title = fieldRow(body, "Role", "je-title", { value: job.title || "" });
    inputs.location = fieldRow(body, "Location", "je-location", { value: job.location || "" });
    inputs.url = fieldRow(body, "Link", "je-url", { value: job.url || "", type: "url", hint: "This is what the Open button uses." });
    inputs.status = fieldRow(body, "Status", "je-status", { options: STATUS_ORDER.map((s) => ({ value: s, label: STATUS[s] })), value: job.status });
    inputs.salary = fieldRow(body, "Salary", "je-salary", { value: job.salary || "" });
    inputs.source = fieldRow(body, "Where you found it", "je-source", { value: job.source || "" });
    inputs.deadline = fieldRow(body, "Closes", "je-deadline", { type: "date", value: dateInput(job.deadline) });
    inputs.notes = fieldRow(body, "Notes", "je-notes", { textarea: true, value: job.notes || "", placeholder: "Recruiter name, referral, what you tailored" });

    if (job.events?.length > 1) {
      const h = el("div", "fld");
      h.appendChild(el("span", "lbl", "History"));
      const list = el("div", "commits");
      [...job.events].reverse().forEach((ev) => {
        list.appendChild(el("div", "commit", `<code>${esc(dateStr(ev.at))}</code><span>${esc(ev.from ? `${STATUS[ev.from] || ev.from} \u2192 ${STATUS[ev.to] || ev.to}` : STATUS[ev.to] || ev.to)}${ev.note ? " \u00b7 " + esc(ev.note) : ""}</span>`));
      });
      h.appendChild(list);
      body.appendChild(h);
    }
    if (job.jdText) {
      const h = el("div", "fld");
      h.appendChild(el("span", "lbl", `Saved job description \u00b7 ${job.jdText.length.toLocaleString()} characters`));
      const row = el("div", "inline");
      row.appendChild(button("btn ghost small", "Copy the text", async () => {
        await navigator.clipboard.writeText(job.jdText);
        toast("Job description copied");
      }, "Postings get taken down; this is your copy"));
      row.appendChild(button("btn ghost small", "Match my resume", () => {
        $("#jdText").value = job.jdText;
        $("#modal").hidden = true;
        goto("resume");
        setTimeout(() => $("#matchPaste").click(), 120);
      }));
      h.appendChild(row);
      body.appendChild(h);
    }
    body._inputs = inputs;
  }, async (body) => {
    const i = body._inputs;
    const patch = {
      company: i.company.value.trim(),
      title: i.title.value.trim(),
      location: i.location.value.trim(),
      url: i.url.value.trim(),
      status: i.status.value,
      salary: i.salary.value.trim(),
      source: i.source.value.trim(),
      notes: i.notes.value,
      deadline: i.deadline.value ? Date.parse(i.deadline.value) : 0,
    };
    const res = await send({ type: "updateJob", id: job.id, patch });
    if (!res.ok) { toast(res.error); return false; }
    vault = (await send({ type: "getVault" })).vault;
    renderJobs();
    toast("Saved");
  });
}

$("#jobsSearch").oninput = renderJobs;
$("#jobsSort").onchange = renderJobs;
$("#jobsAdd").onclick = () => {
  modal("Add a job", (body) => {
    const i = {};
    i.url = fieldRow(body, "Link", "ja-url", { type: "url", placeholder: "https://..." });
    i.company = fieldRow(body, "Company", "ja-company");
    i.title = fieldRow(body, "Role", "ja-title");
    i.location = fieldRow(body, "Location", "ja-location");
    i.status = fieldRow(body, "Status", "ja-status", { options: STATUS_ORDER.map((s) => ({ value: s, label: STATUS[s] })) });
    i.notes = fieldRow(body, "Notes", "ja-notes", { textarea: true });
    body._inputs = i;
  }, async (body) => {
    const i = body._inputs;
    if (!i.company.value.trim() && !i.url.value.trim()) { toast("Give it at least a company or a link"); return false; }
    const res = await send({
      type: "saveJob",
      job: {
        url: i.url.value.trim(), company: i.company.value.trim(), title: i.title.value.trim(),
        location: i.location.value.trim(), status: i.status.value, notes: i.notes.value,
      },
    });
    if (!res.ok) { toast(res.error); return false; }
    vault = (await send({ type: "getVault" })).vault;
    renderJobs();
    renderCounts();
    toast(res.duplicate ? "That link was already tracked, so it was refreshed" : "Job added");
  }, "Add");
};

function csvCell(v) {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function downloadFile(name, text, mime = "text/plain") {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
function exportJobsCsv() {
  const cols = ["Company", "Role", "Location", "Status", "Saved", "Applied", "Match", "Salary", "Source", "Deadline", "Link", "Notes"];
  const rows = (vault.jobs || []).map((j) => [
    j.company, j.title, j.location, STATUS[j.status] || j.status,
    dateStr(j.savedAt), dateStr(j.appliedAt), j.matchScore ?? "",
    j.salary, j.source, dateStr(j.deadline), j.url, j.notes,
  ]);
  const csv = [cols, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n");
  downloadFile(`jobvault-applications-${new Date().toISOString().slice(0, 10)}.csv`, csv, "text/csv");
  toast(`Exported ${rows.length} row${rows.length === 1 ? "" : "s"}`);
}
$("#jobsCsv").onclick = exportJobsCsv;
$("#exportJobsCsv").onclick = exportJobsCsv;

// -------------------------------------------------------------------- logins

function renderLogins() {
  const entries = Object.values(vault.logins || {});
  const q = $("#loginsSearch").value.trim().toLowerCase();
  const list = entries
    .filter((e) => !q || [e.company, e.host, e.email].some((f) => String(f || "").toLowerCase().includes(q)))
    .sort((a, b) => String(a.company || a.host).localeCompare(String(b.company || b.host)));

  // Reused passwords across employers are worth flagging, since one leak then
  // opens several portals that all hold your address and work history.
  const byPass = new Map();
  for (const e of entries) {
    if (!e.password) continue;
    if (!byPass.has(e.password)) byPass.set(e.password, []);
    byPass.get(e.password).push(e);
  }
  const reused = [...byPass.values()].filter((g) => g.length > 1);
  const warn = $("#reuseWarn");
  warn.hidden = reused.length === 0;
  if (reused.length) {
    warn.innerHTML = `<div class="callout-body"><strong>${reused.length} password${reused.length === 1 ? " is" : "s are"} used at more than one company</strong><span class="sub">${esc(reused.map((g) => g.map((e) => e.company || e.host).join(" = ")).slice(0, 3).join(" \u00b7 "))}</span></div>`;
  }

  const box = $("#loginsList");
  box.innerHTML = "";
  $("#loginsEmpty").hidden = entries.length > 0;
  for (const entry of list) box.appendChild(loginRow(entry));
}

function loginRow(entry) {
  const row = el("div", "row");
  const main = el("div", "row-main");
  main.appendChild(el("div", "row-title", esc(entry.company || entry.host)));
  const sub = el("div", "row-sub");
  sub.innerHTML =
    `<span class="tenant">${tenantHTML(entry.host)}</span>` +
    `<span class="mono">${esc(entry.email || "no email saved")}</span>` +
    (entry.usedCount ? `<span class="faint">filled ${entry.usedCount}\u00d7</span>` : "") +
    (entry.aliases?.length ? `<span class="faint">+${entry.aliases.length} other address${entry.aliases.length === 1 ? "" : "es"}</span>` : "");
  main.appendChild(sub);
  const reveal = el("div", "mono small faint");
  reveal.style.marginTop = "5px";
  reveal.textContent = "\u2022".repeat(12);
  main.appendChild(reveal);
  row.appendChild(main);

  const actions = el("div", "row-actions");
  actions.appendChild(button("mini", "Show", (e) => {
    const hidden = reveal.textContent.startsWith("\u2022");
    reveal.textContent = hidden ? entry.password || "no password saved" : "\u2022".repeat(12);
    e.target.textContent = hidden ? "Hide" : "Show";
  }));
  actions.appendChild(button("mini", "Copy", async () => {
    try { await navigator.clipboard.writeText(entry.password || ""); toast("Password copied"); }
    catch { toast("Could not copy"); }
  }));
  actions.appendChild(button("mini go", "Open", () => chrome.tabs.create({ url: entry.url || `https://${entry.host}` })));
  actions.appendChild(button("mini", "Edit", () => openLoginEditor(entry)));
  actions.appendChild(button("mini bad", "Delete", () => {
    if (!confirm(`Delete the saved login for ${entry.company || entry.host}?`)) return;
    delete vault.logins[entry.host];
    persist("logins", { quiet: true });
    renderLogins();
    renderCounts();
  }));
  row.appendChild(actions);
  return row;
}

function openLoginEditor(entry) {
  const isNew = !entry;
  const e = entry || {};
  modal(isNew ? "Add a login" : `Edit ${e.company || e.host}`, (body) => {
    const i = {};
    i.company = fieldRow(body, "Company", "le-company", { value: e.company || "" });
    i.host = fieldRow(body, "Site address", "le-host", {
      value: e.host || "", placeholder: "nvidia.wd5.myworkdayjobs.com",
      hint: "The exact hostname. This is what keeps one Workday tenant from filling another's password.",
    });
    i.email = fieldRow(body, "Email", "le-email", { type: "email", value: e.email || "" });
    i.password = fieldRow(body, "Password", "le-password", { type: "text", value: e.password || "" });
    const genRow = el("div", "inline");
    genRow.appendChild(button("btn ghost small", "Generate a strong one", async () => {
      const res = await send({ type: "generatePassword", opts: { length: 20, avoidAmbiguous: vault.settings.avoidAmbiguous !== false } });
      if (res.ok) { i.password.value = res.password; toast(`${res.bits} bits of entropy`); }
    }));
    body.appendChild(genRow);
    i.aliases = fieldRow(body, "Other addresses that share this login", "le-aliases", {
      value: (e.aliases || []).join(", "),
      placeholder: "careers.acme.com, acme.wd1.myworkdayjobs.com",
      hint: "Comma separated. Useful when a company puts its login and its job board on different hostnames.",
    });
    i.note = fieldRow(body, "Note", "le-note", { textarea: true, value: e.note || "" });
    body._inputs = i;
  }, async (body) => {
    const i = body._inputs;
    const host = i.host.value.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
    if (!host) { toast("A site address is required"); return false; }
    if (!isNew && e.host !== host) delete vault.logins[e.host];
    const prev = vault.logins[host] || {};
    vault.logins[host] = {
      id: e.id || prev.id || crypto.randomUUID().slice(0, 12),
      host,
      url: prev.url || e.url || `https://${host}`,
      company: i.company.value.trim() || host,
      email: i.email.value.trim(),
      password: i.password.value,
      aliases: i.aliases.value.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
      note: i.note.value,
      createdAt: e.createdAt || prev.createdAt || Date.now(),
      updatedAt: Date.now(),
      usedCount: e.usedCount || prev.usedCount || 0,
    };
    const email = i.email.value.trim();
    if (email && !vault.profile.emails.includes(email)) {
      vault.profile.emails.push(email);
      persist("profile", { quiet: true });
    }
    persist("logins", { quiet: true });
    renderLogins();
    renderProfile();
    renderCounts();
    toast("Saved");
  });
}
$("#loginsAdd").onclick = () => openLoginEditor(null);
$("#loginsSearch").oninput = renderLogins;

// ------------------------------------------------------------------- profile

function renderProfile() {
  vault.profile = normalizeProfile(vault.profile);
  const p = vault.profile;

  const c = completeness(p);
  $("#profileMeter").style.width = c.pct + "%";
  $("#profileMeterText").textContent = `${c.done}/${c.total} core fields`;

  // emails
  const box = $("#emailList");
  box.innerHTML = "";
  if (!p.emails.length) box.appendChild(el("div", "sub", "None yet. Add the address you apply with."));
  for (const addr of p.emails) {
    const row = el("div", "email-row");
    row.appendChild(el("span", "addr", esc(addr)));
    if (addr === p.defaultEmail) row.appendChild(el("span", "tag", "default"));
    row.appendChild(el("span", "spacer"));
    if (addr !== p.defaultEmail) {
      row.appendChild(button("mini", "Make default", () => {
        p.defaultEmail = addr;
        if (!p.values.email) p.values.email = addr;
        persist("profile");
        renderProfile();
      }));
    }
    row.appendChild(button("mini bad", "Remove", () => {
      p.emails = p.emails.filter((x) => x !== addr);
      if (p.defaultEmail === addr) p.defaultEmail = p.emails[0] || "";
      persist("profile");
      renderProfile();
    }));
    box.appendChild(row);
  }

  // grouped fields
  const groups = $("#profileGroups");
  groups.innerHTML = "";
  for (const g of GROUPS) {
    const card = el("div", "group");
    card.appendChild(el("h3", null, esc(g.label)));
    if (g.blurb) card.appendChild(el("p", "sub", esc(g.blurb)));
    const grid = el("div", "group-grid");
    for (const f of g.fields) {
      const wrap = el("label", "fld w" + (f.w || 1));
      wrap.appendChild(el("span", "lbl", esc(f.label)));
      let input;
      if (f.type === "select") {
        input = document.createElement("select");
        input.className = "field";
        const blank = document.createElement("option");
        blank.value = ""; blank.textContent = "\u2014";
        input.appendChild(blank);
        for (const o of f.options) {
          const opt = document.createElement("option");
          opt.value = o; opt.textContent = o;
          input.appendChild(opt);
        }
      } else {
        input = document.createElement("input");
        input.className = "field";
        input.type = f.type === "number" ? "number" : f.type === "date" ? "date" : f.type === "url" ? "url" : f.type === "email" ? "email" : f.type === "tel" ? "tel" : "text";
      }
      input.value = p.values[f.key] || "";
      input.oninput = () => { p.values[f.key] = input.value; persist("profile"); scheduleMeter(); };
      input.onchange = () => { p.values[f.key] = input.value; persist("profile"); scheduleMeter(); };
      wrap.appendChild(input);
      if (f.hint) wrap.appendChild(el("span", "hint", esc(f.hint)));
      grid.appendChild(wrap);
    }
    card.appendChild(grid);
    groups.appendChild(card);
  }

  renderRepeater($("#workHistoryBox"), "Work history", "Portals that make you retype every job go faster with this filled in.", p.workHistory, WORK_HISTORY_FIELDS, (item) => item.title || item.company || "New entry");
  renderRepeater($("#educationBox"), "Education", "", p.education, EDUCATION_FIELDS, (item) => item.school || "New entry");
}

let meterTimer = null;
function scheduleMeter() {
  clearTimeout(meterTimer);
  meterTimer = setTimeout(() => {
    const c = completeness(vault.profile);
    $("#profileMeter").style.width = c.pct + "%";
    $("#profileMeterText").textContent = `${c.done}/${c.total} core fields`;
    $("#navProfile").textContent = c.pct + "%";
  }, 260);
}

function renderRepeater(host, label, blurb, list, fields, titleOf) {
  host.innerHTML = "";
  const head = el("div", "panel-head");
  const left = el("div");
  left.appendChild(el("h3", "h3", esc(label)));
  if (blurb) left.appendChild(el("p", "sub", esc(blurb)));
  head.appendChild(left);
  const actions = el("div", "head-actions");
  actions.appendChild(button("btn ghost small", "Add", () => {
    list.push({});
    persist("profile");
    renderProfile();
  }));
  head.appendChild(actions);
  host.appendChild(head);

  if (!list.length) {
    host.appendChild(el("p", "sub", "Nothing added yet."));
    return;
  }
  list.forEach((item, idx) => {
    const card = el("div", "rep-item");
    const top = el("div", "rep-top");
    top.appendChild(el("strong", null, esc(titleOf(item))));
    top.appendChild(el("span", "spacer"));
    if (idx > 0) top.appendChild(button("mini", "Move up", () => {
      [list[idx - 1], list[idx]] = [list[idx], list[idx - 1]];
      persist("profile"); renderProfile();
    }));
    top.appendChild(button("mini bad", "Remove", () => {
      list.splice(idx, 1);
      persist("profile"); renderProfile();
    }));
    card.appendChild(top);
    const grid = el("div", "group-grid");
    for (const f of fields) {
      const wrap = el("label", "fld w" + (f.w || 1));
      wrap.appendChild(el("span", "lbl", esc(f.label)));
      let input;
      if (f.type === "textarea") {
        input = document.createElement("textarea");
        input.className = "area";
      } else if (f.type === "check") {
        input = document.createElement("input");
        input.type = "checkbox";
        input.checked = Boolean(item[f.key]);
        input.onchange = () => { item[f.key] = input.checked; persist("profile"); };
        wrap.appendChild(input);
        grid.appendChild(wrap);
        continue;
      } else {
        input = document.createElement("input");
        input.className = "field";
        input.type = f.type === "month" ? "month" : "text";
      }
      input.value = item[f.key] || "";
      input.oninput = () => { item[f.key] = input.value; persist("profile"); };
      wrap.appendChild(input);
      if (f.hint) wrap.appendChild(el("span", "hint", esc(f.hint)));
      grid.appendChild(wrap);
    }
    card.appendChild(grid);
    host.appendChild(card);
  });
}

$("#emailAddBtn").onclick = () => {
  const v = $("#emailAdd").value.trim();
  if (!v) return;
  const p = vault.profile;
  if (!p.emails.includes(v)) p.emails.push(v);
  if (!p.defaultEmail) p.defaultEmail = v;
  if (!p.values.email) p.values.email = v;
  $("#emailAdd").value = "";
  persist("profile");
  renderProfile();
};
$("#emailAdd").onkeydown = (e) => e.key === "Enter" && $("#emailAddBtn").click();

// -------------------------------------------------------------------- resume

function renderResume() {
  $("#resumeText").value = vault.resume?.text || "";
  const r = vault.resume || {};
  $("#resumeMeta").textContent = r.text
    ? `${r.text.trim().split(/\s+/).length.toLocaleString()} words \u00b7 saved ${ago(r.updatedAt)}`
    : "Nothing saved yet. Without a resume there is no match score.";
}
$("#resumeSave").onclick = () => {
  vault.resume = { text: $("#resumeText").value, updatedAt: Date.now(), fileName: vault.resume?.fileName || "" };
  persist("resume", { quiet: true });
  renderResume();
  toast("Resume saved");
};
$("#resumeFile").onchange = async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const text = await file.text();
  $("#resumeText").value = text;
  vault.resume = { text, updatedAt: Date.now(), fileName: file.name };
  persist("resume", { quiet: true });
  renderResume();
  toast(`Loaded ${file.name}`);
};

$("#scanTab").onclick = async () => {
  const resume = $("#resumeText").value.trim();
  if (!resume) return toast("Save your resume first");
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab?.id) return toast("No page to read");
  try {
    const res = await chrome.tabs.sendMessage(tab.id, { type: "scrapeJob" });
    if (!res?.jdText || res.jdText.length < 200) return toast("Could not find a job description on that tab");
    $("#jdText").value = res.jdText;
    showMatch(computeMatch(resume, res.jdText), `${res.company || ""} ${res.title || res.pageTitle || ""}`.trim());
  } catch {
    toast("That tab is not reachable. Open the posting and reload it.");
  }
};
$("#matchPaste").onclick = () => {
  const resume = $("#resumeText").value.trim();
  const jd = $("#jdText").value.trim();
  if (!resume) return toast("Save your resume first");
  if (!jd) return toast("Paste a job description");
  showMatch(computeMatch(resume, jd), "Pasted description");
};

function showMatch(result, title) {
  const host = $("#matchResult");
  host.hidden = false;
  host.innerHTML = "";
  const card = el("div", "match-card");
  const colour = result.score >= 70 ? "var(--green)" : result.score >= 45 ? "var(--brass)" : "var(--rust)";
  const circ = 2 * Math.PI * 32;
  const top = el("div", "match-top");
  top.innerHTML = `
    <svg class="ring" viewBox="0 0 78 78" aria-hidden="true">
      <circle cx="39" cy="39" r="32" fill="none" stroke="var(--steel)" stroke-width="8"/>
      <circle cx="39" cy="39" r="32" fill="none" stroke="${colour}" stroke-width="8" stroke-linecap="round"
        stroke-dasharray="${circ}" stroke-dashoffset="${circ - (circ * result.score) / 100}" transform="rotate(-90 39 39)"/>
    </svg>
    <div>
      <div class="match-score">${result.score}%</div>
      <div class="sub"><b style="color:var(--text)">${esc(verdict(result.score))}</b>${title ? " \u00b7 " + esc(title) : ""}</div>
    </div>`;
  card.appendChild(top);

  const notes = el("ul", "notes");
  for (const n of result.notes) {
    notes.appendChild(el("li", n.kind, `<s>${n.kind === "ok" ? "\u2713" : "!"}</s><span>${esc(n.text)}</span>`));
  }
  card.appendChild(notes);

  const termBlock = (label, terms, cls) => {
    if (!terms.length) return;
    const box = el("div", "termbox");
    box.appendChild(el("span", "lbl", esc(label)));
    const wrap = el("div", "terms");
    terms.forEach((t) => wrap.appendChild(el("span", "term " + cls, esc(t))));
    box.appendChild(wrap);
    card.appendChild(box);
  };
  termBlock("Missing from the requirements section", result.mustHaveMissing, "must");
  termBlock("Worth adding if true for you", result.missing.filter((m) => !result.mustHaveMissing.includes(m)), "miss");
  termBlock("Already covered", result.have, "have");
  host.appendChild(card);
  host.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

// ------------------------------------------------------------------- answers

function renderAnswers() {
  const list = vault.snippets || [];
  const box = $("#answersList");
  box.innerHTML = "";
  $("#answersEmpty").hidden = list.length > 0;
  list.forEach((s, idx) => {
    const row = el("div", "row");
    const main = el("div", "row-main");
    main.appendChild(el("div", "row-title", esc(s.title || "Untitled")));
    main.appendChild(el("div", "row-sub", `<span>${esc((s.body || "").slice(0, 120))}${(s.body || "").length > 120 ? "\u2026" : ""}</span>`));
    row.appendChild(main);
    const actions = el("div", "row-actions");
    actions.appendChild(button("mini go", "Copy", async () => {
      try { await navigator.clipboard.writeText(s.body || ""); toast("Copied"); } catch { toast("Could not copy"); }
    }));
    actions.appendChild(button("mini", "Edit", () => openAnswerEditor(s, idx)));
    actions.appendChild(button("mini bad", "Delete", () => {
      vault.snippets.splice(idx, 1);
      persist("snippets", { quiet: true });
      renderAnswers();
      renderCounts();
    }));
    row.appendChild(actions);
    box.appendChild(row);
  });
}

function openAnswerEditor(snippet, idx) {
  const s = snippet || {};
  modal(snippet ? "Edit answer" : "New answer", (body) => {
    const i = {};
    i.title = fieldRow(body, "Question", "an-title", { value: s.title || "", placeholder: "Why do you want to work here?" });
    i.body = fieldRow(body, "Your answer", "an-body", { textarea: true, value: s.body || "" });
    body._inputs = i;
  }, (body) => {
    const i = body._inputs;
    if (!i.title.value.trim() && !i.body.value.trim()) return false;
    const rec = { title: i.title.value.trim(), body: i.body.value, updatedAt: Date.now() };
    if (idx == null) (vault.snippets = vault.snippets || []).unshift(rec);
    else vault.snippets[idx] = { ...s, ...rec };
    persist("snippets", { quiet: true });
    renderAnswers();
    renderCounts();
    toast("Saved");
  });
}
$("#answerAdd").onclick = () => openAnswerEditor(null, null);

// ------------------------------------------------------------------ settings

function renderSettings() {
  const s = vault.settings;
  $("#setAutofill").checked = s.autofillLogins !== false;
  $("#setSingle").checked = s.autofillOnlyWhenSingleMatch !== false;
  $("#setBadge").checked = s.showFieldBadge !== false;
  $("#setDock").checked = s.showDock !== false;
  $("#setAutoApp").checked = s.autofillApplication === true;
  $("#setMatch").checked = s.matchOnOpen !== false;
  $("#setTrack").checked = s.autoTrackApplications !== false;
  $("#setFollowDays").value = String(s.followUpDays ?? 7);
  $("#setAutolock").value = String(s.autolockMinutes ?? 15);

  const u = vault.updates;
  $("#updRepo").value = u.repo || "";
  $("#updBranch").value = u.branch || "main";
  $("#updToken").value = u.token || "";
  $("#updAutoCheck").checked = u.autoCheck !== false;
  $("#updAutoReload").checked = u.autoReload !== false;
  $("#updNativeOn").checked = u.nativeUpdater === true;
  $("#updNative").hidden = u.nativeUpdater !== true;

  $("#hardenBox").hidden = !state.needsRehardening;
  $("#pinStatus").textContent = state.hasPin
    ? "On. You can unlock with the PIN instead of the master password."
    : "Off. Set one for faster unlocking; the master password keeps working either way.";
  $("#pinRemove").hidden = !state.hasPin;
  $("#pinSave").textContent = state.hasPin ? "Change PIN" : "Set PIN";

  renderUpdateStatus();
  renderNativeHelp();
}

const settingBind = {
  setAutofill: "autofillLogins", setSingle: "autofillOnlyWhenSingleMatch", setBadge: "showFieldBadge", setDock: "showDock",
  setAutoApp: "autofillApplication", setMatch: "matchOnOpen", setTrack: "autoTrackApplications",
};
for (const [id, key] of Object.entries(settingBind)) {
  $("#" + id).onchange = () => { vault.settings[key] = $("#" + id).checked; persist("settings", { quiet: true }); toast("Setting saved"); };
}
$("#setFollowDays").onchange = () => { vault.settings.followUpDays = parseInt($("#setFollowDays").value, 10); persist("settings", { quiet: true }); renderJobs(); };
$("#setAutolock").onchange = () => { vault.settings.autolockMinutes = parseInt($("#setAutolock").value, 10); persist("settings", { quiet: true }); toast("Auto lock updated"); };

for (const id of ["updRepo", "updBranch", "updToken"]) {
  $("#" + id).onchange = () => {
    vault.updates.repo = $("#updRepo").value.trim() || "kashrtx/jobvault";
    vault.updates.branch = $("#updBranch").value.trim() || "main";
    vault.updates.token = $("#updToken").value.trim();
    persist("updates", { quiet: true });
    renderUpdateStatus();
  };
}
$("#updAutoCheck").onchange = () => { vault.updates.autoCheck = $("#updAutoCheck").checked; persist("updates", { quiet: true }); };
$("#updAutoReload").onchange = () => { vault.updates.autoReload = $("#updAutoReload").checked; persist("updates", { quiet: true }); };
$("#updNativeOn").onchange = async () => {
  const on = $("#updNativeOn").checked;
  if (on) {
    const res = await send({ type: "requestNativePermission" });
    if (!res.ok) { $("#updNativeOn").checked = false; return toast(res.error || "Permission refused"); }
  }
  vault.updates.nativeUpdater = on;
  $("#updNative").hidden = !on;
  persist("updates", { quiet: true });
  renderNativeHelp();
};

function renderNativeHelp() {
  const help = $("#nativeHelp");
  help.hidden = !$("#updNativeOn").checked;
  if (help.hidden) return;
  help.innerHTML =
    `The helper is a small script that runs <code class="mono">git fetch</code> and <code class="mono">git reset --hard</code> in your checkout, so <b>Update now</b> works without a terminal. Install it once from your JobVault folder:<br>` +
    `<span class="mono" style="color:var(--brass-hi)">./scripts/install-updater.sh ${esc(chrome.runtime.id)}</span><br>` +
    `On Windows: <span class="mono" style="color:var(--brass-hi)">powershell -ExecutionPolicy Bypass -File scripts\\install-updater.ps1 ${esc(chrome.runtime.id)}</span>`;
}

function renderHeadUpdate() {
  const box = $("#headUpdate");
  if (!update?.behind) return (box.hidden = true);
  box.hidden = false;
  $("#headUpdateText").textContent = update.latestVersion
    ? `Update available \u2014 v${update.latestVersion}`
    : `New commit \u2014 ${update.latestShortSha}`;
}

function renderUpdateStatus() {
  const box = $("#updateStatus");
  box.innerHTML = "";
  const line = (label, value, cls) =>
    box.appendChild(el("div", "line", `<b>${esc(label)}</b><span class="${cls || ""}">${esc(value)}</span>`));

  line("Running", `v${state.version}${build?.sha ? " \u00b7 " + build.sha.slice(0, 7) : ""}`);
  if (build?.builtAt) line("Pulled", dateStr(Date.parse(build.builtAt)) || build.builtAt);

  if (!update) {
    line("GitHub", "not checked yet");
  } else if (!update.ok) {
    line("GitHub", update.error, "state-err");
  } else if (update.behind) {
    line("Latest", `${update.latestVersion ? "v" + update.latestVersion + " \u00b7 " : ""}${update.latestShortSha}`, "state-behind");
    if (update.latestSubject) line("Message", update.latestSubject);
    line("Status", update.reason === "version" ? "a newer version is tagged" : "new commits on the branch", "state-behind");
  } else {
    line("Status", "up to date", "state-ok");
    if (update.checkedAt) line("Checked", ago(update.checkedAt));
  }
  if (!build?.sha) {
    box.appendChild(el("p", "sub", "No build.json on disk, so commits cannot be compared exactly. The pull script writes one."));
  }

  const cmdBox = $("#updateCmd");
  cmdBox.hidden = !update?.behind;
  if (update?.behind) {
    $("#updateCmdText").textContent = `cd /path/to/jobvault && ./scripts/update.sh`;
  }
  $("#updOpen").hidden = !update?.latestUrl;
  $("#updOpen").onclick = () => chrome.tabs.create({ url: update.latestUrl });

  const commits = $("#updateCommits");
  commits.innerHTML = "";
  commits.hidden = !update?.commits?.length;
  for (const c of update?.commits || []) {
    commits.appendChild(el("div", "commit", `<code>${esc(c.sha)}</code><span>${esc(c.subject)}</span>`));
  }
}

$("#updateCmdCopy").onclick = async () => {
  await navigator.clipboard.writeText($("#updateCmdText").textContent);
  toast("Command copied");
};
$("#updCheck").onclick = async () => {
  $("#updCheck").textContent = "Checking\u2026";
  const res = await send({ type: "checkUpdate" });
  $("#updCheck").textContent = "Check now";
  if (!res.ok) return toast(res.error);
  update = res.status;
  build = (await send({ type: "getUpdate" })).build;
  renderUpdateStatus();
  renderHeadUpdate();
  toast(update.ok ? (update.behind ? "An update is waiting" : "Already up to date") : update.error);
};
$("#updReload").onclick = () => {
  toast("Reloading\u2026");
  setTimeout(() => send({ type: "reloadExtension" }), 350);
};
$("#updNative").onclick = async () => {
  $("#updNative").textContent = "Pulling\u2026";
  const res = await send({ type: "nativeUpdate" });
  $("#updNative").textContent = "Update now";
  if (!res.ok) return toast(res.error);
  toast(res.result?.message || "Pulled. Reloading.");
  setTimeout(() => send({ type: "reloadExtension" }), 900);
};

// security
$("#pinSave").onclick = async () => {
  const pin = $("#pinNew").value.trim();
  const msg = $("#setMsg");
  msg.className = "msg";
  if (!/^\d{4,12}$/.test(pin)) return (msg.textContent = "The PIN must be 4 to 12 digits.");
  const res = await send({ type: "setupPin", pin });
  if (!res.ok) return (msg.textContent = res.error);
  $("#pinNew").value = "";
  msg.className = "msg ok";
  msg.textContent = "PIN saved.";
  state = await send({ type: "getState" });
  renderSettings();
};
$("#pinRemove").onclick = async () => {
  await send({ type: "disablePin" });
  state = await send({ type: "getState" });
  renderSettings();
  toast("PIN turned off");
};
$("#cmGo").onclick = async () => {
  const a = $("#cmPass").value, b = $("#cmPass2").value;
  const msg = $("#setMsg");
  msg.className = "msg";
  if (a.length < 8) return (msg.textContent = "Use at least 8 characters.");
  if (a !== b) return (msg.textContent = "The two passwords do not match.");
  const res = await send({ type: "changeMaster", newPassword: a });
  if (!res.ok) return (msg.textContent = res.error);
  $("#cmPass").value = $("#cmPass2").value = "";
  msg.className = "msg ok";
  msg.textContent = res.note || "Master password changed.";
};
$("#hardenGo").onclick = async () => {
  const msg = $("#setMsg");
  msg.className = "msg";
  const res = await send({ type: "reharden", password: $("#hardenPass").value });
  if (!res.ok) return (msg.textContent = res.error);
  $("#hardenPass").value = "";
  msg.className = "msg ok";
  msg.textContent = res.note;
  state = await send({ type: "getState" });
  renderSettings();
};

// backup
$("#exportVault").onclick = async () => {
  await flush();
  const local = await chrome.storage.local.get(["jv_meta", "jv_vault"]);
  if (!local.jv_meta) return toast("Nothing to export");
  const counts = {
    jobs: (vault.jobs || []).length,
    logins: Object.keys(vault.logins || {}).length,
    answers: (vault.snippets || []).length,
  };
  const payload = {
    format: "jobvault-backup",
    version: 2,
    vaultVersion: state.vaultVersion || 3,
    appVersion: state.version,
    exportedAt: new Date().toISOString(),
    counts,
    ...local,
  };
  const text = JSON.stringify(payload, null, 2);
  downloadFile(`jobvault-backup-${new Date().toISOString().slice(0, 10)}.json`, text, "application/json");
  await send({ type: "noteExported", counts });
  state = await send({ type: "getState" });
  renderSafety();
  toast(`Exported ${counts.jobs} jobs and ${counts.logins} logins`);
};

$("#importVault").onchange = async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  e.target.value = "";
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch {
    return toast("That file is not valid JSON");
  }
  if (data.format !== "jobvault-backup" || !data.jv_meta || !data.jv_vault) {
    return toast("That file is not a JobVault backup");
  }
  const c = data.counts || {};
  const summary = data.counts
    ? `${c.jobs ?? "?"} jobs, ${c.logins ?? "?"} logins, ${c.answers ?? "?"} answers`
    : "contents unknown";
  const when = data.exportedAt ? new Date(data.exportedAt).toLocaleString() : "an unknown date";
  if (!confirm(
    `Restore the backup from ${when}?\n\nIt contains ${summary}.\n\n` +
    `This replaces the vault on this browser. A backup of the current one is ` +
    `taken first, so you can undo it from Settings.`,
  )) return;

  // Snapshot what is about to be replaced before touching a byte of it.
  const prep = await send({ type: "prepareImport" });
  if (!prep.ok) return toast(prep.error || "Could not back up the current vault, so nothing was changed.");

  try {
    await chrome.storage.local.set({ jv_meta: data.jv_meta, jv_vault: data.jv_vault });
  } catch (err) {
    return toast("The import failed and nothing was changed: " + err.message);
  }
  await send({ type: "lock" });
  toast("Imported. Unlock with that backup's master password.");
  setTimeout(() => location.reload(), 1200);
};

// ------------------------------------------------------------- data safety

function bytes(n) {
  if (!n) return "0 B";
  if (n < 1024) return n + " B";
  if (n < 1048576) return (n / 1024).toFixed(1) + " KB";
  return (n / 1048576).toFixed(1) + " MB";
}

async function renderSafety() {
  const res = await send({ type: "listSnapshots" });
  if (!res.ok) return;
  const s = state.safety || {};

  const status = $("#safetyStatus");
  status.innerHTML = "";
  const line = (label, value, cls) =>
    status.appendChild(el("div", "line", `<b>${esc(label)}</b><span class="${cls || ""}">${esc(value)}</span>`));

  const exportAge = s.lastExportAt ? Math.floor((Date.now() - s.lastExportAt) / DAY) : null;
  if (exportAge == null) {
    line("Exported backup", "never — the only copy is in this browser", "state-behind");
  } else {
    line("Exported backup", `${dateStr(s.lastExportAt)} (${ago(s.lastExportAt)})`, exportAge > 30 ? "state-behind" : "state-ok");
  }
  line("Automatic backups", `${res.snapshots.length} of ${res.max} kept in this browser`, res.snapshots.length ? "state-ok" : "");
  if (s.snapshotError) line("Backup problem", s.snapshotError, "state-err");
  if (s.lastReadFailAt) line("Last failed read", dateStr(s.lastReadFailAt), "state-err");
  if (s.hasLegacyBackup) line("Version 1 vault", "kept, opens with your old master password", "state-ok");
  line("Extension ID", state.extensionId || "unknown");

  // The single most common way to lose access to an unpacked extension's data.
  $("#pathWarn").hidden = false;

  const box = $("#snapList");
  box.innerHTML = "";
  if (!res.snapshots.length) {
    box.appendChild(el("p", "sub", "None yet. One is taken daily, and before anything risky."));
  }
  for (const snap of res.snapshots) {
    const row = el("div", "row");
    const main = el("div", "row-main");
    main.appendChild(el("div", "row-title", esc(dateStr(snap.at) + " \u00b7 " + new Date(snap.at).toLocaleTimeString())));
    const c = snap.counts || {};
    main.appendChild(el("div", "row-sub",
      `<span>${esc(snap.reason)}</span>` +
      `<span class="mono">${c.jobs ?? "?"} jobs \u00b7 ${c.logins ?? "?"} logins \u00b7 ${c.answers ?? "?"} answers</span>` +
      `<span class="faint">${esc(bytes(snap.bytes))}</span>`));
    row.appendChild(main);
    const actions = el("div", "row-actions");
    actions.appendChild(button("mini go", "Restore", async () => {
      if (!confirm(
        `Restore the backup from ${dateStr(snap.at)}?\n\n` +
        `It holds ${c.jobs ?? "?"} jobs and ${c.logins ?? "?"} logins. The current vault is ` +
        `backed up first, so this is undoable.`,
      )) return;
      const r = await send({ type: "restoreSnapshot", key: snap.key });
      if (!r.ok) return toast(r.error);
      toast(`Restored ${r.counts.jobs} jobs and ${r.counts.logins} logins`);
      await enter();
      goto("settings");
    }));
    actions.appendChild(button("mini bad", "Delete", async () => {
      await send({ type: "deleteSnapshot", key: snap.key });
      renderSafety();
    }));
    row.appendChild(actions);
    box.appendChild(row);
  }
}

$("#snapNow").onclick = async () => {
  await flush();
  const res = await send({ type: "makeSnapshot", reason: "saved by hand" });
  if (!res.ok) return toast(res.error);
  toast("Backup taken");
  renderSafety();
};

boot();
