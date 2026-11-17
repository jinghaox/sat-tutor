import { parseSource, buildBank, renderInline, renderPassage, renderFreeText, escapeHtml as esc } from "./parser.js";
import * as ai from "./ai.js";

const LS_KEY = "sat-tutor-v1";
const QUIZ_SIZE = 10;
const MAX_MOCKS_KEPT = 10;
const LETTERS = ["A", "B", "C", "D"];

const app = document.getElementById("app");

// ---------- saved state (this device only) ----------

function defaults() {
  return {
    settings: { apiKey: "", model: ai.DEFAULT_MODEL, lang: "en" },
    days: {}, // "YYYY-MM-DD" -> { sets: [{ ids: [...], ans: { id: { pick, key, correct } } }] }
    seen: {}, // question id -> time last answered
    aiKeys: {}, // question id -> "A".."D" | "skip", for questions missing from the answer key
    analysis: {}, // "id|lang" -> analysis
    mocks: {}, // question id -> [mock question, ...]
  };
}

function loadState() {
  const base = defaults();
  try {
    const saved = JSON.parse(localStorage.getItem(LS_KEY) || "{}");
    return { ...base, ...saved, settings: { ...base.settings, ...(saved.settings || {}) } };
  } catch {
    return base;
  }
}

function save() {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(state));
  } catch (err) {
    console.warn("Could not save progress", err);
  }
}

let state = loadState();
let bank = new Map();
let view = { name: "loading" };

// Per-question screen state that does not need to survive a reload.
const uiState = new Map();
function ui(id) {
  if (!uiState.has(id)) {
    uiState.set(id, { pick: null, showAnalysis: false, reveal: false, showMock: false, mockIdx: 0, mockPick: null, busy: {}, error: {} });
  }
  return uiState.get(id);
}

// ---------- dates ----------

const pad = (n) => String(n).padStart(2, "0");
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function prettyDate(s, opts = { weekday: "long", month: "long", day: "numeric" }) {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-US", opts);
}

// ---------- question bank and daily sets ----------

function answerOf(q) {
  if (q.key) return q.key;
  const k = state.aiKeys[q.id];
  return LETTERS.includes(k) ? k : null;
}
const usable = (q) => q.key || state.aiKeys[q.id] !== "skip";

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// Random pick that prefers questions not answered yet, then the least recently answered.
function pickQuestions(n, exclude = new Set()) {
  const pool = shuffle([...bank.values()].filter(usable));
  const rank = (q) => (exclude.has(q.id) ? 1e15 : 0) + (state.seen[q.id] || 0);
  pool.sort((a, b) => rank(a) - rank(b));
  return shuffle(pool.slice(0, n).map((q) => q.id));
}

function newSet(exclude) {
  return { ids: pickQuestions(QUIZ_SIZE, exclude), ans: {} };
}

function dayOf(date) {
  if (!state.days[date]) state.days[date] = { sets: [] };
  return state.days[date];
}

// Drops questions that are no longer in the source file.
function cleanDay(day) {
  for (const set of day.sets) set.ids = set.ids.filter((id) => bank.has(id));
  day.sets = day.sets.filter((set) => set.ids.length);
}

function ensureToday() {
  const day = dayOf(todayStr());
  cleanDay(day);
  if (!day.sets.length && bank.size) day.sets.push(newSet());
  save();
  return day;
}

function setStats(set) {
  const answered = set.ids.filter((id) => set.ans[id]).length;
  const correct = set.ids.filter((id) => set.ans[id]?.correct).length;
  return { total: set.ids.length, answered, correct, complete: answered === set.ids.length };
}

function currentSet() {
  return state.days[view.date]?.sets[view.setIdx];
}

// ---------- answer keys from AI, for questions the key file does not cover ----------

const keyRequests = new Map(); // question id -> in-flight promise

