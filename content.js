(() => {
  "use strict";
  if (window.__jobVaultLoaded) return;
  window.__jobVaultLoaded = true;

  const send = (msg) =>
    new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (res) => {
          resolve(chrome.runtime.lastError ? { ok: false } : res || { ok: false });
        });
      } catch {
        resolve({ ok: false });
      }
    });

  const host = location.hostname;
  const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

  function friendlyCompany() {
    const h = host.toLowerCase();
    const labels = h.split(".");
    if (h.includes("myworkday")) {
      const first = labels[0];
      if (first && first !== "www" && !/^wd\d+$/.test(first)) return cap(first);
      const seg = location.pathname.split("/").filter(Boolean);
      const guess = seg.find((s) => s.length > 2 && !/^en(-|_)/i.test(s));
      if (guess) return cap(guess.replace(/careers?$/i, "").replace(/[-_]/g, " ").trim());
    }
    const known = ["com", "org", "net", "io", "co", "ai", "app", "jobs"];
    let main = labels[labels.length - 2] || labels[0];
    if (labels.length >= 3 && known.includes(labels[labels.length - 2])) main = labels[labels.length - 3];
    return cap(main);
  }
  const company = friendlyCompany();

  // ---------- field detection ----------
  const isVisible = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
  };
  const passwordFields = () =>
    Array.from(document.querySelectorAll('input[type="password"]')).filter(isVisible);

  function findUserField() {
    const email = Array.from(document.querySelectorAll('input[type="email"]')).filter(isVisible);
    if (email.length) return email[0];
    const auto = Array.from(
      document.querySelectorAll('input[autocomplete="username"], input[autocomplete="email"]')
    ).filter(isVisible);
    if (auto.length) return auto[0];
    const hint = /(email|e-mail|user|login|account)/i;
    const texts = Array.from(document.querySelectorAll('input[type="text"], input:not([type])')).filter(isVisible);
    const hinted = texts.find((el) =>
      hint.test([el.name, el.id, el.getAttribute("aria-label"), el.placeholder].join(" "))
    );
    if (hinted) return hinted;
    const pw = passwordFields()[0];
    if (pw) {
      const all = Array.from(document.querySelectorAll("input")).filter(isVisible);
      const idx = all.indexOf(pw);
      for (let i = idx - 1; i >= 0; i--) {
        const t = all[i].type;
        if (t === "text" || t === "email" || !t) return all[i];
      }
    }
    return texts[0] || null;
  }

  function looksLikeSignup() {
    if (passwordFields().length >= 2) return true;
    const hay = (document.body.innerText || "").slice(0, 5000).toLowerCase();
    const hasCreate = /(create (an )?account|sign ?up|register|get started|create your|verify (new )?password)/i.test(hay);
    return hasCreate;
  }

  function looksLikeJobPosting() {
    if (document.querySelector('[data-automation-id="jobPostingDescription"]')) return true;
    const t = (document.body.innerText || "").toLowerCase();
    const cues = ["responsibilities", "qualifications", "requirements", "what you", "about the role", "job description", "what we", "you will"];
    const hits = cues.filter((k) => t.includes(k)).length;
    return t.length > 700 && hits >= 2;
  }

  function setValue(el, value) {
    if (!el) return;
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  // ---------- card (shadow DOM) ----------
  const STYLE = `
    :host, * { font-family: -apple-system, "Segoe UI", Roboto, sans-serif; box-sizing: border-box; }
    .card { width: 280px; background:#171d28; color:#eef2f8; border:1px solid #2a3446;
      border-radius:14px; box-shadow:0 12px 34px rgba(0,0,0,.5); padding:14px; animation:rise .18s ease-out; margin-top:10px; }
    @keyframes rise { from{opacity:0; transform:translateY(8px)} to{opacity:1; transform:none} }
    .top { display:flex; align-items:center; gap:8px; margin-bottom:10px; }
    .key { width:19px; height:19px; }
    .name { font-size:13px; font-weight:700; letter-spacing:.2px; }
    .name span { color:#d9a441; }
    .sub { font-size:12px; color:#8b97ac; margin:0 0 11px; line-height:1.5; }
    .b { color:#eef2f8; font-weight:600; }
    label.lbl { display:block; font-size:10.5px; color:#8b97ac; margin:0 0 5px; letter-spacing:.3px; text-transform:uppercase; }
    select { width:100%; background:#10141c; color:#eef2f8; border:1px solid #2a3446; border-radius:9px;
      padding:8px 9px; font-size:12.5px; margin-bottom:10px; outline:none; }
    select:focus { border-color:#d9a441; }
    button.act { all:unset; cursor:pointer; display:block; width:100%; text-align:center; font-size:12.5px;
      font-weight:600; border-radius:10px; padding:9px 10px; margin-top:7px; transition:transform .06s, background .15s; }
    button.act:active { transform:scale(.98); }
    .primary { background:#d9a441; color:#191203; }
    .primary:hover { background:#e6b455; }
    .ghost { background:#1d2534; color:#cbd3e1; border:1px solid #2a3446; }
    .ghost:hover { background:#232c3d; }
    .x { position:absolute; top:10px; right:12px; cursor:pointer; color:#6b7688; font-size:16px; line-height:1; }
    .row { position:relative; }
    .toast { display:flex; align-items:center; gap:8px; }
    .dot { width:7px; height:7px; border-radius:50%; background:#5bbf8a; }
    .match-head { display:flex; align-items:center; gap:12px; margin-bottom:10px; }
    .ring { width:52px; height:52px; flex:0 0 auto; }
    .score { font-size:20px; font-weight:700; }
    .verdict { font-size:12px; color:#8b97ac; line-height:1.4; }
    .chips { display:flex; flex-wrap:wrap; gap:5px; margin-top:4px; }
    .chip { font-size:10.5px; padding:4px 8px; border-radius:20px; font-weight:600; }
    .chip.miss { background:rgba(232,131,107,.13); color:#e8836b; border:1px solid rgba(232,131,107,.3); }
    .chip.have { background:rgba(91,191,138,.14); color:#5bbf8a; border:1px solid rgba(91,191,138,.3); }
    .h4 { font-size:10.5px; color:#8b97ac; margin:10px 0 5px; letter-spacing:.3px; text-transform:uppercase; }
  `;

  let hostEl = null;
  function openCard() {
    if (hostEl) hostEl.remove();
    hostEl = document.createElement("div");
    hostEl.style.cssText = "all:initial;position:fixed;right:18px;bottom:18px;z-index:2147483647;";
    const shadow = hostEl.attachShadow({ mode: "open" });
    const wrap = document.createElement("div");
    wrap.innerHTML = `<style>${STYLE}</style>
      <div class="card row">
        <span class="x" id="x">&times;</span>
        <div class="top">
          <svg class="key" viewBox="0 0 24 24" fill="none" stroke="#d9a441" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="4.2"/><path d="M11 11l7 7"/><path d="M15.5 14.5l2 2"/><path d="M18 12l2 2"/></svg>
          <span class="name">Job<span>Vault</span></span>
        </div>
        <div id="body"></div>
      </div>`;
    shadow.appendChild(wrap);
    document.documentElement.appendChild(hostEl);
    shadow.getElementById("x").onclick = () => hostEl.remove();
    return shadow.getElementById("body");
  }
  const el = (tag, cls, html) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  };
  function actionBtn(body, label, cls, onClick) {
    const b = el("button", "act " + cls);
    b.textContent = label;
    b.onclick = onClick;
    body.appendChild(b);
    return b;
  }
  function emailSelect(body, emails, fallback) {
    if (!emails.length && !fallback) return null;
    body.appendChild(el("label", "lbl", "Use this email"));
    const sel = document.createElement("select");
    const list = emails.length ? emails : [fallback];
    list.forEach((e) => {
      const o = document.createElement("option");
      o.value = e;
      o.textContent = e;
      sel.appendChild(o);
    });
    if (fallback && list.includes(fallback)) sel.value = fallback;
    body.appendChild(sel);
    return sel;
  }
  function toast(message) {
    const body = openCard();
    const t = el("div", "sub toast", `<span class="dot"></span><span>${message}</span>`);
    body.appendChild(t);
    setTimeout(() => hostEl && hostEl.remove(), 4200);
  }

  // ---------- capture on submit ----------
  let captured = { email: "", password: "" };
  function watchForSubmit() {
    const grab = () => {
      const u = findUserField();
      const p = passwordFields()[0];
      if (u && u.value) captured.email = u.value;
      if (p && p.value) captured.password = p.value;
    };
    const fire = () => {
      if (captured.password)
        send({ type: "capturePending", host, url: location.href, email: captured.email, password: captured.password, company });
    };
    document.addEventListener("submit", () => { grab(); fire(); }, true);
    document.addEventListener(
      "click",
      (e) => {
        const b = e.target.closest && e.target.closest('button, input[type="submit"], [role="button"]');
        if (!b) return;
        if (/(sign ?in|log ?in|sign ?up|create|register|continue|submit)/i.test(b.innerText || b.value || "")) {
          setTimeout(grab, 0);
          setTimeout(fire, 140);
        }
      },
      true
    );
  }

  // ---------- login / signup flow ----------
  async function runLogin(info) {
    const pw = passwordFields();
    watchForSubmit();
    const signup = looksLikeSignup();

    if (info.locked) {
      const body = openCard();
      body.appendChild(el("div", "sub", `Open <span class="b">JobVault</span> from your toolbar to set up or unlock, then this page fills itself.`));
      actionBtn(body, "Got it", "ghost", () => hostEl.remove());
      return;
    }

    // known account here already
    if (info.found) {
      if (signup) {
        // they already have an account but landed on a create-account screen
        const body = openCard();
        body.appendChild(el("div", "sub", `You already have a login saved for <span class="b">${info.company}</span>. Look for a Sign in link, then fill it.`));
        actionBtn(body, "Fill my email", "ghost", () => { setValue(findUserField(), info.email); hostEl.remove(); });
        return;
      }
      if (info.autofill) {
        setValue(findUserField(), info.email);
        setValue(pw[0], info.password);
        toast(`Filled your <span class="b">${info.company}</span> login.`);
      } else {
        const body = openCard();
        body.appendChild(el("div", "sub", `Saved login found for <span class="b">${info.company}</span>.`));
        actionBtn(body, "Fill this login", "primary", () => {
          setValue(findUserField(), info.email);
          setValue(pw[0], info.password);
          hostEl.remove();
        });
      }
      return;
    }

    // no account here yet
    const body = openCard();
    if (signup) {
      body.appendChild(el("div", "sub", `New account for <span class="b">${company}</span>. Pick an email and JobVault will set a strong password.`));
      const sel = emailSelect(body, info.emails, info.defaultEmail);
      actionBtn(body, "Fill email and strong password", "primary", async () => {
        const gen = await send({ type: "generatePassword", opts: { length: 20 } });
        const email = sel ? sel.value : info.defaultEmail;
        const user = findUserField();
        if (user && email) setValue(user, email);
        if (gen.ok) pw.forEach((f) => setValue(f, gen.password));
        captured.email = email || (user && user.value) || "";
        captured.password = gen.ok ? gen.password : "";
        hostEl.remove();
        toast("Email and password set. Saves when you finish signing up.");
      });
    } else {
      body.appendChild(el("div", "sub", `First time here? JobVault remembers this login for <span class="b">${company}</span> after you sign in.`));
      const sel = emailSelect(body, info.emails, info.defaultEmail);
      if (sel || info.defaultEmail)
        actionBtn(body, "Fill my email", "ghost", () => {
          const email = sel ? sel.value : info.defaultEmail;
          setValue(findUserField(), email);
          hostEl.remove();
        });
    }
  }

  // ---------- resume match on job pages ----------
  const seenMatch = new Set();
  async function runMatch(info) {
    if (!info.matchOnOpen || !info.hasResume) return;
    if (!looksLikeJobPosting()) return;
    if (seenMatch.has(location.href)) return;
    seenMatch.add(location.href);
    const text = extractJobText();
    if (text.length < 400) return;
    const res = await send({ type: "matchJob", text });
    if (!res || !res.ok || !res.result) return;
    showMatch(res.result);
  }

  function showMatch(r) {
    const body = openCard();
    const color = r.score >= 70 ? "#5bbf8a" : r.score >= 45 ? "#d9a441" : "#e8836b";
    const verdict =
      r.score >= 75 ? "Strong fit." : r.score >= 55 ? "Solid fit." : r.score >= 35 ? "Partial fit." : "Light fit.";
    const circ = 2 * Math.PI * 22;
    const head = el("div", "match-head");
    head.innerHTML = `
      <svg class="ring" viewBox="0 0 52 52">
        <circle cx="26" cy="26" r="22" fill="none" stroke="#1d2534" stroke-width="6"/>
        <circle cx="26" cy="26" r="22" fill="none" stroke="${color}" stroke-width="6" stroke-linecap="round"
          stroke-dasharray="${circ}" stroke-dashoffset="${circ - (circ * r.score) / 100}" transform="rotate(-90 26 26)"/>
      </svg>
      <div><div class="score">${r.score}%</div><div class="verdict">${verdict} Resume vs this job.</div></div>`;
    body.appendChild(head);

    if (r.missing.length) {
      body.appendChild(el("div", "h4", "Worth adding if true for you"));
      const chips = el("div", "chips");
      r.missing.slice(0, 8).forEach((t) => chips.appendChild(el("span", "chip miss", t)));
      body.appendChild(chips);
    } else {
      body.appendChild(el("div", "sub", "You cover the main terms in this posting."));
    }
    actionBtn(body, "Dismiss", "ghost", () => hostEl.remove());
  }

  function extractJobText() {
    const cands = [
      document.querySelector('[data-automation-id="jobPostingDescription"]'),
      document.querySelector('[role="main"]'),
      document.querySelector("main"),
      document.querySelector("article"),
    ].filter(Boolean);
    let best = cands[0],
      len = best ? best.innerText.length : 0;
    for (const c of cands) {
      const l = (c.innerText || "").length;
      if (l > len) { best = c; len = l; }
    }
    return ((best ? best.innerText : document.body.innerText) || "").replace(/\s+/g, " ").trim().slice(0, 20000);
  }

  // popup asks for the job text for the Resume tab
  chrome.runtime.onMessage.addListener((msg, s, respond) => {
    if (msg && msg.type === "scrapeJob") respond({ ok: true, text: extractJobText(), title: document.title, host });
    return true;
  });

  // ---------- main ----------
  async function run() {
    const info = await send({ type: "pageInfo", host });
    if (!info || !info.ok) return;
    if (passwordFields().length) {
      runLogin(info);
    } else if (!info.locked) {
      runMatch(info);
    }
  }

  run();
  let last = location.href;
  setInterval(() => {
    if (location.href !== last) {
      last = location.href;
      run();
    }
  }, 1400);
})();
