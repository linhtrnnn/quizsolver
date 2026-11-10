const questionTextEl = document.getElementById("questionText");
const answerTextEl = document.getElementById("answerText");
const statusEl = document.querySelector(".status");

const defaultFooter = document.getElementById("defaultFooter");
const reportPanel = document.getElementById("reportPanel");
const thanksBanner = document.getElementById("thanksBanner");
const settingsPanel = document.getElementById("settingsPanel");
const openReportBtn = document.getElementById("openReportBtn");
const sendReportBtn = document.getElementById("sendReportBtn");
const cancelReportBtn = document.getElementById("cancelReportBtn");
const correctAnswerInput = document.getElementById("correctAnswerInput");
const reportHint = document.getElementById("reportHint");
const openSettingsBtn = document.getElementById("openSettingsBtn");
const saveSettingsBtn = document.getElementById("saveSettingsBtn");
const closeSettingsBtn = document.getElementById("closeSettingsBtn");
const apiKeyInput = document.getElementById("apiKeyInput");
const settingsHint = document.getElementById("settingsHint");

let mode = "answer"; // "answer" | "reporting" | "thanks" | "settings"

function render() {
  defaultFooter.hidden = mode !== "answer";
  reportPanel.hidden = mode !== "reporting";
  thanksBanner.hidden = mode !== "thanks";
  settingsPanel.hidden = mode !== "settings";
}

openSettingsBtn.addEventListener("click", async () => {
  const { geminiApiKey } = await chrome.storage.local.get("geminiApiKey");
  apiKeyInput.value = geminiApiKey || "";
  settingsHint.textContent = geminiApiKey ? "Key loaded." : "No key saved yet.";
  mode = "settings";
  render();
});

closeSettingsBtn.addEventListener("click", () => {
  mode = "answer";
  render();
});

saveSettingsBtn.addEventListener("click", async () => {
  const key = apiKeyInput.value.trim();
  if (!key) {
    settingsHint.textContent = "Enter a key first.";
    return;
  }
  await chrome.storage.local.set({ geminiApiKey: key });
  mode = "answer";
  render();
});

openReportBtn.addEventListener("click", () => {
  correctAnswerInput.value = "";
  reportHint.textContent = "";
  mode = "reporting";
  render();
  correctAnswerInput.focus();
});

cancelReportBtn.addEventListener("click", () => {
  mode = "answer";
  render();
});

sendReportBtn.addEventListener("click", async () => {
  const correct = correctAnswerInput.value.trim();
  if (!correct) { reportHint.textContent = "Type the correct answer first."; return; }
  if (!currentPayload) { reportHint.textContent = "No question scanned to attach this to."; return; }
  const resp = await chrome.runtime.sendMessage({
    type: "REPORT_WRONG",
    payload: currentPayload,
    correct,
  });
  if (!resp?.success) { reportHint.textContent = resp?.error || "Save failed."; return; }
  mode = "thanks";
  render();
  setTimeout(() => { mode = "answer"; render(); }, 1800);
});

render();

// -------- Auto-scrape question from the active tab on open --------

const TYPE_LABELS = {
  mc: "Multiple choice",
  ms: "Multi-select",
  fib: "Fill in the blank",
  match: "Matching",
  order: "Ordering",
  tf: "True / false",
};

async function scrapeAndFill() {
  statusEl.textContent = "Scanning…";
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error("No active tab");

    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      func: pageScraper,
    });

    for (const r of results) {
      if (r.result && r.result.__payload) {
        const payload = r.result.payload;
        const cleaned = (payload.q || "")
          .replace(/\bBlank\s*\d*\b/gi, "")
          .replace(/\s+/g, " ")
          .trim();
        questionTextEl.textContent = cleaned || "(empty question)";
        statusEl.textContent = `${TYPE_LABELS[payload.t] || payload.t} scanned`;
        currentPayload = payload;
        await solve(payload);
        return;
      }
    }
    questionTextEl.textContent = "No question found on this page.";
    statusEl.textContent = "Nothing scanned";
    answerTextEl.textContent = "—";
  } catch (err) {
    questionTextEl.textContent = `Scan failed: ${err.message}`;
    statusEl.textContent = "Scan failed";
    answerTextEl.textContent = "—";
  }
}

let currentPayload = null;

async function solve(payload) {
  answerTextEl.textContent = "Thinking…";
  let got = false;
  const port = chrome.runtime.connect({ name: "solve" });
  port.postMessage({ type: "SOLVE", payload });
  port.onMessage.addListener((msg) => {
    if (msg.error) {
      if (!got) answerTextEl.textContent = msg.error;
      port.disconnect();
      return;
    }
    if (msg.delta) {
      if (!got) { answerTextEl.textContent = ""; got = true; }
      answerTextEl.textContent += msg.delta;
    }
    if (msg.done) port.disconnect();
  });
}