function resolveKeys(ids) {
  const waiting = ids.filter((id) => keyRequests.has(id)).map((id) => keyRequests.get(id));
  const todo = ids.map((id) => bank.get(id)).filter((q) => q && !q.key && !state.aiKeys[q.id] && !keyRequests.has(q.id));
  if (todo.length && state.settings.apiKey) {
    const request = ai
      .solve(state.settings, todo)
      .then((map) => {
        for (const [id, value] of map) state.aiKeys[id] = value;
        save();
      })
      .finally(() => todo.forEach((q) => keyRequests.delete(q.id)));
    todo.forEach((q) => keyRequests.set(q.id, request));
    waiting.push(request);
  }
  return Promise.all(waiting);
}

// Swaps out unanswered questions that the AI flagged as unreadable.
function replaceUnusable(set) {
  let changed = false;
  set.ids.forEach((id, i) => {
    const q = bank.get(id);
    if (q && !usable(q) && !set.ans[id]) {
      const [fresh] = pickQuestions(1, new Set(set.ids));
      if (fresh && !set.ids.includes(fresh)) {
        set.ids[i] = fresh;
        changed = true;
      }
    }
  });
  if (changed) save();
  return changed;
}

function prefetchKeys(set) {
  resolveKeys(set.ids)
    .then(() => {
      if (replaceUnusable(set)) {
        render();
        prefetchKeys(set);
      }
    })
    .catch((err) => console.warn("Answer lookup failed", err));
}

// ---------- navigation ----------

function go(next, { replace = false } = {}) {
  view = next;
  if (replace) history.replaceState(view, "");
  else history.pushState(view, "");
  render();
  window.scrollTo(0, 0);
}

window.addEventListener("popstate", (e) => {
  view = e.state || { name: "home" };
  render();
  window.scrollTo(0, 0);
});

// ---------- views ----------

function render() {
  const views = { loading: loadingView, error: errorView, home: homeView, quiz: quizView, result: resultView, settings: settingsView };
  app.innerHTML = (views[view.name] || homeView)();
}

function loadingView() {
  return `<div class="center"><div class="spinner"></div><p class="muted">Loading questions…</p></div>`;
}

function errorView() {
  return `<div class="center"><p class="error-text">${esc(view.message)}</p><button class="btn" data-action="reload">Try again</button></div>`;
}

function topBar(title, { back = false, settings = false } = {}) {
  return `<header class="topbar">
    ${back ? `<button class="icon-btn" data-action="back" aria-label="Back">‹</button>` : `<span class="logo" aria-hidden="true">✎</span>`}
    <h1>${esc(title)}</h1>
    ${settings ? `<button class="icon-btn" data-action="settings" aria-label="Settings">⚙</button>` : `<span class="icon-spacer"></span>`}
  </header>`;
}

function progressBar(stats) {
  const pct = stats.total ? Math.round((stats.answered / stats.total) * 100) : 0;
  return `<div class="bar" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100"><span style="width:${pct}%"></span></div>`;
}

function setLabel(stats) {
  if (!stats.answered) return "Start quiz";
  return stats.complete ? "See results" : "Continue quiz";
}

