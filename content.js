/**
 * JobVault page agent.
 *
 * The old version scanned the DOM once at document_idle and then only again when
 * the URL changed. Workday, Greenhouse, Lever and iCIMS all render their forms
 * after that moment, so the fill path was usually reached with zero password
 * fields on the page and nothing ever happened. Everything here is driven by a
 * MutationObserver instead, so a form that appears three seconds late is still
 * found.
 */
(() => {
  "use strict";
  if (window.__jobVault2) return;
  window.__jobVault2 = true;

  const send = (msg) =>
    new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (res) => {
          resolve(chrome.runtime.lastError ? { ok: false, error: chrome.runtime.lastError.message } : res || { ok: false });
        });
      } catch {
        resolve({ ok: false });
      }
    });

  const IS_TOP = window.top === window;
  let ctx = null;               // last pageContext from the worker
  let filledLogin = false;
  let announcedSignup = false;
  const seenMatch = new Set();
  const seenConfirm = new Set();

  // ---------------------------------------------------------------- helpers

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();
  const lower = (s) => clean(s).toLowerCase();

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    if (el.disabled || el.readOnly) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) return false;
    const s = getComputedStyle(el);
    return s.visibility !== "hidden" && s.display !== "none" && s.opacity !== "0";
  }

  /** Small or hidden frames must not draw a card nobody can see. */
  function canRenderUI() {
    if (!document.body) return false;
    if (IS_TOP) return true;
    return window.innerWidth >= 340 && window.innerHeight >= 220;
  }

  // ------------------------------------------------------- label extraction

  const ATTRS = ["name", "id", "placeholder", "aria-label", "title", "autocomplete", "data-automation-id", "data-qa", "data-testid"];

  function attrText(el) {
    return ATTRS.map((a) => el.getAttribute(a) || "").join(" ");
  }

  /**
   * The generic matcher lives or dies on this. Attribute names on real portals
   * are often meaningless (`input_12`, `answers[4][value]`), so the visible
   * label is frequently the only thing that identifies a field.
   */
  function labelText(el) {
    const bits = [];
    const push = (t) => { const c = clean(t); if (c && c.length < 240) bits.push(c); };

    if (el.id) {
      try { document.querySelectorAll(`label[for="${CSS.escape(el.id)}"]`).forEach((l) => push(l.innerText)); } catch { /* odd id */ }
    }
    const wrap = el.closest("label");
    if (wrap) push(wrap.innerText);

    const lb = el.getAttribute("aria-labelledby");
    if (lb) for (const id of lb.split(/\s+/)) { const n = document.getElementById(id); if (n) push(n.innerText); }

    // Walk up looking for the question text that sits above the control.
    let node = el;
    for (let depth = 0; depth < 5 && node; depth++) {
      node = node.parentElement;
      if (!node) break;
      const legend = node.querySelector(":scope > legend, :scope > label, :scope > .label, :scope > h1, :scope > h2, :scope > h3, :scope > h4, :scope > h5, :scope > [role='heading']");
      if (legend && !legend.contains(el)) push(legend.innerText);
      let sib = node.previousElementSibling;
      let hops = 0;
      while (sib && hops++ < 3) {
        if (!sib.querySelector("input, select, textarea") && sib.innerText) { push(sib.innerText); break; }
        sib = sib.previousElementSibling;
      }
      if (bits.join(" ").length > 60) break;
    }
    return clean(bits.join(" \u00b7 ")).slice(0, 300);
  }

  const haystack = (el) => lower(attrText(el) + " \u00b7 " + labelText(el));

  // --------------------------------------------------------------- matching

  const AUTOCOMPLETE = {
    "given-name": "firstName", "additional-name": "middleName", "family-name": "lastName",
    nickname: "preferredName", name: "fullName", email: "email", tel: "phone",
    "tel-national": "phone", "tel-local": "phone", "tel-country-code": "phoneCountryCode",
    "street-address": "addressLine1", "address-line1": "addressLine1", "address-line2": "addressLine2",
    "address-level2": "city", "address-level1": "state", "postal-code": "postalCode",
    country: "country", "country-name": "country", organization: "currentCompany",
    "organization-title": "currentTitle", url: "website",
  };

  // key, regex, negative regex, weight
  const RULES = [
    ["firstName", /first[\s_-]*name|given[\s_-]*name|\bfname\b|forename|legalname.*first/, /last|family|sur|company|school/, 9],
    ["lastName", /last[\s_-]*name|sur[\s_-]*name|family[\s_-]*name|\blname\b|legalname.*last/, /first|given|company|school/, 9],
    ["middleName", /middle[\s_-]*(name|initial)/, null, 9],
    ["preferredName", /preferred[\s_-]*(first[\s_-]*)?name|nick[\s_-]*name|goes by/, null, 8],
    ["pronouns", /pronoun/, null, 9],
    ["email", /e[\s_-]?mail/, /confirm|verify|re-?enter/, 8],
    ["phoneCountryCode", /country[\s_-]*(phone[\s_-]*)?code|dial[\s_-]*code|phone[\s_-]*country/, null, 10],
    ["phoneType", /phone[\s_-]*(device[\s_-]*)?type|device[\s_-]*type/, null, 10],
    ["phone", /phone|mobile|\bcell\b|telephone/, /country|code|extension|\bext\b|type/, 8],
    ["addressLine2", /address[\s_-]*(line[\s_-]*)?2|\baddr2\b|apartment|\bapt\b|\bunit\b|\bsuite\b|floor/, null, 9],
    ["addressLine1", /address[\s_-]*(line[\s_-]*)?1|street|\baddr1\b|^address$|\baddress\b/, /2|e[\s_-]?mail|\bip\b|city|country|postal|\bzip\b|state|province/, 7],
    ["city", /\bcity\b|\btown\b|municipal|locality/, /country/, 9],
    ["state", /\bstate\b|province|\bregion\b|county/, /statement|united states|country/, 8],
    ["postalCode", /postal|\bzip\b|post[\s_-]?code/, null, 9],
    ["country", /country|nation(ality)?/, /code|phone|region/, 8],
    ["linkedin", /linked[\s_-]?in/, null, 10],
    ["github", /git[\s_-]?hub/, null, 10],
    ["portfolio", /portfolio|dribbble|behance/, null, 9],
    ["website", /web[\s_-]?site|personal[\s_-]*(site|url|page)|homepage|\burl\b/, /linked|git|portfolio|job|posting/, 6],
    ["currentCompany", /current[\s_-]*(employer|company)|employer|company[\s_-]*name|organi[sz]ation|^org$/, /school|university|college|previous/, 7],
    ["currentTitle", /current[\s_-]*(job[\s_-]*)?(title|position|role)|job[\s_-]*title|^title$|occupation|headline/, /school|degree|field|posting|page/, 7],
    ["yearsExperience", /years?[\s_-]*(of[\s_-]*)?experience|\byrs?[\s_-]*exp|total[\s_-]*experience|experience[\s_-]*years?/, null, 9],
    ["desiredSalary", /(desired|expected|target|requested)[\s_-]*(salary|compensation|pay|rate)|salary[\s_-]*(expectation|requirement|range)|comp[\s_-]*expect/, null, 9],
    ["earliestStartDate", /start[\s_-]*date|available[\s_-]*(from|date|start)|earliest[\s_-]*(start|available)|when.*(can|could) you start/, null, 8],
    ["noticePeriod", /notice[\s_-]*period|current[\s_-]*notice/, null, 9],
    ["workAuthorized", /(legally[\s_-]*)?authori[sz]ed[\s_-]*to[\s_-]*work|work[\s_-]*authori[sz]ation|eligible[\s_-]*to[\s_-]*work|right[\s_-]*to[\s_-]*work|legally[\s_-]*(able|permitted)/, null, 10],
    ["needsSponsorship", /sponsorship|require.*(visa|sponsor)|need.*(visa|sponsor)|visa[\s_-]*support|immigration[\s_-]*support/, null, 10],
    ["willingToRelocate", /relocat/, null, 10],
    ["remotePreference", /work[\s_-]*(arrangement|preference|location[\s_-]*preference)|remote[\s_-]*(or|vs|preference)|hybrid[\s_-]*preference/, null, 8],
    ["over18", /\b18\b.*(older|age)|at least 18|age.*18/, null, 9],
    ["hasDriversLicense", /driver'?s?[\s_-]*licen[cs]e/, null, 10],
    ["previouslyEmployed", /previously[\s_-]*(worked|employed)|former[\s_-]*employee|prior[\s_-]*employment|ever[\s_-]*(worked|been employed)|previous[\s_-]*worker/, null, 10],
    ["referredBy", /referred[\s_-]*by|referral[\s_-]*name|employee[\s_-]*referral|referrer/, null, 10],
    ["source", /how[\s_-]*did[\s_-]*you[\s_-]*(hear|find|learn)|where[\s_-]*did[\s_-]*you[\s_-]*(hear|find)|referral[\s_-]*source|^source$|how[\s_-]*you[\s_-]*heard/, null, 9],
    ["gender", /gender/, /identity statement|pronoun/, 9],
    ["hispanicLatino", /hispanic|latino|latinx/, null, 10],
    ["ethnicity", /ethnicity|\brace\b|racial|ethnic[\s_-]*(group|background)/, null, 9],
    ["veteranStatus", /veteran|military[\s_-]*service|armed[\s_-]*forces/, null, 10],
    ["disabilityStatus", /disabilit|disabled/, null, 10],
  ];

  const SKIP = /search|filter|\bquery\b|coupon|promo|captcha|\botp\b|verification[\s_-]*code|one[\s_-]*time|two[\s_-]*factor|\b2fa\b|csrf|newsletter|subscribe|comment[\s_-]*body/;

  // Selector packs. These do not replace the generic matcher, they just win when
  // they hit, because a portal's own automation ids are never ambiguous.
  const PACKS = [
    {
      test: /myworkdayjobs\.com|myworkdaysite\.com|\.wd\d+\./,
      name: "Workday",
      map: {
        '[data-automation-id="email"]': "email",
        '[data-automation-id="password"]': "password",
        '[data-automation-id="verifyPassword"]': "confirmPassword",
        '[data-automation-id="legalNameSection_firstName"]': "firstName",
        '[data-automation-id="legalNameSection_middleName"]': "middleName",
        '[data-automation-id="legalNameSection_lastName"]': "lastName",
        '[data-automation-id="preferredNameSection_firstName"]': "preferredName",
        '[data-automation-id="addressSection_addressLine1"]': "addressLine1",
        '[data-automation-id="addressSection_addressLine2"]': "addressLine2",
        '[data-automation-id="addressSection_city"]': "city",
        '[data-automation-id="addressSection_postalCode"]': "postalCode",
        '[data-automation-id="addressSection_countryRegion"]': "state",
        '[data-automation-id="addressSection_countryRegion-input"]': "state",
        '[data-automation-id="country"]': "country",
        '[data-automation-id="phone-number"]': "phone",
        '[data-automation-id="phoneNumber"]': "phone",
        '[data-automation-id="country-phone-code"]': "phoneCountryCode",
        '[data-automation-id="phone-device-type"]': "phoneType",
        '[data-automation-id="source"]': "source",
        '[data-automation-id="sourceSection_source"]': "source",
        '[data-automation-id="linkedinQuestion"]': "linkedin",
        '[data-automation-id="gender"]': "gender",
        '[data-automation-id="hispanicOrLatino"]': "hispanicLatino",
        '[data-automation-id="ethnicity"]': "ethnicity",
        '[data-automation-id="veteranStatus"]': "veteranStatus",
        '[data-automation-id="disability"]': "disabilityStatus",
      },
    },
    {
      test: /greenhouse\.io|job-boards\.greenhouse/,
      name: "Greenhouse",
      map: {
        "#first_name": "firstName", "#last_name": "lastName", "#email": "email", "#phone": "phone",
        '[name="job_application[first_name]"]': "firstName",
        '[name="job_application[last_name]"]': "lastName",
        '[name="job_application[email]"]': "email",
        '[name="job_application[phone]"]': "phone",
        "#job_application_location": "city",
      },
    },
    {
      test: /lever\.co/,
      name: "Lever",
      map: {
        '[name="name"]': "fullName", '[name="email"]': "email", '[name="phone"]': "phone",
        '[name="org"]': "currentCompany", '[name="location"]': "city",
        '[name="urls[LinkedIn]"]': "linkedin", '[name="urls[GitHub]"]': "github",
        '[name="urls[Portfolio]"]': "portfolio", '[name="urls[Other]"]': "website",
      },
    },
    {
      test: /ashbyhq\.com/,
      name: "Ashby",
      map: {
        '[name="_systemfield_name"]': "fullName", '[name="_systemfield_email"]': "email",
        '[name="_systemfield_phone"]': "phone", '[name="_systemfield_location"]': "city",
      },
    },
    {
      test: /smartrecruiters\.com/,
      name: "SmartRecruiters",
      map: {
        "#firstName": "firstName", "#lastName": "lastName", "#email": "email",
        "#phoneNumber": "phone", "#location-input": "city", "#linkedinProfileUrl": "linkedin",
      },
    },
    {
      test: /workable\.com/,
      name: "Workable",
      map: {
        '[name="candidate[firstname]"]': "firstName", '[name="candidate[lastname]"]': "lastName",
        '[name="candidate[email]"]': "email", '[name="candidate[phone]"]': "phone",
        '[name="candidate[address]"]': "addressLine1", '[name="candidate[headline]"]': "currentTitle",
      },
    },
    {
      test: /icims\.com/,
      name: "iCIMS",
      map: {
        '[name="firstname"]': "firstName", '[name="lastname"]': "lastName", '[name="email"]': "email",
        '[name="phone"]': "phone", '[name="addressStreet"]': "addressLine1",
        '[name="addressCity"]': "city", '[name="addressZip"]': "postalCode",
      },
    },
    {
      test: /taleo\.net|successfactors\.com|sap\.com/,
      name: "Taleo / SuccessFactors",
      map: {
        '[id*="firstName"]': "firstName", '[id*="lastName"]': "lastName",
        '[id*="emailAddress"]': "email", '[id*="cellPhone"]': "phone", '[id*="zipCode"]': "postalCode",
      },
    },
    {
      test: /bamboohr\.com/,
      name: "BambooHR",
      map: {
        "#firstName": "firstName", "#lastName": "lastName", "#email": "email", "#phone": "phone",
        "#address": "addressLine1", "#city": "city", "#state": "state", "#zip": "postalCode",
      },
    },
    { test: /jobvite\.com/, name: "Jobvite", map: {} },
    { test: /teamtailor\.com/, name: "Teamtailor", map: {} },
    { test: /breezy\.hr/, name: "Breezy", map: {} },
    { test: /recruitee\.com/, name: "Recruitee", map: {} },
    { test: /paylocity\.com|paycomonline\.net|ultipro\.com|dayforcehcm\.com/, name: "Payroll ATS", map: {} },
  ];

  const PACK = PACKS.find((p) => p.test.test(location.hostname + location.pathname)) || null;
  const ATS = PACK ? PACK.name : "";

  function packKey(el) {
    if (!PACK) return null;
    for (const [sel, key] of Object.entries(PACK.map)) {
      try { if (el.matches(sel)) return key; } catch { /* bad selector */ }
    }
    return null;
  }

  /** Best field key for one control, with the confidence behind it. */
  function classify(el, opts = {}) {
    const tag = el.tagName;
    if (tag === "INPUT") {
      const t = (el.type || "text").toLowerCase();
      if (["hidden", "submit", "button", "image", "reset", "file", "range", "color"].includes(t)) return null;
      if (t === "password") {
        const hay = haystack(el);
        const isConfirm = /confirm|verify|re-?enter|re-?type|again/.test(hay);
        return { key: isConfirm ? "confirmPassword" : "password", score: 100 };
      }
      if (t === "email") return { key: opts.authContext ? "username" : "email", score: 40 };
      if (t === "tel") return { key: "phone", score: 30 };
    } else if (tag !== "SELECT" && tag !== "TEXTAREA") return null;

    const fromPack = packKey(el);
    if (fromPack) {
      const key = fromPack === "email" && opts.authContext ? "username" : fromPack;
      return { key, score: 90 };
    }

    const ac = lower(el.getAttribute("autocomplete") || "").split(/\s+/).pop();
    if (AUTOCOMPLETE[ac]) return { key: AUTOCOMPLETE[ac], score: 60 };
    if (ac === "username" || ac === "current-password") {
      return { key: ac === "username" ? "username" : "password", score: 70 };
    }

    const hay = haystack(el);
    if (!hay) return null;
    if (SKIP.test(hay)) return null;
    if (el.closest('[role="search"], form[role="search"], nav')) return null;

    let best = null;
    for (const [key, re, neg, weight] of RULES) {
      if (!re.test(hay)) continue;
      if (neg && neg.test(hay)) continue;
      const attrs = lower(attrText(el));
      // A hit on the control's own attributes is worth more than a hit on
      // surrounding page text, which can bleed in from a neighbouring question.
      const score = weight * 2 + (re.test(attrs) ? 12 : 0);
      if (!best || score > best.score) best = { key, score };
    }
    return best;
  }

  /**
   * One control per field key, best score wins. Without this, "Email" and
   * "Confirm email" both grab `email` and the confirm box gets the wrong thing.
   */
  function collectFields(opts = {}) {
    const controls = Array.from(document.querySelectorAll("input, select, textarea")).filter(isVisible);
    const byKey = new Map();
    for (const el of controls) {
      const hit = classify(el, opts);
      if (!hit) continue;
      const prev = byKey.get(hit.key);
      if (!prev || hit.score > prev.score) byKey.set(hit.key, { el, ...hit });
    }
    return byKey;
  }

  function passwordFields() {
    return Array.from(document.querySelectorAll('input[type="password"]')).filter(isVisible);
  }

  // ----------------------------------------------------------- value setting

  /**
   * React, Vue and Angular all track the last value they wrote. Assigning
   * `el.value` goes through the framework's own property descriptor, so the
   * framework concludes nothing changed and drops the update. Calling the
   * prototype setter bypasses that descriptor, which leaves the framework's
   * cached value stale and makes the following input event register as real.
   */
  function nativeSet(el, value) {
    const proto =
      el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
      : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype
      : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (setter) setter.call(el, value);
    else el.value = value;
  }

  function fire(el, type, init = {}) {
    const Ctor = type === "input" || type === "beforeinput" ? InputEvent : type.startsWith("key") ? KeyboardEvent : Event;
    el.dispatchEvent(new Ctor(type, { bubbles: true, composed: true, cancelable: true, ...init }));
  }

  function setText(el, value) {
    if (el.value === value) return true;
    try { el.focus({ preventScroll: true }); } catch { /* fine */ }
    fire(el, "focus");
    // Blank first so a repeat fill still reads as a change to the framework.
    if (el.value) { nativeSet(el, ""); fire(el, "input", { inputType: "deleteContentBackward" }); }
    nativeSet(el, value);
    fire(el, "keydown", { key: "a" });
    fire(el, "beforeinput", { inputType: "insertText", data: value });
    fire(el, "input", { inputType: "insertText", data: value });
    fire(el, "keyup", { key: "a" });
    fire(el, "change");
    fire(el, "blur");
    try { el.blur(); } catch { /* fine */ }
    return el.value === value || el.value.length > 0;
  }

  const YES = /^(yes|y|true|1)$/i;

  function optionScore(text, want) {
    const a = lower(text), b = lower(want);
    if (!a) return 0;
    if (a === b) return 100;
    if (YES.test(b) && /^yes\b/.test(a)) return 95;
    if (/^(no|n|false|0)$/i.test(b) && /^no\b/.test(a)) return 95;
    if (a.startsWith(b) || b.startsWith(a)) return 70;
    if (a.includes(b) || b.includes(a)) return 50;
    // "I don't wish to answer" vs "Decline to self identify"
    if (/decline|wish not|not wish|prefer not|do not wish/.test(a) && /decline|wish|prefer not/.test(b)) return 80;
    return 0;
  }

  function setSelect(el, want) {
    let best = null;
    for (const o of el.options) {
      const s = Math.max(optionScore(o.text, want), optionScore(o.value, want));
      if (s > 0 && (!best || s > best.s)) best = { o, s };
    }
    if (!best || best.s < 50) return false;
    nativeSet(el, best.o.value);
    el.selectedIndex = best.o.index;
    fire(el, "input");
    fire(el, "change");
    return true;
  }

  function setRadioOrCheck(container, want) {
    const inputs = Array.from(container.querySelectorAll('input[type="radio"], input[type="checkbox"]')).filter(isVisible);
    if (!inputs.length) return false;
    let best = null;
    for (const el of inputs) {
      const text = labelText(el) || el.value || "";
      const s = Math.max(optionScore(text, want), optionScore(el.value, want));
      if (s > 0 && (!best || s > best.s)) best = { el, s };
    }
    if (!best || best.s < 50) return false;
    if (!best.el.checked) { best.el.click(); }
    return true;
  }

  /** Workday-style custom dropdowns: a button that opens a listbox of options. */
  async function pickFromListbox(trigger, want) {
    try { trigger.click(); } catch { return false; }
    const start = Date.now();
    let options = [];
    while (Date.now() - start < 1400) {
      options = Array.from(
        document.querySelectorAll('[role="option"], [data-automation-id="promptOption"], li[data-value], .css-option')
      ).filter(isVisible);
      if (options.length) break;
      await sleep(90);
    }
    if (!options.length) return false;
    let best = null;
    for (const o of options) {
      const s = optionScore(o.innerText || o.getAttribute("data-value") || "", want);
      if (s > 0 && (!best || s > best.s)) best = { o, s };
    }
    if (!best || best.s < 50) {
      try { document.body.click(); } catch { /* ignore */ }
      return false;
    }
    best.o.click();
    await sleep(120);
    return true;
  }

  /** Fill one control, choosing the right technique for the control type. */
  async function applyValue(el, value) {
    if (!value) return false;
    if (el.tagName === "SELECT") return setSelect(el, value);
    if (el.type === "radio" || el.type === "checkbox") {
      const group = el.closest("fieldset, [role='radiogroup'], [role='group'], div") || document.body;
      return setRadioOrCheck(group, value);
    }
    const combo =
      el.getAttribute("role") === "combobox" ||
      el.getAttribute("aria-haspopup") === "listbox" ||
      el.getAttribute("aria-autocomplete") === "list";
    if (combo) {
      if (setText(el, value)) {
        await sleep(320);
        const opts = Array.from(document.querySelectorAll('[role="option"]')).filter(isVisible);
        if (opts.length) {
          let best = null;
          for (const o of opts) {
            const s = optionScore(o.innerText, value);
            if (s > 0 && (!best || s > best.s)) best = { o, s };
          }
          (best?.o || opts[0]).click();
        }
        return true;
      }
      return false;
    }
    return setText(el, value);
  }

  // -------------------------------------------------------------- page cards

  const CARD_CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
    .card { width: 306px; background: #12181f; color: #e8edf3; border: 1px solid #2c3743;
      border-radius: 14px; box-shadow: 0 18px 44px rgba(0,0,0,.55), 0 0 0 1px rgba(217,164,65,.08);
      padding: 13px 14px 14px; position: relative; animation: rise .16s ease-out; }
    @media (prefers-reduced-motion: reduce) { .card { animation: none } }
    @keyframes rise { from { opacity: 0; transform: translateY(7px) } to { opacity: 1; transform: none } }
    .top { display: flex; align-items: center; gap: 7px; margin-bottom: 9px; padding-right: 16px; }
    .mark { width: 17px; height: 17px; flex: 0 0 auto; }
    .name { font-size: 12px; font-weight: 700; letter-spacing: .3px; }
    .name i { color: #d9a441; font-style: normal; }
    .ats { margin-left: auto; font-size: 9.5px; text-transform: uppercase; letter-spacing: .6px;
      color: #6a7889; border: 1px solid #2c3743; border-radius: 5px; padding: 2px 5px; }
    .x { position: absolute; top: 9px; right: 10px; cursor: pointer; color: #6a7889; font-size: 17px; line-height: 1;
      background: none; border: 0; padding: 2px 4px; }
    .x:hover { color: #e8edf3 }
    .msg { font-size: 12.5px; color: #93a1b0; line-height: 1.5; margin: 0 0 10px }
    .msg b { color: #e8edf3; font-weight: 600 }
    /* the signature: read the tenant, not the domain */
    .tenant { font-family: ui-monospace, "SF Mono", "Cascadia Mono", Menlo, Consolas, monospace;
      font-size: 11.5px; letter-spacing: .02em; background: #0d1117; border: 1px solid #232d38;
      border-radius: 7px; padding: 6px 8px; margin: 0 0 10px; word-break: break-all; color: #6a7889 }
    .tenant b { color: #d9a441; font-weight: 700 }
    label.lbl { display: block; font-size: 9.5px; color: #6a7889; margin: 0 0 4px;
      letter-spacing: .6px; text-transform: uppercase; font-weight: 600 }
    select { width: 100%; background: #0d1117; color: #e8edf3; border: 1px solid #2c3743;
      border-radius: 8px; padding: 7px 8px; font-size: 12.5px; margin-bottom: 9px }
    select:focus-visible { outline: 2px solid #d9a441; outline-offset: 1px }
    button.act { display: block; width: 100%; text-align: center; font-size: 12.5px; font-weight: 600;
      border-radius: 9px; padding: 9px 10px; margin-top: 6px; cursor: pointer; border: 1px solid transparent;
      font-family: inherit; transition: background .14s }
    button.act:focus-visible { outline: 2px solid #d9a441; outline-offset: 2px }
    .primary { background: #d9a441; color: #171003; }
    .primary:hover { background: #e8b657 }
    .ghost { background: #1a212b; color: #c6d1dc; border-color: #2c3743 }
    .ghost:hover { background: #222b37 }
    .receipt { list-style: none; margin: 2px 0 0; padding: 0; font-size: 11.5px;
      font-family: ui-monospace, "SF Mono", "Cascadia Mono", Menlo, Consolas, monospace }
    .receipt li { display: flex; gap: 7px; padding: 2.5px 0; color: #93a1b0 }
    .receipt li s { color: #5cbf8a; text-decoration: none; flex: 0 0 11px }
    .receipt li.no s { color: #cf7259 }
    .receipt li.no { color: #cf7259 }
    .row { display: flex; gap: 6px } .row button.act { margin-top: 0 }
    .ring { width: 46px; height: 46px; flex: 0 0 auto }
    .head { display: flex; align-items: center; gap: 11px; margin-bottom: 9px }
    .score { font-size: 19px; font-weight: 700; letter-spacing: -.4px }
    .chips { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 3px }
    .chip { font-size: 10.5px; padding: 3px 7px; border-radius: 20px; font-weight: 600 }
    .chip.miss { background: rgba(207,114,89,.13); color: #cf7259; border: 1px solid rgba(207,114,89,.3) }
    .h4 { font-size: 9.5px; color: #6a7889; margin: 9px 0 4px; letter-spacing: .6px; text-transform: uppercase; font-weight: 600 }
  `;

  let cardHost = null;
  let cardTimer = null;

  function closeCard() {
    clearTimeout(cardTimer);
    if (cardHost) { cardHost.remove(); cardHost = null; }
  }

  function openCard() {
    if (!canRenderUI()) return null;
    closeCard();
    cardHost = document.createElement("div");
    cardHost.style.cssText =
      "all:initial;position:fixed;right:16px;bottom:16px;z-index:2147483647;";
    const shadow = cardHost.attachShadow({ mode: "closed" });
    const wrap = document.createElement("div");
    wrap.innerHTML = `<style>${CARD_CSS}</style>
      <div class="card" role="dialog" aria-label="JobVault">
        <button class="x" id="x" aria-label="Dismiss">&times;</button>
        <div class="top">
          <svg class="mark" viewBox="0 0 24 24" fill="none" stroke="#d9a441" stroke-width="1.9"
               stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <circle cx="8.5" cy="8.5" r="4"/><path d="M11.4 11.4 18 18"/><path d="M15.6 14.6l1.9 1.9"/><path d="M18.2 12.2l1.9 1.9"/>
          </svg>
          <span class="name">Job<i>Vault</i></span>
          ${ATS ? `<span class="ats">${ATS}</span>` : ""}
        </div>
        <div id="body"></div>
      </div>`;
    shadow.appendChild(wrap);
    (document.body || document.documentElement).appendChild(cardHost);
    shadow.getElementById("x").onclick = closeCard;
    return shadow.getElementById("body");
  }

  const el = (tag, cls, html) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  };

  function button(parent, label, cls, onClick) {
    const b = el("button", "act " + cls);
    b.type = "button";
    b.textContent = label;
    b.onclick = onClick;
    parent.appendChild(b);
    return b;
  }

  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  /** Renders the hostname with the tenant segment picked out in brass. */
  function tenantStrip(parent, host, tenant) {
    if (!host) return;
    const t = tenant?.tenant;
    const html = t && host.startsWith(t) ? `<b>${esc(t)}</b>${esc(host.slice(t.length))}` : esc(host);
    parent.appendChild(el("div", "tenant", html));
  }

  function toast(html, ms = 4200) {
    const body = openCard();
    if (!body) return;
    body.appendChild(el("div", "msg", html));
    cardTimer = setTimeout(closeCard, ms);
  }

  /** Shows exactly which fields were written. The old version filled silently. */
  function receipt(title, results, extra) {
    const body = openCard();
    if (!body) return;
    const okCount = results.filter((r) => r.ok).length;
    body.appendChild(el("div", "msg", `<b>${esc(title)}</b> \u2014 ${okCount} of ${results.length} field${results.length === 1 ? "" : "s"} filled.`));
    const list = el("ul", "receipt");
    for (const r of results.slice(0, 14)) {
      const li = el("li", r.ok ? "" : "no", `<s>${r.ok ? "\u2713" : "\u00d7"}</s><span>${esc(r.label)}</span>`);
      list.appendChild(li);
    }
    body.appendChild(list);
    if (results.length > 14) body.appendChild(el("div", "h4", `+ ${results.length - 14} more`));
    if (extra) body.appendChild(el("div", "msg", extra));
    button(body, "Done", "ghost", closeCard);
    cardTimer = setTimeout(closeCard, 11000);
  }

  // ------------------------------------------------------------ field badge

  let badgeHost = null;
  function hideBadge() { if (badgeHost) { badgeHost.remove(); badgeHost = null; } }

  function showBadge(target, onClick) {
    hideBadge();
    if (!canRenderUI()) return;
    const r = target.getBoundingClientRect();
    if (r.width < 60) return;
    badgeHost = document.createElement("div");
    badgeHost.style.cssText = `all:initial;position:fixed;z-index:2147483646;top:${Math.round(r.top + r.height / 2 - 11)}px;left:${Math.round(r.right - 26)}px;`;
    const shadow = badgeHost.attachShadow({ mode: "closed" });
    shadow.innerHTML = `<style>
      button { all: unset; cursor: pointer; width: 22px; height: 22px; border-radius: 6px;
        background: #12181f; border: 1px solid #d9a441; display: grid; place-items: center;
        box-shadow: 0 2px 8px rgba(0,0,0,.35) }
      button:hover { background: #1a212b }
      svg { width: 13px; height: 13px }
    </style>
    <button title="Fill with JobVault" aria-label="Fill with JobVault">
      <svg viewBox="0 0 24 24" fill="none" stroke="#d9a441" stroke-width="2.2" stroke-linecap="round">
        <circle cx="8.5" cy="8.5" r="4"/><path d="M11.4 11.4 18 18"/><path d="M15.6 14.6l1.9 1.9"/>
      </svg>
    </button>`;
    shadow.querySelector("button").onclick = (e) => { e.preventDefault(); e.stopPropagation(); hideBadge(); onClick(); };
    (document.body || document.documentElement).appendChild(badgeHost);
    setTimeout(() => { if (badgeHost && document.activeElement !== target) hideBadge(); }, 9000);
  }

  document.addEventListener("focusin", (e) => {
    const t = e.target;
    if (!(t instanceof HTMLElement) || !ctx || ctx.locked) return;
    if (!ctx.settings?.showFieldBadge) return;
    if (!(t instanceof HTMLInputElement)) return hideBadge();
    const hit = classify(t, { authContext: isAuthPage() });
    if (!hit) return hideBadge();
    if (["username", "password", "email"].includes(hit.key) && ctx.matches?.length) {
      showBadge(t, () => doFillLogin({ explicit: true }));
    } else if (hit.key !== "password" && ctx.hasProfile) {
      showBadge(t, () => doFillApplication({ explicit: true }));
    } else hideBadge();
  }, true);

  document.addEventListener("focusout", () => setTimeout(() => {
    if (badgeHost && !(document.activeElement instanceof HTMLInputElement)) hideBadge();
  }, 220), true);
  window.addEventListener("scroll", hideBadge, { passive: true });

  // --------------------------------------------------------- page shape

  function isAuthPage() {
    return passwordFields().length > 0;
  }

  function isSignupPage() {
    if (passwordFields().length >= 2) return true;
    if (document.querySelector('[data-automation-id="createAccountSubmitButton"], [data-automation-id="createAccountCheckbox"]')) return true;
    const hay = lower((document.body?.innerText || "").slice(0, 4000));
    if (/already have an account/.test(hay) && /create (an )?account|sign ?up|register/.test(hay)) return true;
    return /create (an )?account|sign ?up|register now|get started|new user/.test(hay) && !/^.{0,40}sign in/.test(hay);
  }

  let appCount = { at: 0, n: 0, inputs: -1 };
  function applicationFieldCount() {
    const inputs = document.querySelectorAll("input, select, textarea").length;
    if (inputs < 4) return 0;
    if (inputs === appCount.inputs && Date.now() - appCount.at < 3000) return appCount.n;
    const fields = collectFields({ authContext: false });
    let n = 0;
    for (const key of fields.keys()) if (!["password", "confirmPassword", "username"].includes(key)) n++;
    appCount = { at: Date.now(), n, inputs };
    return n;
  }

  /**
   * Reading body.innerText forces a full layout, so cache the answer per URL.
   * The mutation observer can fire dozens of times a second on a busy SPA and
   * this used to be re-computed on every one of them.
   */
  const postingCache = new Map();
  function looksLikeJobPosting() {
    const key = location.href;
    const hit = postingCache.get(key);
    if (hit && Date.now() - hit.at < 4000) return hit.value;
    let value = false;
    if (document.querySelector('[data-automation-id="jobPostingDescription"], .posting-headline, #content .app-title, [class*="job-description"]')) {
      value = true;
    } else if (jsonLdPosting()) {
      value = true;
    } else {
      const t = lower(document.body?.innerText || "");
      const cues = ["responsibilities", "qualifications", "requirements", "about the role", "job description", "what you'll do", "you will", "who you are", "minimum qualifications"];
      value = t.length > 700 && cues.filter((k) => t.includes(k)).length >= 2;
    }
    postingCache.set(key, { at: Date.now(), value });
    if (postingCache.size > 40) postingCache.clear();
    return value;
  }

  // -------------------------------------------------- job posting extraction

  /**
   * Schema.org JobPosting is the highest quality source available and most large
   * boards emit it, so try it before scraping headings.
   */
  function jsonLdPosting() {
    for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
      let data;
      try { data = JSON.parse(s.textContent); } catch { continue; }
      const queue = Array.isArray(data) ? [...data] : [data];
      while (queue.length) {
        const node = queue.shift();
        if (!node || typeof node !== "object") continue;
        if (Array.isArray(node["@graph"])) queue.push(...node["@graph"]);
        const type = node["@type"];
        const types = Array.isArray(type) ? type : [type];
        if (types.includes("JobPosting")) return node;
        for (const v of Object.values(node)) if (v && typeof v === "object") queue.push(v);
      }
    }
    return null;
  }

  function metaContent(...names) {
    for (const n of names) {
      const m = document.querySelector(`meta[property="${n}"], meta[name="${n}"]`);
      if (m?.content) return clean(m.content);
    }
    return "";
  }

  function pickText(...selectors) {
    for (const sel of selectors) {
      const n = document.querySelector(sel);
      if (n?.innerText && clean(n.innerText).length > 1) return clean(n.innerText).slice(0, 180);
    }
    return "";
  }

  function extractJobText() {
    const ld = jsonLdPosting();
    if (ld?.description) {
      const div = document.createElement("div");
      div.innerHTML = ld.description;
      const t = clean(div.innerText);
      if (t.length > 300) return t.slice(0, 24000);
    }
    const cands = [
      '[data-automation-id="jobPostingDescription"]',
      ".posting-page, .section-wrapper.page-full-width",
      "#content, .job__description, [class*='job-description'], [class*='jobDescription']",
      "[role='main']", "main", "article",
    ].map((s) => document.querySelector(s)).filter(Boolean);
    let best = null;
    for (const c of cands) {
      const len = (c.innerText || "").length;
      if (!best || len > best.len) best = { node: c, len };
    }
    return clean((best?.node || document.body)?.innerText || "").slice(0, 24000);
  }

  function currentJob() {
    const ld = jsonLdPosting() || {};
    const addr = ld.jobLocation?.address || ld.jobLocation?.[0]?.address || {};
    const ldLoc = clean([addr.addressLocality, addr.addressRegion, addr.addressCountry].filter(Boolean).join(", "));
    const pay = ld.baseSalary?.value;
    const title =
      clean(ld.title) ||
      pickText('[data-automation-id="jobPostingHeader"]', ".posting-headline h2", "h1.app-title", ".job__title h1", "h1[class*='title']", "h1") ||
      clean(metaContent("og:title") || document.title).replace(/\s*[|\-\u2013]\s*(careers?|jobs?|apply).*$/i, "");
    const company =
      clean(ld.hiringOrganization?.name) ||
      pickText("[class*='company-name']", "[data-company-name]", ".posting-categories .sort-by-time") ||
      "";
    const place =
      ldLoc ||
      pickText('[data-automation-id="locations"]', ".posting-categories .location", ".location", "[class*='location']");
    return {
      url: window.location.href,
      title: title || document.title,
      company,
      location: place && place.length < 90 ? place : "",
      ats: ATS,
      salary: pay
        ? clean(`${pay.minValue || ""}${pay.minValue && pay.maxValue ? "\u2013" : ""}${pay.maxValue || pay.value || ""} ${pay.unitText || ""}`)
        : "",
      deadline: ld.validThrough ? Date.parse(ld.validThrough) || 0 : 0,
      jdText: extractJobText(),
    };
  }

  // ------------------------------------------------------------ login flow

  let captured = { email: "", password: "", isNew: false };

  function watchSubmit() {
    if (watchSubmit.done) return;
    watchSubmit.done = true;
    const grab = () => {
      const fields = collectFields({ authContext: true });
      const u = fields.get("username") || fields.get("email");
      const p = fields.get("password");
      if (u?.el?.value) captured.email = u.el.value;
      if (p?.el?.value) captured.password = p.el.value;
      captured.isNew = isSignupPage();
    };
    const report = () => {
      if (!captured.password) return;
      send({
        type: "captureLogin",
        host: location.hostname,
        url: location.href,
        email: captured.email,
        password: captured.password,
        company: ctx?.company || location.hostname,
        isNew: captured.isNew,
      });
    };
    document.addEventListener("submit", () => { grab(); report(); }, true);
    document.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && e.target instanceof HTMLInputElement) { grab(); setTimeout(report, 120); }
    }, true);
    document.addEventListener("click", (e) => {
      const b = e.target?.closest?.('button, input[type="submit"], [role="button"], a[href="#"]');
      if (!b) return;
      const label = lower(b.innerText || b.value || b.getAttribute("aria-label") || "");
      if (/sign ?in|log ?in|sign ?up|create|register|continue|submit|next/.test(label)) {
        setTimeout(grab, 0);
        setTimeout(report, 220);
      }
    }, true);
  }

  async function doFillLogin({ explicit = false, id = null } = {}) {
    if (!ctx || ctx.locked) {
      if (explicit) toast("JobVault is locked. Open it from the toolbar, then try again.");
      return;
    }
    const fields = collectFields({ authContext: true });
    const userEl = (fields.get("username") || fields.get("email"))?.el;
    const passEl = fields.get("password")?.el;
    if (!passEl && !userEl) {
      if (explicit) toast("No login fields found on this page.");
      return;
    }
    if (!ctx.matches?.length) {
      if (explicit) offerNewAccount(fields);
      return;
    }
    const res = await send({ type: "fillLogin", url: location.href, id });
    if (!res.ok) return explicit && toast(esc(res.error || "Could not fill."));

    const out = [];
    if (userEl) out.push({ label: "email", ok: setText(userEl, res.credential.email) });
    if (passEl) out.push({ label: "password", ok: setText(passEl, res.credential.password) });
    filledLogin = true;
    watchSubmit();
    captured = { email: res.credential.email, password: res.credential.password, isNew: false };

    const body = openCard();
    if (!body) return;
    body.appendChild(el("div", "msg", `Filled your <b>${esc(res.company)}</b> login.`));
    tenantStrip(body, ctx.host, ctx.tenant);
    const list = el("ul", "receipt");
    out.forEach((r) => list.appendChild(el("li", r.ok ? "" : "no", `<s>${r.ok ? "\u2713" : "\u00d7"}</s><span>${r.label}</span>`)));
    body.appendChild(list);
    if (res.why === "same-domain") {
      body.appendChild(el("div", "msg", "This is a different subdomain than the one you saved, so check it before submitting."));
    }
    cardTimer = setTimeout(closeCard, 6500);
  }

  function offerNewAccount(fields) {
    const body = openCard();
    if (!body) return;
    const signup = isSignupPage();
    const pwFields = passwordFields();
    body.appendChild(
      el("div", "msg",
        signup
          ? `New account at <b>${esc(ctx.company)}</b>. Pick an email and JobVault will generate the password and remember it.`
          : `No saved login for <b>${esc(ctx.company)}</b> yet. JobVault will remember it once you sign in.`)
    );
    tenantStrip(body, ctx.host, ctx.tenant);

    let sel = null;
    const emails = ctx.emails?.length ? ctx.emails : ctx.defaultEmail ? [ctx.defaultEmail] : [];
    if (emails.length) {
      body.appendChild(el("label", "lbl", "Email to use"));
      sel = document.createElement("select");
      emails.forEach((e) => {
        const o = document.createElement("option");
        o.value = e; o.textContent = e;
        sel.appendChild(o);
      });
      if (ctx.defaultEmail && emails.includes(ctx.defaultEmail)) sel.value = ctx.defaultEmail;
      body.appendChild(sel);
    }

    const emailOf = () => (sel ? sel.value : ctx.defaultEmail || "");

    if (signup && pwFields.length) {
      button(body, "Fill email and a strong password", "primary", async () => {
        const gen = await send({ type: "generatePassword", opts: { length: 20, avoidAmbiguous: true } });
        const userEl = (fields.get("username") || fields.get("email"))?.el || collectFields({ authContext: true }).get("username")?.el;
        const out = [];
        if (userEl) out.push({ label: "email", ok: setText(userEl, emailOf()) });
        passwordFields().forEach((f, i) => out.push({ label: i === 0 ? "password" : "confirm password", ok: setText(f, gen.password) }));
        captured = { email: emailOf(), password: gen.password, isNew: true };
        watchSubmit();
        receipt(`New ${ctx.company} account`, out, "Saved to your vault as soon as the sign-up goes through.");
      });
    } else {
      button(body, "Fill my email", "ghost", () => {
        const userEl = (fields.get("username") || fields.get("email"))?.el;
        if (userEl) setText(userEl, emailOf());
        watchSubmit();
        closeCard();
      });
    }
    button(body, "Not now", "ghost", closeCard);
  }

  // ------------------------------------------------------ application flow

  async function doFillApplication({ explicit = false } = {}) {
    if (!ctx || ctx.locked) {
      if (explicit) toast("JobVault is locked. Open it from the toolbar, then try again.");
      return;
    }
    const res = await send({ type: "fillApplication", url: location.href });
    if (!res.ok) return explicit && toast(esc(res.error || "Could not read your profile."));
    const values = res.values || {};
    if (!Object.keys(values).length) {
      return toast("Your application profile is empty. Open JobVault \u2192 Profile to fill it in once.");
    }

    const fields = collectFields({ authContext: false });
    const results = [];
    const skipped = [];

    for (const [key, found] of fields) {
      if (["password", "confirmPassword", "username"].includes(key)) continue;
      let want = values[key];
      // fullName forms are common on Lever and Ashby; synthesise it when needed.
      if (!want && key === "fullName") want = values.fullName;
      if (!want && key === "email") want = values.email;
      if (!want) continue;
      if (found.el.value && found.el.value !== want && !explicit) { skipped.push(key); continue; }
      const ok = await applyValue(found.el, want);
      results.push({ label: humanKey(key), ok });
      if (!ok) skipped.push(key);
    }

    // Custom dropdown triggers Workday uses instead of a <select>.
    for (const trigger of Array.from(document.querySelectorAll('button[aria-haspopup="listbox"], [role="combobox"][aria-haspopup="listbox"]')).filter(isVisible).slice(0, 8)) {
      const hit = classify(trigger, {}) || (() => {
        const hay = haystack(trigger);
        for (const [key, re, neg] of RULES) if (re.test(hay) && !(neg && neg.test(hay))) return { key };
        return null;
      })();
      if (!hit || !values[hit.key]) continue;
      if (fields.has(hit.key)) continue;
      const ok = await pickFromListbox(trigger, values[hit.key]);
      results.push({ label: humanKey(hit.key), ok });
    }

    if (!results.length) {
      return toast("No fields on this page matched your profile. If this is an application form, tell me which portal and I can add it.");
    }

    const failed = results.filter((r) => !r.ok).map((r) => r.label);
    receipt(
      "Application form",
      results,
      failed.length
        ? `Finish by hand: ${esc(failed.slice(0, 4).join(", "))}. Dropdowns that load their options late sometimes need a second try.`
        : "Check the page before you submit. Resume uploads still need a click, because browsers do not let extensions attach files."
    );
  }

  const HUMAN = {
    firstName: "first name", lastName: "last name", middleName: "middle name", preferredName: "preferred name",
    fullName: "full name", email: "email", phone: "phone", phoneType: "phone type", phoneCountryCode: "country code",
    addressLine1: "street", addressLine2: "unit", city: "city", state: "province", postalCode: "postal code",
    country: "country", linkedin: "LinkedIn", github: "GitHub", portfolio: "portfolio", website: "website",
    currentCompany: "employer", currentTitle: "job title", yearsExperience: "years of experience",
    desiredSalary: "expected salary", noticePeriod: "notice period", earliestStartDate: "start date",
    workAuthorized: "work authorization", needsSponsorship: "sponsorship", willingToRelocate: "relocation",
    remotePreference: "work arrangement", over18: "age confirmation", hasDriversLicense: "driver's licence",
    previouslyEmployed: "previous employment", source: "how you heard", referredBy: "referred by",
    gender: "gender", hispanicLatino: "Hispanic or Latino", ethnicity: "ethnicity",
    veteranStatus: "veteran status", disabilityStatus: "disability status", pronouns: "pronouns",
  };
  const humanKey = (k) => HUMAN[k] || k;

  // ------------------------------------------------------------ job actions

  async function doSaveJob({ explicit = false } = {}) {
    if (!ctx || ctx.locked) return explicit && toast("JobVault is locked. Open it from the toolbar first.");
    const job = currentJob();
    if (!job.title && !job.company) return explicit && toast("This page does not look like a job posting.");
    let matchScore = null;
    if (ctx.hasResume && job.jdText) {
      const m = await send({ type: "matchJob", text: job.jdText });
      matchScore = m?.result?.score ?? null;
    }
    const res = await send({ type: "saveJob", job: { ...job, matchScore } });
    if (!res.ok) return toast(esc(res.error || "Could not save."));

    const body = openCard();
    if (!body) return;
    body.appendChild(
      el("div", "msg",
        res.duplicate
          ? `Already tracking <b>${esc(res.job.company)}</b> \u2014 ${esc(res.job.title)}. Details refreshed.`
          : `Saved <b>${esc(res.job.company)}</b> \u2014 ${esc(res.job.title)}${matchScore != null ? ` \u00b7 ${matchScore}% match` : ""}.`)
    );
    const row = el("div", "row");
    body.appendChild(row);
    button(row, "Mark as applied", "primary", async () => {
      await send({ type: "updateJob", id: res.job.id, patch: { status: "applied" } });
      toast("Marked as applied. You will get a nudge if there is no reply.");
    });
    button(row, "Open tracker", "ghost", () => send({ type: "openDashboard", hash: "#jobs" }));
    cardTimer = setTimeout(closeCard, 8000);
  }

  async function runMatch() {
    if (!ctx || ctx.locked) return;
    if (!ctx.settings?.matchOnOpen || !ctx.hasResume) return;
    if (!IS_TOP || seenMatch.has(location.href)) return;
    if (!looksLikeJobPosting()) return;
    seenMatch.add(location.href);
    const text = extractJobText();
    if (text.length < 400) return;
    const res = await send({ type: "matchJob", text });
    if (!res?.ok || !res.result) return;
    showMatch(res.result);
  }

  function showMatch(r) {
    const body = openCard();
    if (!body) return;
    const color = r.score >= 70 ? "#5cbf8a" : r.score >= 45 ? "#d9a441" : "#cf7259";
    const circ = 2 * Math.PI * 19;
    const head = el("div", "head");
    head.innerHTML = `
      <svg class="ring" viewBox="0 0 46 46" aria-hidden="true">
        <circle cx="23" cy="23" r="19" fill="none" stroke="#1a212b" stroke-width="5.5"/>
        <circle cx="23" cy="23" r="19" fill="none" stroke="${color}" stroke-width="5.5" stroke-linecap="round"
          stroke-dasharray="${circ}" stroke-dashoffset="${circ - (circ * r.score) / 100}" transform="rotate(-90 23 23)"/>
      </svg>
      <div><div class="score">${r.score}%</div><div class="msg" style="margin:0">resume vs this posting</div></div>`;
    body.appendChild(head);
    const note = r.notes?.[0];
    if (note) body.appendChild(el("div", "msg", esc(note.text)));
    const gaps = r.mustHaveMissing?.length ? r.mustHaveMissing : r.missing;
    if (gaps?.length) {
      body.appendChild(el("div", "h4", r.mustHaveMissing?.length ? "Missing from the requirements" : "Worth adding if true for you"));
      const chips = el("div", "chips");
      gaps.slice(0, 8).forEach((t) => chips.appendChild(el("span", "chip miss", esc(t))));
      body.appendChild(chips);
    }
    const row = el("div", "row");
    body.appendChild(row);
    button(row, "Save this job", "primary", () => doSaveJob({ explicit: true }));
    button(row, "Dismiss", "ghost", closeCard);
  }

  const CONFIRM_RE = /(thank you for (your interest|applying|your application)|application (has been )?(submitted|received|sent)|we(?:'ve| have) received your application|successfully (submitted|applied)|your application was (sent|submitted)|submission (was )?successful)/i;

  let lastConfirmScan = 0;
  async function checkConfirmation() {
    if (!IS_TOP || !ctx || ctx.locked || !ctx.settings?.autoTrack) return;
    if (seenConfirm.has(location.href)) return;
    if (Date.now() - lastConfirmScan < 2500) return;
    lastConfirmScan = Date.now();

    // A confirmation screen has no form left on it. Bailing here avoids the
    // expensive text read on every ordinary page.
    const selectorHit = document.querySelector('[data-automation-id="applicationSubmitted"], #application_confirmation, .postings-thanks, [class*="thank-you"]');
    const urlHit = /successfulsubmission|\/thanks|\/thank-you|confirmation/i.test(location.pathname);
    let textHit = false;
    if (!selectorHit && !urlHit) {
      if (document.querySelectorAll("input:not([type=hidden]), textarea").length > 2) return;
      textHit = CONFIRM_RE.test((document.body?.innerText || "").slice(0, 3000));
    }
    if (!selectorHit && !urlHit && !textHit) return;
    seenConfirm.add(location.href);
    const job = currentJob();
    const res = await send({
      type: "markApplied",
      url: location.href,
      company: job.company || ctx.company,
      title: job.title,
      location: job.location,
      ats: ATS,
    });
    if (res?.ok && !res.skipped && !res.unchanged) {
      toast(`Logged your application to <b>${esc(res.job.company)}</b>. It is in your tracker now.`, 6000);
    }
  }

  // --------------------------------------------------------------- the loop

  async function refreshContext() {
    const res = await send({ type: "pageContext", url: location.href });
    if (res?.ok) ctx = res;
    return ctx;
  }

  let scanning = false;
  async function scan(reason) {
    if (scanning) return;
    scanning = true;
    try {
      if (!ctx || reason === "nav") await refreshContext();
      if (!ctx) return;

      if (isAuthPage()) {
        watchSubmit();
        if (ctx.locked) {
          if (IS_TOP && !announcedSignup) {
            announcedSignup = true;
            toast("Unlock JobVault from the toolbar and this page fills itself.", 5000);
          }
          return;
        }
        if (!filledLogin) {
          const single = ctx.matches.length === 1;
          const exact = ctx.matches[0]?.exact;
          const allowed = ctx.settings.autofillLogins && exact && (single || !ctx.settings.onlyWhenSingle);
          if (allowed) await doFillLogin();
          else if (ctx.matches.length > 1) offerLoginChoice();
          else if (!ctx.matches.length && isSignupPage() && !announcedSignup) {
            announcedSignup = true;
            offerNewAccount(collectFields({ authContext: true }));
          }
        }
        return;
      }

      if (ctx.locked) return;
      if (ctx.settings.autofillApplication && applicationFieldCount() >= 5 && !scan.filledApp) {
        scan.filledApp = true;
        await doFillApplication();
        return;
      }
      await checkConfirmation();
      await runMatch();
    } finally {
      scanning = false;
    }
  }

  function offerLoginChoice() {
    if (offerLoginChoice.shown) return;
    offerLoginChoice.shown = true;
    const body = openCard();
    if (!body) return;
    body.appendChild(el("div", "msg", `More than one saved login could fit <b>${esc(ctx.host)}</b>. Pick one.`));
    tenantStrip(body, ctx.host, ctx.tenant);
    const sel = document.createElement("select");
    ctx.matches.forEach((m) => {
      const o = document.createElement("option");
      o.value = m.id;
      o.textContent = `${m.company} \u00b7 ${m.email || "no email"}${m.exact ? "" : " (different subdomain)"}`;
      sel.appendChild(o);
    });
    body.appendChild(el("label", "lbl", "Saved logins"));
    body.appendChild(sel);
    button(body, "Fill this one", "primary", () => doFillLogin({ explicit: true, id: sel.value }));
    button(body, "Not now", "ghost", closeCard);
  }

  // Debounced observer. The callback stays trivial so a chatty SPA cannot make
  // typing feel sluggish; all real work happens on the trailing edge.
  let pending = null;
  const schedule = (reason, delay = 320) => {
    clearTimeout(pending);
    pending = setTimeout(() => scan(reason), delay);
  };

  const observer = new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === "childList" && (r.addedNodes.length || r.removedNodes.length)) return schedule("mutate");
      if (r.type === "attributes") return schedule("mutate", 500);
    }
  });

  function startObserving() {
    try {
      observer.observe(document.documentElement, {
        childList: true, subtree: true, attributes: true,
        attributeFilter: ["type", "style", "class", "hidden", "aria-hidden", "data-automation-id"],
      });
    } catch { /* detached document */ }
  }

  function onNavigate() {
    filledLogin = false;
    announcedSignup = false;
    scan.filledApp = false;
    offerLoginChoice.shown = false;
    captured = { email: "", password: "", isNew: false };
    closeCard();
    hideBadge();
    schedule("nav", 420);
  }

  // SPA routing does not fire a load event, and polling location.href misses
  // same-URL view swaps, so hook the history API directly.
  for (const method of ["pushState", "replaceState"]) {
    const orig = history[method];
    history[method] = function (...args) {
      const out = orig.apply(this, args);
      onNavigate();
      return out;
    };
  }
  window.addEventListener("popstate", onNavigate);
  window.addEventListener("hashchange", onNavigate);

  let lastHref = location.href;
  setInterval(() => {
    if (location.href !== lastHref) { lastHref = location.href; onNavigate(); }
  }, 1500);

  chrome.runtime.onMessage.addListener((msg, sender, respond) => {
    (async () => {
      switch (msg?.type) {
        case "fillLoginNow": await refreshContext(); await doFillLogin({ explicit: true, id: msg.id }); respond({ ok: true }); break;
        case "fillApplicationNow": await refreshContext(); await doFillApplication({ explicit: true }); respond({ ok: true }); break;
        case "saveJobNow": await refreshContext(); await doSaveJob({ explicit: true }); respond({ ok: true }); break;
        case "scrapeJob": respond({ ok: true, ...currentJob(), pageTitle: document.title }); break;
        case "pageSummary":
          respond({
            ok: true,
            isTop: IS_TOP,
            host: location.hostname,
            url: location.href,
            ats: ATS,
            hasLoginForm: isAuthPage(),
            isSignup: isSignupPage(),
            appFields: applicationFieldCount(),
            isPosting: looksLikeJobPosting(),
            job: looksLikeJobPosting() ? (({ jdText, ...rest }) => rest)(currentJob()) : null,
          });
          break;
        default: respond({ ok: false, error: "unknown" });
      }
    })();
    return true;
  });

  // ------------------------------------------------------------------ start

  (async () => {
    await refreshContext();
    startObserving();
    schedule("nav", 120);
    // Late-rendering portals: a few extra passes cost nothing and catch the
    // forms that appear well after document_idle.
    for (const t of [900, 2200, 4500, 8000]) setTimeout(() => scan("retry"), t);
  })();
})();
