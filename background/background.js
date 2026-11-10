const GEMINI_MODEL = "gemini-3.8-flash";
const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/interactions";

const MAX_CORRECTIONS_PER_TYPE = 30;
const FEWSHOT_PER_TYPE = 5;

const COURSE_CONTEXT =
  "Context: these are questions from an undergraduate marketing course (McGraw Hill textbook / Connect). " +
  "Expect standard marketing terminology (4 Ps, segmentation/targeting/positioning, consumer behavior, " +
  "brand equity, pricing strategies, distribution channels, promotion/IMC, marketing research, etc.). " +
  "Prefer the textbook-standard answer over colloquial usage when they differ.";

const DEFAULT_PROMPTS = {
  mc: `You are a quiz solver. Given a multiple-choice question in JSON (keys: q=question, o=options), choose the single correct option.
Reply with ONLY the letter and option text, like: "B) <option text>". No explanation.`,
  ms: `You are a quiz solver. Given a multiple-select question in JSON (keys: q=question, o=options), choose ALL correct options.
Reply with ONLY letters and option texts, one per line, like:
A) <option text>
C) <option text>
No explanation.`,
  fib: `You are a quiz solver. Given a fill-in-the-blank question in JSON (q=question with "___" marking each blank, n=number of blanks), provide the exact word(s) that fill each blank.
Reply with ONLY the answers in order, one per line, nothing else.`,
  match: `You are a quiz solver. Given a matching question in JSON (q=stem, p=prompts, c=choices), pair every prompt with the single best choice from c. Each choice is used once.
Reply with ONLY the pairings, one per line, format: "<prompt> -> <choice>". No explanation.`,
  order: `You are a quiz solver. Given an ordering question in JSON (q=stem, c=items in random order), reorder the items into the correct sequence from first/top to last/bottom.
Reply with ONLY the items in correct order, one per line, numbered "1. ", "2. ", etc. No explanation.`,
  tf: `You are a quiz solver. Given a true/false question in JSON (q=statement), decide if the statement is True or False.
Reply with ONLY the word "True" or "False". No explanation.`,
};

chrome.runtime.onInstalled.addListener(async () => {
  const stored = await chrome.storage.local.get(["prompts", "corrections"]);
  if (!stored.prompts) await chrome.storage.local.set({ prompts: DEFAULT_PROMPTS });
  if (!stored.corrections) await chrome.storage.local.set({ corrections: {} });
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "solve") return;
  const ac = new AbortController();
  port.onDisconnect.addListener(() => ac.abort());
  port.onMessage.addListener((msg) => {
    if (msg.type === "SOLVE") {
      handleSolveStreaming(msg.payload, port, ac.signal).catch((err) => {
        try { port.postMessage({ error: err.message }); port.postMessage({ done: true }); } catch (_) {}
      });
    }
  });
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "REPORT_WRONG") {
    handleReportWrong(message.payload, message.correct)
      .then((result) => sendResponse({ success: true, ...result }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }
  if (message.type === "GET_DEFAULT_PROMPTS") {
    sendResponse({ prompts: DEFAULT_PROMPTS });
    return false;
  }
  if (message.type === "GET_CORRECTIONS_COUNT") {
    chrome.storage.local.get("corrections").then(({ corrections }) => {
      sendResponse({ total: countCorrections(corrections) });
    });
    return true;
  }
  if (message.type === "CLEAR_CORRECTIONS") {
    chrome.storage.local.set({ corrections: {} }).then(() => sendResponse({ success: true }));
    return true;
  }
});