function homeView() {
  if (!bank.size) {
    return `${topBar("SAT Tutor", { settings: true })}<main><section class="card"><h2>No questions found</h2><p class="muted">Add questions to <code>resource/sat_source.md</code> and reload.</p></section></main>`;
  }
  const today = todayStr();
  const day = ensureToday();
  const cards = day.sets
    .map((set, i) => {
      const s = setStats(set);
      return `<section class="card ${i === 0 ? "hero" : ""}">
        ${i === 0 ? `<div class="eyebrow">${esc(prettyDate(today))}</div>` : ""}
        <h2>${i === 0 ? "Today’s quiz" : `Extra practice ${i}`}</h2>
        <p class="muted">${s.total} questions · Reading and Writing</p>
        ${progressBar(s)}
        <p class="stat-line">${s.answered ? `${s.answered} of ${s.total} answered · ${s.correct} correct` : "Not started yet"}</p>
        <button class="btn primary block" data-action="open-set" data-date="${today}" data-set="${i}">${setLabel(s)}</button>
      </section>`;
    })
    .join("");

  const allDone = day.sets.every((set) => setStats(set).complete);
  const extra = allDone ? `<button class="btn block" data-action="extra-set">Practice another ${Math.min(QUIZ_SIZE, bank.size)} questions</button>` : "";

  const past = Object.keys(state.days)
    .filter((d) => d !== today && state.days[d].sets.some((set) => set.ids.some((id) => bank.has(id))))
    .sort()
    .reverse()
    .slice(0, 30);
  const history = past.length
    ? `<section class="card"><h3>Earlier days</h3><ul class="history">${past
        .map((d) => {
          const s = setStats(state.days[d].sets[0]);
          return `<li><button class="row-btn" data-action="open-set" data-date="${d}" data-set="0"><span>${esc(prettyDate(d, { weekday: "short", month: "short", day: "numeric" }))}</span><span class="score-chip">${s.correct}/${s.total}</span></button></li>`;
        })
        .join("")}</ul></section>`
    : "";

  const keyHint = state.settings.apiKey
    ? ""
    : `<section class="card notice"><p><b>AI features are off.</b> Add your API key in Settings to turn on AI Analysis and Mock Test.</p><button class="btn" data-action="settings">Open Settings</button></section>`;

  return `${topBar("SAT Tutor", { settings: true })}
  <main>
    ${cards}
    ${extra}
    ${keyHint}
    ${history}
    <p class="footnote">${bank.size} questions in the bank</p>
  </main>`;
}

function optionButtons(q, { pick, answer, disabled, action }) {
  return `<div class="options">${LETTERS.map((l) => {
    let cls = "";
    if (answer) {
      if (l === answer.key) cls = "correct";
      else if (l === answer.pick) cls = "wrong";
    } else if (l === pick) cls = "selected";
    return `<button class="option ${cls}" data-action="${action}" data-letter="${l}" ${disabled ? "disabled" : ""}>
      <span class="letter">${l}</span><span class="option-text">${renderInline(q.options[l])}</span>
    </button>`;
  }).join("")}</div>`;
}

function quizView() {
  const set = currentSet();
  if (!set || !set.ids.length) return homeView();
  const idx = Math.min(view.qIdx, set.ids.length - 1);
  const id = set.ids[idx];
  const q = bank.get(id);
  const u = ui(id);
  const answer = set.ans[id];
  const stats = setStats(set);

  const pills = set.ids
    .map((qid, i) => {
      const a = set.ans[qid];
      const cls = [i === idx ? "current" : "", a ? (a.correct ? "ok" : "no") : ""].join(" ");
      return `<button class="pill ${cls}" data-action="goto" data-i="${i}" aria-label="Question ${i + 1}">${i + 1}</button>`;
    })
    .join("");

  const feedback = answer
    ? answer.correct
      ? `<div class="feedback ok"><b>Correct!</b></div>`
      : `<div class="feedback no"><b>Not quite.</b> The correct answer is <b>${answer.key}</b>.</div>`
    : "";

  const checkError = u.error.check ? `<p class="error-text">${esc(u.error.check)}</p>` : "";
  const actions = answer
    ? `<div class="btn-row">
        <button class="btn ai ${u.showAnalysis ? "active" : ""}" data-action="analysis">✦ AI Analysis</button>
        <button class="btn ai" data-action="mock" ${u.busy.mock ? "disabled" : ""}>✦ Mock Test</button>
      </div>`
    : `<button class="btn primary block" data-action="check" ${u.pick && !u.busy.check ? "" : "disabled"}>${u.busy.check ? "Checking…" : "Check answer"}</button>
       <button class="btn ai block ${u.showAnalysis ? "active" : ""}" data-action="analysis">✦ AI Analysis</button>`;

  const isLast = idx === set.ids.length - 1;
  return `${topBar(`Question ${idx + 1} of ${set.ids.length}`, { back: true })}
  <main class="quiz">
    <nav class="pills" aria-label="Questions">${pills}</nav>
    <article class="card question">
      <span class="tag">${esc(q.category)}</span>
      ${q.passage.length ? `<div class="passage">${renderPassage(q.passage)}</div>` : ""}
      <p class="stem">${renderInline(q.stem)}</p>
      ${optionButtons(q, { pick: u.pick, answer, disabled: !!answer || u.busy.check, action: "pick" })}
      ${feedback}
      ${checkError}
      ${actions}
    </article>
    ${u.showAnalysis ? analysisPanel(q, u, !!answer) : ""}
    ${u.showMock ? mockPanel(q, u) : mockLink(q)}
  </main>
  <footer class="navbar">
    <button class="btn" data-action="goto" data-i="${idx - 1}" ${idx === 0 ? "disabled" : ""}>‹ Previous</button>
    ${isLast
      ? `<button class="btn primary" data-action="finish">${stats.complete ? "See results" : "Finish"}</button>`
      : `<button class="btn primary" data-action="goto" data-i="${idx + 1}">Next ›</button>`}
  </footer>`;
}

