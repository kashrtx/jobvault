import { computeMatch } from "./lib/match.js";

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));
const send = (msg) => new Promise((r) => chrome.runtime.sendMessage(msg, (res) => r(res || { ok: false })));

let vault = null;
let editingKey = null;

function toast(text) {
  const t = $("#toast");
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.hidden = true), 2200);
}
async function copy(text, label) {
  try {
    await navigator.clipboard.writeText(text || "");
    toast(`${label} copied`);
  } catch {
    toast("Could not copy");
  }
}
function show(view) {
  ["onboard", "lock", "main"].forEach((v) => ($(`#view-${v}`).hidden = v !== view));
  $("#lockBtn").hidden = view !== "main";
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---------------- init ----------------
async function init() {
  const state = await send({ type: "getState" });
  if (!state.hasVault) return show("onboard");
  if (!state.unlocked) return showLock(state);
  await enterMain();
}

function showLock(state) {
  show("lock");
  const usePin = state.hasPin && !state.pinLocked;
  $("#lk-pin-block").hidden = !usePin;
  $("#lk-master-block").hidden = usePin;
  $("#lk-use-pin").hidden = !state.hasPin;
  if (usePin) setTimeout(() => $("#lk-pin").focus(), 50);
  else setTimeout(() => $("#lk-pass").focus(), 50);
  if (state.pinLocked) {
    $("#lk-msg").className = "msg";
    $("#lk-msg").textContent = "Too many PIN tries. Use your master password.";
  }
}

// ---------------- onboarding ----------------
$("#ob-create").addEventListener("click", async () => {
  const p1 = $("#ob-pass").value, p2 = $("#ob-pass2").value;
  const email = $("#ob-email").value.trim(), pin = $("#ob-pin").value.trim();
  const msg = $("#ob-msg");
  msg.className = "msg";
  if (p1.length < 8) return (msg.textContent = "Use at least 8 characters.");
  if (p1 !== p2) return (msg.textContent = "The two passwords do not match.");
  if (pin && !/^\d{4,12}$/.test(pin)) return (msg.textContent = "The PIN must be 4 to 12 digits.");
  const res = await send({ type: "createVault", password: p1, defaultEmail: email });
  if (!res.ok) return (msg.textContent = res.error || "Could not create the vault.");
  if (pin) await send({ type: "setupPin", pin });
  await enterMain();
});

// ---------------- unlock ----------------
$("#lk-unlock").addEventListener("click", unlockMaster);
$("#lk-pass").addEventListener("keydown", (e) => e.key === "Enter" && unlockMaster());
$("#lk-pin-unlock").addEventListener("click", unlockPin);
$("#lk-pin").addEventListener("keydown", (e) => e.key === "Enter" && unlockPin());
$("#lk-use-master").addEventListener("click", () => { $("#lk-pin-block").hidden = true; $("#lk-master-block").hidden = false; $("#lk-pass").focus(); });
$("#lk-use-pin").addEventListener("click", () => { $("#lk-master-block").hidden = true; $("#lk-pin-block").hidden = false; $("#lk-pin").focus(); });

async function unlockMaster() {
  const msg = $("#lk-msg");
  msg.className = "msg";
  const res = await send({ type: "unlock", password: $("#lk-pass").value });
  if (!res.ok) return (msg.textContent = res.error || "Could not unlock.");
  $("#lk-pass").value = "";
  await enterMain();
}
async function unlockPin() {
  const msg = $("#lk-msg-pin");
  msg.className = "msg";
  const res = await send({ type: "unlockPin", pin: $("#lk-pin").value });
  if (!res.ok) {
    msg.textContent = res.error || "Could not unlock.";
    if (res.needMaster) { $("#lk-pin-block").hidden = true; $("#lk-master-block").hidden = false; }
    $("#lk-pin").value = "";
    return;
  }
  $("#lk-pin").value = "";
  await enterMain();
}

$("#lockBtn").addEventListener("click", async () => {
  await send({ type: "lock" });
  vault = null;
  const state = await send({ type: "getState" });
  showLock(state);
});

// ---------------- enter main ----------------
async function enterMain() {
  const res = await send({ type: "getVault" });
  if (!res.ok) { const s = await send({ type: "getState" }); return showLock(s); }
  vault = res.vault;
  show("main");
  renderEntries();
  refreshEmailOptions();
  loadSettings();
  renderEmails();
  loadResume();
  makePassword();
  checkPending();
  refreshPinUI();
}

// ---------------- tabs ----------------
$$(".tab").forEach((tab) =>
  tab.addEventListener("click", () => {
    $$(".tab").forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");
    $$(".panel").forEach((p) => (p.hidden = p.dataset.panel !== tab.dataset.tab));
  })
);

// ---------------- vault list ----------------
const initials = (n) => (n || "?").trim().slice(0, 2).toUpperCase();

function renderEntries() {
  const q = $("#search").value.trim().toLowerCase();
  const list = Object.values(vault.entries || {}).sort((a, b) => (a.company || a.host).localeCompare(b.company || b.host));
  const filtered = list.filter((e) => !q || (e.company || "").toLowerCase().includes(q) || (e.host || "").toLowerCase().includes(q) || (e.email || "").toLowerCase().includes(q));
  const box = $("#entries");
  box.innerHTML = "";
  $("#empty").hidden = list.length > 0;
  filtered.forEach((e) => {
    const card = document.createElement("div");
    card.className = "entry";
    card.innerHTML = `
      <div class="entry-top">
        <div class="avatar">${escapeHtml(initials(e.company || e.host))}</div>
        <div class="entry-meta">
          <div class="entry-company">${escapeHtml(e.company || e.host)}</div>
          <div class="entry-host">${escapeHtml(e.host)}</div>
        </div>
      </div>
      <div class="entry-email">${escapeHtml(e.email || "no email saved")}</div>
      <div class="entry-pass" data-role="pass">••••••••••••</div>
      <div class="entry-actions">
        <button class="chipbtn" data-act="reveal">Show</button>
        <button class="chipbtn" data-act="copyUser">Copy email</button>
        <button class="chipbtn" data-act="copyPass">Copy password</button>
        <button class="chipbtn" data-act="open">Open site</button>
        <button class="chipbtn" data-act="edit">Edit</button>
        <button class="chipbtn danger" data-act="del">Delete</button>
      </div>`;
    const passEl = card.querySelector('[data-role="pass"]');
    card.querySelectorAll("[data-act]").forEach((btn) =>
      btn.addEventListener("click", () => {
        const act = btn.dataset.act;
        if (act === "reveal") {
          const hidden = passEl.textContent === "••••••••••••";
          passEl.textContent = hidden ? e.password || "no password saved" : "••••••••••••";
          btn.textContent = hidden ? "Hide" : "Show";
        } else if (act === "copyUser") copy(e.email, "Email");
        else if (act === "copyPass") copy(e.password, "Password");
        else if (act === "open") chrome.tabs.create({ url: e.url || `https://${e.host}` });
        else if (act === "edit") openModal(e);
        else if (act === "del" && confirm(`Delete the saved login for ${e.company || e.host}?`)) {
          delete vault.entries[e.host];
          persist();
          renderEntries();
        }
      })
    );
    box.appendChild(card);
  });
}
$("#search").addEventListener("input", renderEntries);
$("#add-manual").addEventListener("click", () => openModal(null));

// ---------------- modal ----------------
function openModal(entry) {
  editingKey = entry ? entry.host : null;
  $("#modal-title").textContent = entry ? "Edit login" : "Add a login";
  $("#md-company").value = entry ? entry.company || "" : "";
  $("#md-host").value = entry ? entry.host || "" : "";
  $("#md-email").value = entry ? entry.email || "" : vault.profile.defaultEmail || "";
  $("#md-password").value = entry ? entry.password || "" : "";
  $("#md-note").value = entry ? entry.note || "" : "";
  $("#modal").hidden = false;
}
$("#md-cancel").addEventListener("click", () => ($("#modal").hidden = true));
$("#md-save").addEventListener("click", () => {
  const hostv = $("#md-host").value.trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (!hostv) return toast("A site is required");
  if (editingKey && editingKey !== hostv) delete vault.entries[editingKey];
  const prev = vault.entries[hostv] || {};
  const email = $("#md-email").value.trim();
  vault.entries[hostv] = {
    host: hostv, url: prev.url || `https://${hostv}`,
    company: $("#md-company").value.trim() || hostv,
    email, password: $("#md-password").value, note: $("#md-note").value.trim(),
    createdAt: prev.createdAt || Date.now(), updatedAt: Date.now(), usedCount: prev.usedCount || 0,
  };
  if (email && !vault.profile.emails.includes(email)) { vault.profile.emails.push(email); if (!vault.profile.defaultEmail) vault.profile.defaultEmail = email; }
  persist();
  $("#modal").hidden = true;
  renderEntries();
  renderEmails();
  refreshEmailOptions();
  toast("Saved");
});

// ---------------- pending ----------------
async function checkPending() {
  const res = await send({ type: "getPending" });
  const p = res.pending;
  if (!p) return ($("#pending").hidden = true);
  $("#pending").hidden = false;
  $("#pending-detail").textContent = `${p.company || p.host} · ${p.email || "no email"}`;
  $("#pending-save").onclick = () => {
    const prev = vault.entries[p.host] || {};
    vault.entries[p.host] = {
      host: p.host, url: p.url || `https://${p.host}`, company: p.company || p.host,
      email: p.email || prev.email || "", password: p.password || prev.password || "",
      note: prev.note || "", createdAt: prev.createdAt || Date.now(), updatedAt: Date.now(), usedCount: prev.usedCount || 0,
    };
    if (p.email && !vault.profile.emails.includes(p.email)) vault.profile.emails.push(p.email);
    persist();
    send({ type: "clearPending" });
    $("#pending").hidden = true;
    renderEntries();
    renderEmails();
    toast("Login saved");
  };
  $("#pending-dismiss").onclick = () => { send({ type: "clearPending" }); $("#pending").hidden = true; };
}

// ---------------- generator ----------------
const genOpts = () => ({
  length: parseInt($("#gen-len").value, 10),
  upper: $("#opt-upper").checked, lower: $("#opt-lower").checked,
  digits: $("#opt-digits").checked, symbols: $("#opt-symbols").checked,
});
async function makePassword() {
  const opts = genOpts();
  const res = await send({ type: "generatePassword", opts });
  if (res.ok) { $("#gen-out").textContent = res.password; strength(res.password, opts); }
}
function strength(pw, opts) {
  let pool = 0;
  if (opts.lower) pool += 24;
  if (opts.upper) pool += 24;
  if (opts.digits) pool += 8;
  if (opts.symbols) pool += 13;
  const bits = pw.length * (Math.log(pool || 26) / Math.log(2));
  const bar = $("#gen-strength-bar");
  bar.style.width = Math.min(100, Math.round(bits / 1.3)) + "%";
  let label, color;
  if (bits < 45) { label = "Weak"; color = "var(--danger)"; }
  else if (bits < 70) { label = "Fair"; color = "var(--brass)"; }
  else if (bits < 100) { label = "Strong"; color = "var(--brass)"; }
  else { label = "Excellent"; color = "var(--ok)"; }
  bar.style.background = color;
  $("#gen-strength").textContent = label;
}
$("#gen-refresh").addEventListener("click", makePassword);
$("#gen-copy").addEventListener("click", () => copy($("#gen-out").textContent, "Password"));
$("#gen-len").addEventListener("input", () => { $("#gen-len-label").textContent = $("#gen-len").value; makePassword(); });
["opt-upper", "opt-lower", "opt-digits", "opt-symbols"].forEach((id) => $("#" + id).addEventListener("change", makePassword));

// ---------------- resume + match ----------------
function loadResume() { $("#resume").value = (vault.resume && vault.resume.text) || ""; }
$("#resume-save").addEventListener("click", () => { vault.resume = { text: $("#resume").value, updatedAt: Date.now() }; persist(); toast("Resume saved"); });
$("#resume-file").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const text = await file.text();
  $("#resume").value = text;
  vault.resume = { text, updatedAt: Date.now() };
  persist();
  toast("Resume loaded");
});
$("#scan-page").addEventListener("click", async () => {
  const resume = ($("#resume").value || "").trim();
  if (!resume) return toast("Add your resume first");
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return toast("No active tab");
  chrome.tabs.sendMessage(tab.id, { type: "scrapeJob" }, (res) => {
    if (chrome.runtime.lastError || !res || !res.ok || !res.text) return toast("Could not read this page. Try the paste box.");
    renderMatch(computeMatch(resume, res.text), res.title || tab.title);
  });
});
$("#match-pasted").addEventListener("click", () => {
  const resume = ($("#resume").value || "").trim();
  const jd = ($("#jd").value || "").trim();
  if (!resume) return toast("Add your resume first");
  if (!jd) return toast("Paste a job description");
  renderMatch(computeMatch(resume, jd), "Pasted job description");
});