async function handleSolveStreaming(payload, port, signal) {
  const { geminiApiKey, prompts, corrections, lastAnswer } = await chrome.storage.local.get([
    "geminiApiKey",
    "prompts",
    "corrections",
    "lastAnswer",
  ]);
  const send = (m) => { try { port.postMessage(m); } catch (_) {} };

  if (!geminiApiKey) { send({ error: "Gemini API key not set. Open Settings." }); send({ done: true }); return; }

  const promptTemplates = { ...DEFAULT_PROMPTS, ...(prompts || {}) };
  const system = promptTemplates[payload.t];
  if (!system) { send({ error: `No prompt configured for type: ${payload.t}` }); send({ done: true }); return; }

  const store = corrections || {};
  const bucket = store[payload.t] || [];

  const key = fingerprint(payload);
  const hit = bucket.find((c) => c.key === key);
  if (hit) { send({ delta: hit.correct }); send({ done: true, cached: true }); return; }

  // Popup was reopened on the same question → return the prior answer, no API call.
  if (lastAnswer?.key === key && lastAnswer.answer) {
    send({ delta: lastAnswer.answer });
    send({ done: true, cached: true });
    return;
  }

  const examples = bucket.slice(-FEWSHOT_PER_TYPE);
  const exampleBlock = examples.length
    ? "\n\nExamples of previously-corrected questions (match this exact format):\n" +
      examples.map((e) => `Q: ${JSON.stringify(e.payload)}\nA: ${e.correct}`).join("\n")
    : "";
  const fullPrompt = `${COURSE_CONTEXT}\n\n${system}${exampleBlock}\n\n${JSON.stringify(payload)}`;

  const response = await fetch(GEMINI_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": geminiApiKey },
    body: JSON.stringify({
      model: GEMINI_MODEL,
      input: fullPrompt,
      stream: true,
      generation_config: { temperature: 0, max_output_tokens: 256 },
    }),
    signal,
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    send({ error: err?.error?.message || `HTTP ${response.status}` });
    send({ done: true });
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let lineBuf = "";
  let got = false;
  let fullText = "";
  let currentStepType = null;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    lineBuf += decoder.decode(value, { stream: true });
    const lines = lineBuf.split("\n");
    lineBuf = lines.pop() || "";
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const body = line.slice(5).trim();
      if (!body || body === "[DONE]") continue;
      let evt;
      try { evt = JSON.parse(body); } catch { continue; }
      const et = evt.event_type;
      if (et === "step.start") {
        currentStepType = evt.step?.type || null;
      } else if (et === "step.delta" && currentStepType !== "thought" && evt.delta?.type === "text") {
        const t = evt.delta.text;
        if (t) { got = true; fullText += t; send({ delta: t }); }
      }
    }
  }

  if (!got) send({ error: "Stream finished with no answer text." });
  else chrome.storage.local.set({ lastAnswer: { key, answer: fullText } });
  send({ done: true });
}

async function handleReportWrong(payload, correct) {
  if (!correct || !correct.trim()) throw new Error("No correct answer provided.");
  const { corrections } = await chrome.storage.local.get("corrections");
  const store = corrections || {};
  const bucket = store[payload.t] || [];
  const key = fingerprint(payload);

  // Overwrite existing entry for the same question if present; otherwise append.
  const idx = bucket.findIndex((c) => c.key === key);
  const entry = { key, payload, correct: correct.trim(), ts: Date.now() };
  if (idx >= 0) bucket[idx] = entry;
  else bucket.push(entry);

  while (bucket.length > MAX_CORRECTIONS_PER_TYPE) bucket.shift();

  store[payload.t] = bucket;
  await chrome.storage.local.set({ corrections: store });
  return { total: countCorrections(store) };
}

function countCorrections(store) {
  return Object.values(store || {}).reduce((n, a) => n + (a?.length || 0), 0);
}

function fingerprint(payload) {
  const parts = [payload.t, payload.q || ""];
  if (payload.o) parts.push(payload.o.join("||"));
  if (payload.p) parts.push("p=" + payload.p.join("||"));
  if (payload.c) parts.push("c=" + payload.c.join("||"));
  if (payload.n) parts.push(`n=${payload.n}`);
  return parts.join("|");
}