function loadingPanel(title, text) {
  return `<section class="card panel"><h3>${title}</h3><div class="loading-row"><div class="spinner small"></div><span class="muted">${text}</span></div></section>`;
}

function errorPanel(title, message, retryAction) {
  return `<section class="card panel"><h3>${title}</h3><p class="error-text">${esc(message)}</p>
    <div class="btn-row"><button class="btn" data-action="${retryAction}">Try again</button>${state.settings.apiKey ? "" : `<button class="btn" data-action="settings">Open Settings</button>`}</div></section>`;
}

function analysisPanel(q, u, answered) {
  const title = "✦ AI Analysis";
  if (u.busy.analysis) return loadingPanel(title, "Analyzing this question… this can take up to a minute.");
  if (u.error.analysis) return errorPanel(title, u.error.analysis, "retry-analysis");
  const a = state.analysis[`${q.id}|${state.settings.lang}`];
  if (!a) return "";
  const showSolution = answered || u.reveal;
  const solution = showSolution
    ? `<h4>Step-by-step solution</h4>
       <div class="prose">${renderFreeText(a.solution)}</div>
       <ul class="choice-notes">${(a.choices || [])
         .map((c) => `<li class="${c.correct ? "ok" : "no"}"><span class="letter">${esc(c.letter)}</span><span>${renderInline(c.reason)}</span></li>`)
         .join("")}</ul>
       <p class="takeaway"><b>Remember:</b> ${renderInline(a.takeaway)}</p>`
    : `<button class="btn block" data-action="reveal">Show the solution (reveals the answer)</button>`;
  return `<section class="card panel">
    <h3>${title}</h3>
    <span class="tag">${esc(a.skill)}</span>
    <h4>Knowledge point</h4>
    <div class="prose">${renderFreeText(a.knowledge_point)}</div>
    <h4>How to tackle it</h4>
    <ol class="steps">${(a.strategy || []).map((s) => `<li>${renderInline(s)}</li>`).join("")}</ol>
    ${solution}
  </section>`;
}

function mockLink(q) {
  const n = (state.mocks[q.id] || []).length;
  return n ? `<button class="link-btn" data-action="show-mocks">View earlier mock questions (${n})</button>` : "";
}