function renderMatch(result, title) {
  $("#match-result").hidden = false;
  const ring = $("#ring-fg");
  const circ = 327;
  ring.style.strokeDashoffset = circ - (circ * result.score) / 100;
  ring.style.stroke = result.score >= 70 ? "var(--ok)" : result.score >= 45 ? "var(--brass)" : "var(--miss)";
  const numEl = $("#score-num");
  let n = 0;
  clearInterval(renderMatch._t);
  renderMatch._t = setInterval(() => {
    n += Math.max(1, Math.round(result.score / 20));
    if (n >= result.score) { n = result.score; clearInterval(renderMatch._t); }
    numEl.textContent = n;
  }, 24);
  const verdict =
    result.score >= 75 ? "Strong fit. Apply with confidence." :
    result.score >= 55 ? "Solid fit. Tune your resume to the terms below." :
    result.score >= 35 ? "Partial fit. Worth applying if the role excites you." :
    "Light fit. This posting wants skills your resume does not show yet.";
  $("#match-title").innerHTML = `<div style="color:var(--text);margin-bottom:4px">${escapeHtml(title || "")}</div>${verdict}`;
  fillChips($("#chips-have"), result.have, "have", "Nothing from the posting matched yet.");
  fillChips($("#chips-missing"), result.missing, "miss", "Nice, you cover the main terms.");
}
function fillChips(box, terms, cls, emptyText) {
  box.innerHTML = "";
  if (!terms.length) return (box.innerHTML = `<span class="muted small">${emptyText}</span>`);
  terms.forEach((t) => { const c = document.createElement("span"); c.className = "chip " + cls; c.textContent = t; box.appendChild(c); });
}