// Runs in the page's isolated world; must be self-contained.
function pageScraper() {
  const queryDeep = (selector) => {
    const results = [];
    const roots = [document];
    const seen = new Set();
    while (roots.length) {
      const root = roots.shift();
      if (!root || seen.has(root)) continue;
      seen.add(root);
      try { root.querySelectorAll(selector).forEach((el) => results.push(el)); } catch (_) {}
      try {
        root.querySelectorAll("*").forEach((el) => {
          if (el.shadowRoot) roots.push(el.shadowRoot);
        });
      } catch (_) {}
    }
    return results;
  };
  const queryDeepFirst = (s) => queryDeep(s)[0] || null;

  const probe =
    queryDeepFirst('[class*="aw-probe-type-"]') ||
    queryDeepFirst('[class*="probe-type-"]') ||
    queryDeepFirst("aa-air-item") ||
    queryDeepFirst("awd-probe") ||
    queryDeepFirst("avalon-probe-renderer") ||
    queryDeepFirst(".multiple-choice, .multi-select, .multiple-select, .fill-in-the-blank, .matching, .true-false, .sortable");
  if (!probe) return null;

  const normalizeWs = (s) => (s || "").replace(/\s+/g, " ").trim();
  const inRevealPanel = (node) => {
    let cur = node;
    while (cur) {
      const cls = (cur.className || "") + "";
      if (cls.includes("correct-answer")) return true;
      cur = cur.parentNode || cur.host;
    }
    return false;
  };
  const subDeep = (root, selector) => {
    const out = [];
    const roots = [root];
    const seen = new Set();
    while (roots.length) {
      const r = roots.shift();
      if (!r || seen.has(r)) continue;
      seen.add(r);
      try { r.querySelectorAll(selector).forEach((el) => out.push(el)); } catch (_) {}
      try {
        r.querySelectorAll("*").forEach((el) => { if (el.shadowRoot) roots.push(el.shadowRoot); });
      } catch (_) {}
    }
    return out;
  };
  const subDeepFirst = (root, s) => subDeep(root, s)[0] || null;

  const detectType = (p) => {
    const typed = subDeepFirst(p, '[class*="aw-probe-type-"], [class*="probe-type-"]') || p;
    const cls = ((typed.className || "") + " " + (p.className || "")) + "";
    if (cls.includes("multiple_choice") || cls.includes("multiple-choice")) return "mc";
    if (cls.includes("multiple_select") || cls.includes("multi-select") || cls.includes("multiple-select")) return "ms";
    if (cls.includes("fill_in_the_blank") || cls.includes("fill-in-the-blank")) return "fib";
    if (cls.includes("matching")) return "match";
    if (cls.includes("sortable")) return "order";
    if (cls.includes("true_false") || cls.includes("true-false")) return "tf";
    return "unknown";
  };

  const extractStem = (p) => {
    const candidates = [
      ".question-info-wc",
      '[class*="prompt"]:not([class*="match-prompt-label"])',
      '[id="prompt"]',
      ".question-text",
      ".dfe_question",
      ".answers_header",
      // ezto chapter quiz: stem lives in a .question-wrap sibling of the
      // .answers-wrap that the probe matched.
      ".question-wrap",
    ];
    // Walk up from the probe: on asto.mheducation.com the stem lives in an
    // ancestor of the answers container, not inside it.
    let root = p;
    for (let depth = 0; depth < 5 && root; depth++) {
      for (const sel of candidates) {
        const el = subDeep(root, sel).find((n) => !inRevealPanel(n));
        if (!el) continue;
        const clone = el.cloneNode(true);
        clone.querySelectorAll(
          "[class*='sr-only'], [class*='visuallyHidden'], [class*='visually-hidden'], [aria-hidden='true'], .screenReader"
        ).forEach((n) => n.remove());
        const blankLabelRe = /^\s*blank(\s*\d+)?\s*$/i;
        clone.querySelectorAll("*").forEach((n) => {
          if (n.querySelector("input")) return;
          const t = (n.textContent || "").trim();
          if (t && blankLabelRe.test(t)) n.remove();
        });
        clone.querySelectorAll("input").forEach((inp) => {
          inp.replaceWith(document.createTextNode(" ___ "));
        });
        const txt = normalizeWs(clone.innerText || clone.textContent || "");
        if (txt) return txt;
      }
      root = root.parentNode || root.host;
    }
    return "";
  };

  const extractFillInBlank = (p) => {
    const isCloak = (el) =>
      /cloak|sr-only|visually-?hidden|screenReader/i.test((el.className || "") + "");
    const rawLegend = subDeep(p, ".fib-fieldset legend, legend")
      .find((l) => !isCloak(l) && !inRevealPanel(l));
    if (!rawLegend) return extractStem(p);
    const legend = rawLegend.cloneNode(true);

    // Strip screen-reader-only labels and generic hidden content.
    legend.querySelectorAll(
      "[class*='sr-only'], [class*='visuallyHidden'], [class*='visually-hidden'], [aria-hidden='true'], .screenReader"
    ).forEach((n) => n.remove());

    // Strip any element whose only text is "Blank" / "Blank 1" — a label
    // McGraw Hill renders next to the input but has no hidden-class marker.
    const blankLabelRe = /^\s*blank(\s*\d+)?\s*$/i;
    legend.querySelectorAll("*").forEach((el) => {
      if (el.querySelector("input")) return; // keep wrappers that contain inputs
      const t = (el.textContent || "").trim();
      if (t && blankLabelRe.test(t)) el.remove();
    });

    const parts = [];
    legend.childNodes.forEach((node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        parts.push(node.textContent);
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        const inputs = node.matches && node.matches("input") ? [node] : node.querySelectorAll ? node.querySelectorAll("input") : [];
        if (inputs.length > 0) inputs.forEach(() => parts.push(" ___ "));
        else parts.push(node.innerText || node.textContent || "");
      }
    });

    // Safety net: any "Blank" / "Blank N" that survived (e.g. loose text node) → drop it.
    const raw = parts.join("").replace(/\bBlank\s*\d*\b/gi, "");
    return normalizeWs(raw);
  };

  const labelTextForInput = (inp) => {
    const el = (inp.labels && inp.labels[0]) || inp.closest("label") || inp.parentElement;
    if (!el) return "";
    const clone = el.cloneNode(true);
    clone.querySelectorAll(
      "input, [class*='sr-only'], [class*='visuallyHidden'], [class*='visually-hidden'], [aria-hidden='true'], .screenReader"
    ).forEach((n) => n.remove());
    return normalizeWs(clone.innerText || clone.textContent || "");
  };

  const extractOptions = (p) => {
    const inputs = subDeep(p, 'input[type="radio"], input[type="checkbox"]').filter((i) => !inRevealPanel(i));
    const out = [];
    const seen = new Set();
    for (const inp of inputs) {
      const t = labelTextForInput(inp);
      if (t && !seen.has(t)) { seen.add(t); out.push(t); }
    }
    return out;
  };

  const extractMatch = (p) => {
    // shortcut: generic selectors; add McGraw-specific ones once we see a miss.
    const promptsEls = subDeep(p, '[class*="match-prompt"], [class*="matching-prompt"]').filter((e) => !inRevealPanel(e));
    const choicesEls = subDeep(p, '[class*="match-choice"], [class*="matching-choice"], [draggable="true"]').filter((e) => !inRevealPanel(e));
    const toText = (e) => normalizeWs(e.innerText || e.textContent || "");
    return { p: promptsEls.map(toText).filter(Boolean), c: choicesEls.map(toText).filter(Boolean) };
  };

  const extractOrderItems = (p) => {
    // shortcut: generic sortable selectors; items in current (shuffled) DOM order.
    const els = subDeep(p, '[class*="sortable-item"], [class*="sort-item"], [draggable="true"]')
      .filter((e) => !inRevealPanel(e));
    const cleanAria = (t) => normalizeWs(
      t.replace(/choice\s+\d+\s+of\s+\d+\.?/gi, "")
       .replace(/toggle button/gi, "")
    );
    const dedupe = (t) => {
      const w = t.split(" ");
      const h = Math.floor(w.length / 2);
      return h > 0 && w.slice(0, h).join(" ") === w.slice(h, h * 2).join(" ")
        ? w.slice(0, h).join(" ")
        : t;
    };
    const out = [];
    for (const el of els) {
      const clone = el.cloneNode(true);
      clone.querySelectorAll(
        "[class*='sr-only'], [class*='visuallyHidden'], [class*='visually-hidden'], [aria-hidden='true'], .screenReader"
      ).forEach((n) => n.remove());
      const t = dedupe(cleanAria(normalizeWs(clone.innerText || clone.textContent || "")));
      if (t) out.push(t);
    }
    return out;
  };

  const countBlanks = (p) =>
    subDeep(p, '.fib-fieldset input, legend input, input[type="text"]').filter((e) => !inRevealPanel(e)).length;

  const type = detectType(probe);
  const q = type === "fib" ? extractFillInBlank(probe) : extractStem(probe);
  const payload = { t: type, q };
  if (type === "mc" || type === "ms") payload.o = extractOptions(probe);
  else if (type === "match") Object.assign(payload, extractMatch(probe));
  else if (type === "order") payload.c = extractOrderItems(probe);
  else if (type === "fib") payload.n = countBlanks(probe) || 1;
  return { __payload: true, payload };
}

scrapeAndFill();