function mockPanel(q, u) {
  const title = "✦ Mock Test";
  if (u.busy.mock) return loadingPanel(title, "Writing a new practice question… this can take up to a minute.");
  if (u.error.mock) return errorPanel(title, u.error.mock, "mock");
  const mocks = state.mocks[q.id] || [];
  if (!mocks.length) return "";
  const i = Math.min(u.mockIdx, mocks.length - 1);
  const m = mocks[i];
  const done = m.pick !== null && m.pick !== undefined;
  const correctIdx = m.options.findIndex((o) => o.correct);

  const pager = mocks.length > 1
    ? `<div class="pager"><button class="icon-btn small" data-action="mock-nav" data-i="${i - 1}" ${i === 0 ? "disabled" : ""} aria-label="Previous mock">‹</button>
       <span>${i + 1} / ${mocks.length}</span>
       <button class="icon-btn small" data-action="mock-nav" data-i="${i + 1}" ${i === mocks.length - 1 ? "disabled" : ""} aria-label="Next mock">›</button></div>`
    : "";

  const options = m.options
    .map((o, k) => {
      let cls = "";
      if (done) cls = k === correctIdx ? "correct" : k === m.pick ? "wrong" : "";
      else if (k === u.mockPick) cls = "selected";
      return `<button class="option ${cls}" data-action="mock-pick" data-i="${k}" ${done ? "disabled" : ""}>
        <span class="letter">${LETTERS[k]}</span>
        <span class="option-text">${renderInline(o.text)}${done ? `<span class="why">${renderInline(o.why)}</span>` : ""}</span>
      </button>`;
    })
    .join("");

  const after = done
    ? `<div class="feedback ${m.pick === correctIdx ? "ok" : "no"}">${m.pick === correctIdx ? "<b>Correct!</b>" : `<b>Not quite.</b> The correct answer is <b>${LETTERS[correctIdx]}</b>.`}</div>
       <h4>Explanation</h4><div class="prose">${renderFreeText(m.explanation)}</div>
       <button class="btn ai block" data-action="mock">✦ Another Mock Test</button>`
    : `<button class="btn primary block" data-action="mock-check" ${u.mockPick === null ? "disabled" : ""}>Check answer</button>`;

  return `<section class="card panel">
    <div class="panel-head"><h3>${title}</h3>${pager}</div>
    <span class="tag">${esc(m.skill || q.category)}</span>
    ${m.passage ? `<div class="passage">${renderFreeText(m.passage)}</div>` : ""}
    <p class="stem">${renderInline(m.question)}</p>
    <div class="options">${options}</div>
    ${after}
  </section>`;
}

function resultView() {
  const set = currentSet();
  if (!set) return homeView();
  const s = setStats(set);
  const pct = s.total ? s.correct / s.total : 0;
  const message = !s.complete
    ? `${s.total - s.answered} question${s.total - s.answered === 1 ? "" : "s"} left to answer.`
    : pct === 1
      ? "Perfect score. Excellent work!"
      : pct >= 0.8
        ? "Great job. Review the ones you missed."
        : pct >= 0.5
          ? "Good effort. Use AI Analysis on the ones you missed."
          : "Keep going. Read the AI Analysis for each missed question, then try a Mock Test.";
  const rows = set.ids
    .map((id, i) => {
      const q = bank.get(id);
      const a = set.ans[id];
      const mark = a ? (a.correct ? `<span class="mark ok">✓</span>` : `<span class="mark no">✗</span>`) : `<span class="mark">–</span>`;
      return `<li><button class="row-btn" data-action="review" data-i="${i}">${mark}<span class="row-main"><b>Question ${i + 1}</b><small>${esc(q.category)}</small></span><span class="chev">›</span></button></li>`;
    })
    .join("");
  const isToday = view.date === todayStr();
  return `${topBar(isToday ? "Results" : prettyDate(view.date, { month: "short", day: "numeric" }), { back: true })}
  <main>
    <section class="card score-card">
      <div class="score"><span>${s.correct}</span><small>/ ${s.total}</small></div>
      <p>${message}</p>
    </section>
    <section class="card"><ul class="history">${rows}</ul></section>
    ${isToday && s.complete ? `<button class="btn block" data-action="extra-set">Practice another ${Math.min(QUIZ_SIZE, bank.size)} questions</button>` : ""}
    <button class="btn primary block" data-action="home">Back to home</button>
  </main>`;
}

function settingsView() {
  const s = state.settings;
  const status = view.status ? `<p class="${view.status.ok ? "ok-text" : "error-text"}">${esc(view.status.text)}</p>` : "";
  return `${topBar("Settings", { back: true })}
  <main>
    <section class="card form">
      <label for="apiKey">Claude API key</label>
      <input id="apiKey" type="password" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="sk-ant-…" value="${esc(s.apiKey)}">
      <p class="muted small">Needed for AI Analysis and Mock Test. The key is saved only on this device and is sent only to Anthropic.</p>

      <label for="model">AI model</label>
      <select id="model">${ai.MODELS.map((m) => `<option value="${m.id}" ${m.id === s.model ? "selected" : ""}>${esc(m.label)}</option>`).join("")}</select>

      <label for="lang">Explanation language</label>
      <select id="lang">
        <option value="en" ${s.lang === "en" ? "selected" : ""}>English</option>
        <option value="zh" ${s.lang === "zh" ? "selected" : ""}>中文 (Chinese)</option>
      </select>

      <div class="btn-row">
        <button class="btn primary" data-action="save-settings">Save</button>
        <button class="btn" data-action="test-key" ${view.testing ? "disabled" : ""}>${view.testing ? "Testing…" : "Save and test"}</button>
      </div>
      ${status}
    </section>
    <section class="card form">
      <h3>Progress</h3>
      <p class="muted small">${bank.size} questions in the bank · ${Object.keys(state.seen).length} answered so far · ${Object.keys(state.analysis).length} analyses saved</p>
      <button class="btn danger" data-action="reset">Reset all progress</button>
    </section>
  </main>`;
}