// ---------------- emails ----------------
function refreshEmailOptions() {
  const dl = $("#email-options");
  dl.innerHTML = "";
  (vault.profile.emails || []).forEach((e) => { const o = document.createElement("option"); o.value = e; dl.appendChild(o); });
}
function renderEmails() {
  const box = $("#email-list");
  box.innerHTML = "";
  const emails = vault.profile.emails || [];
  if (!emails.length) return (box.innerHTML = `<div class="email-empty">No emails yet. Add the one you apply with.</div>`);
  emails.forEach((e) => {
    const row = document.createElement("div");
    row.className = "email-row";
    const isDefault = e === vault.profile.defaultEmail;
    row.innerHTML = `<span class="addr">${escapeHtml(e)}</span>${isDefault ? '<span class="tag">Default</span>' : '<button class="setdef">Make default</button>'}<button class="rm">Remove</button>`;
    const setdef = row.querySelector(".setdef");
    if (setdef) setdef.onclick = () => { vault.profile.defaultEmail = e; persist(); renderEmails(); };
    row.querySelector(".rm").onclick = () => {
      vault.profile.emails = emails.filter((x) => x !== e);
      if (vault.profile.defaultEmail === e) vault.profile.defaultEmail = vault.profile.emails[0] || "";
      persist();
      renderEmails();
      refreshEmailOptions();
    };
    box.appendChild(row);
  });
}
$("#email-add-btn").addEventListener("click", () => {
  const v = $("#email-add").value.trim();
  if (!v) return;
  if (!vault.profile.emails.includes(v)) vault.profile.emails.push(v);
  if (!vault.profile.defaultEmail) vault.profile.defaultEmail = v;
  $("#email-add").value = "";
  persist();
  renderEmails();
  refreshEmailOptions();
});
$("#email-add").addEventListener("keydown", (e) => e.key === "Enter" && $("#email-add-btn").click());