// ---------- actions ----------

function readSettingsForm() {
  state.settings.apiKey = document.getElementById("apiKey").value.trim();
  state.settings.model = document.getElementById("model").value;
  state.settings.lang = document.getElementById("lang").value;
  save();
}

async function runAnalysis(q, u) {
  const cacheKey = `${q.id}|${state.settings.lang}`;
  if (state.analysis[cacheKey] || u.busy.analysis) return;
  u.busy.analysis = true;
  u.error.analysis = null;
  render();
  try {
    state.analysis[cacheKey] = await ai.analyze(state.settings, q, answerOf(q));
    save();
  } catch (err) {
    u.error.analysis = err.message;
  }
  u.busy.analysis = false;
  render();
}

async function runMock(q, u) {
  if (u.busy.mock) return;
  u.showMock = true;
  u.busy.mock = true;
  u.error.mock = null;
  u.mockPick = null;
  render();
  try {
    const previous = (state.mocks[q.id] || []).map((m) => m.topic).filter(Boolean);
    const mock = await ai.mockQuestion(state.settings, q, previous);
    const list = [...(state.mocks[q.id] || []), { ...mock, pick: null }].slice(-MAX_MOCKS_KEPT);
    state.mocks[q.id] = list;
    u.mockIdx = list.length - 1;
    save();
  } catch (err) {
    u.error.mock = err.message;
  }
  u.busy.mock = false;
  render();
}

async function checkAnswer(set, q, u) {
  if (!u.pick || u.busy.check) return;
  u.error.check = null;
  if (!answerOf(q)) {
    if (!state.settings.apiKey) {
      u.error.check = "This question has no answer key yet. Add your API key in Settings so AI can check it.";
      return render();
    }
    u.busy.check = true;
    render();
    try {
      await resolveKeys([q.id]);
    } catch (err) {
      u.error.check = err.message;
    }
    u.busy.check = false;
    if (!usable(q)) {
      replaceUnusable(set);
      return render();
    }
    if (!answerOf(q)) {
      u.error.check = u.error.check || "Could not check this answer. Please try again.";
      return render();
    }
  }
  const key = answerOf(q);
  set.ans[q.id] = { pick: u.pick, key, correct: u.pick === key };
  state.seen[q.id] = Date.now();
  save();
  render();
}

function openSet(date, setIdx) {
  const set = state.days[date]?.sets[setIdx];
  if (!set) return;
  const s = setStats(set);
  if (s.complete) return go({ name: "result", date, setIdx });
  const firstOpen = set.ids.findIndex((id) => !set.ans[id]);
  prefetchKeys(set);
  go({ name: "quiz", date, setIdx, qIdx: Math.max(firstOpen, 0) });
}

const actions = {
  reload: () => location.reload(),
  back: () => history.back(),
  home: () => go({ name: "home" }),
  settings: () => go({ name: "settings" }),

  "open-set": (d) => openSet(d.date, Number(d.set)),

  "extra-set"() {
    const day = ensureToday();
    const used = new Set(day.sets.flatMap((set) => set.ids));
    day.sets.push(newSet(used));
    save();
    openSet(todayStr(), day.sets.length - 1);
  },

  goto(d) {
    const set = currentSet();
    const i = Number(d.i);
    if (!set || i < 0 || i >= set.ids.length) return;
    go({ ...view, qIdx: i }, { replace: true });
  },

  review: (d) => go({ name: "quiz", date: view.date, setIdx: view.setIdx, qIdx: Number(d.i) }),
  finish: () => go({ name: "result", date: view.date, setIdx: view.setIdx }),

  pick(d) {
    const set = currentSet();
    const id = set.ids[view.qIdx];
    if (set.ans[id]) return;
    ui(id).pick = d.letter;
    render();
  },

  check() {
    const set = currentSet();
    const q = bank.get(set.ids[view.qIdx]);
    checkAnswer(set, q, ui(q.id));
  },

  analysis() {
    const q = bank.get(currentSet().ids[view.qIdx]);
    const u = ui(q.id);
    u.showAnalysis = !u.showAnalysis || !!u.error.analysis;
    render();
    if (u.showAnalysis) runAnalysis(q, u);
  },

  "retry-analysis"() {
    const q = bank.get(currentSet().ids[view.qIdx]);
    runAnalysis(q, ui(q.id));
  },

  reveal() {
    ui(currentSet().ids[view.qIdx]).reveal = true;
    render();
  },

  mock() {
    const q = bank.get(currentSet().ids[view.qIdx]);
    runMock(q, ui(q.id));
  },

  "show-mocks"() {
    const q = bank.get(currentSet().ids[view.qIdx]);
    const u = ui(q.id);
    u.showMock = true;
    u.mockIdx = (state.mocks[q.id] || []).length - 1;
    render();
  },

  "mock-nav"(d) {
    const u = ui(currentSet().ids[view.qIdx]);
    u.mockIdx = Number(d.i);
    u.mockPick = null;
    render();
  },

  "mock-pick"(d) {
    ui(currentSet().ids[view.qIdx]).mockPick = Number(d.i);
    render();
  },

  "mock-check"() {
    const id = currentSet().ids[view.qIdx];
    const u = ui(id);
    const mock = (state.mocks[id] || [])[u.mockIdx];
    if (!mock || u.mockPick === null) return;
    mock.pick = u.mockPick;
    u.mockPick = null;
    save();
    render();
  },

  "save-settings"() {
    readSettingsForm();
    view.status = { ok: true, text: "Saved." };
    render();
  },

  async "test-key"() {
    readSettingsForm();
    view.testing = true;
    view.status = null;
    render();
    try {
      await ai.ping(state.settings);
      view.status = { ok: true, text: "Connection works. AI features are ready." };
    } catch (err) {
      view.status = { ok: false, text: err.message };
    }
    view.testing = false;
    if (view.name === "settings") render();
  },

  reset() {
    if (!confirm("Erase all quiz history, saved analyses and mock questions on this device? Your API key and settings are kept.")) return;
    state = { ...defaults(), settings: state.settings };
    uiState.clear();
    save();
    view.status = { ok: true, text: "Progress erased." };
    render();
  },
};

app.addEventListener("click", (e) => {
  const el = e.target.closest("[data-action]");
  if (!el || el.disabled) return;
  actions[el.dataset.action]?.(el.dataset);
});

// ---------- start ----------

async function boot() {
  render();
  try {
    const [mdRes, keyRes] = await Promise.all([
      fetch("resource/sat_source.md", { cache: "no-cache" }),
      fetch("resource/answer_key.json", { cache: "no-cache" }).catch(() => null),
    ]);
    if (!mdRes.ok) throw new Error("Could not load the question file (resource/sat_source.md).");
    let answerKey = {};
    if (keyRes && keyRes.ok) {
      try {
        answerKey = await keyRes.json();
      } catch {
        console.warn("answer_key.json is not valid JSON; ignoring it");
      }
    }
    const { questions } = parseSource(await mdRes.text());
    bank = new Map(buildBank(questions, answerKey).bank.map((q) => [q.id, q]));
    view = { name: "home" };
  } catch (err) {
    view = { name: "error", message: err.message || "Could not load the app." };
  }
  history.replaceState(view, "");
  render();
}

boot();

if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost")) {
  navigator.serviceWorker.register("sw.js").catch((err) => console.warn("Offline support unavailable", err));
}