// ---------------- settings ----------------
function loadSettings() {
  const s = vault.settings || {};
  $("#set-autofill").checked = s.autofill !== false;
  $("#set-matchopen").checked = s.matchOnOpen !== false;
  $("#set-autolock").value = String(s.autolockMinutes ?? 15);
}
$("#set-save").addEventListener("click", () => {
  vault.settings = vault.settings || {};
  vault.settings.autofill = $("#set-autofill").checked;
  vault.settings.matchOnOpen = $("#set-matchopen").checked;
  vault.settings.autolockMinutes = parseInt($("#set-autolock").value, 10);
  persist();
  $("#set-msg").className = "msg ok";
  $("#set-msg").textContent = "Settings saved.";
  setTimeout(() => ($("#set-msg").textContent = ""), 1600);
});

// pin management
async function refreshPinUI() {
  const state = await send({ type: "getState" });
  $("#pin-status").textContent = state.hasPin
    ? "A quick unlock PIN is on. You can unlock with it instead of the master password."
    : "Set a PIN for faster unlock. Your master password still works and stays your recovery key.";
  $("#pin-setup-btn").textContent = state.hasPin ? "Change PIN" : "Set up a PIN";
  $("#pin-remove-btn").hidden = !state.hasPin;
}
$("#pin-setup-btn").addEventListener("click", () => { $("#pin-setup").hidden = false; $("#pin-buttons").hidden = true; $("#pin-new").focus(); });
$("#pin-cancel").addEventListener("click", () => { $("#pin-setup").hidden = true; $("#pin-buttons").hidden = false; $("#pin-new").value = $("#pin-new2").value = ""; });
$("#pin-save").addEventListener("click", async () => {
  const a = $("#pin-new").value.trim(), b = $("#pin-new2").value.trim();
  const msg = $("#set-msg");
  msg.className = "msg";
  if (!/^\d{4,12}$/.test(a)) return (msg.textContent = "PIN must be 4 to 12 digits.");
  if (a !== b) return (msg.textContent = "The two PINs do not match.");
  const res = await send({ type: "setupPin", pin: a });
  if (!res.ok) return (msg.textContent = res.error || "Could not set the PIN.");
  $("#pin-new").value = $("#pin-new2").value = "";
  $("#pin-setup").hidden = true;
  $("#pin-buttons").hidden = false;
  msg.className = "msg ok";
  msg.textContent = "PIN saved.";
  refreshPinUI();
});
$("#pin-remove-btn").addEventListener("click", async () => {
  await send({ type: "disablePin" });
  refreshPinUI();
  toast("PIN turned off");
});

$("#cm-change").addEventListener("click", async () => {
  const p1 = $("#cm-pass").value, p2 = $("#cm-pass2").value;
  const msg = $("#set-msg");
  msg.className = "msg";
  if (p1.length < 8) return (msg.textContent = "Use at least 8 characters.");
  if (p1 !== p2) return (msg.textContent = "The two passwords do not match.");
  const res = await send({ type: "changeMaster", newPassword: p1 });
  if (!res.ok) return (msg.textContent = res.error || "Could not change it.");
  $("#cm-pass").value = $("#cm-pass2").value = "";
  msg.className = "msg ok";
  msg.textContent = "Master password changed.";
});

$("#export").addEventListener("click", async () => {
  const local = await chrome.storage.local.get(["jv_meta", "jv_vault"]);
  const blob = new Blob([JSON.stringify(local, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `jobvault-backup-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
  toast("Backup downloaded");
});
$("#import").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (!data.jv_meta || !data.jv_vault) throw new Error("bad");
    if (!confirm("Importing replaces your current vault. Continue?")) return;
    await chrome.storage.local.set({ jv_meta: data.jv_meta, jv_vault: data.jv_vault });
    await send({ type: "lock" });
    vault = null;
    toast("Backup imported. Unlock with that master password.");
    const state = await send({ type: "getState" });
    showLock(state);
  } catch {
    toast("That file is not a JobVault backup");
  }
});

// ---------------- util ----------------
function persist() { send({ type: "saveVault", vault }); }

send({ type: "pingActivity" });
init();
