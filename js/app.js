import { parseSource, buildBank, renderInline, renderPassage, renderFreeText, passageText, escapeHtml as esc } from "./parser.js";
import * as ai from "./ai.js";

const LS_KEY = "sat-tutor-v2";
const OLD_LS_KEY = "sat-tutor-v1";
const QUIZ_SIZE = 10;
const MAX_MOCKS_KEPT = 10;
const LIST_PAGE = 50;
const LETTERS = ["A", "B", "C", "D"];

const app = document.getElementById("app");

// ---------- saved state (this device only) ----------

function defaults() {
  return {
    settings: { apiKey: "", model: ai.DEFAULT_MODEL, lang: "en" },
    current: null, // { ids: [...], date: "YYYY-MM-DD" } — the 10 questions on the home screen
    done: {}, // question id -> { pick, key, correct, at }: every question answered so far
    aiKeys: {}, // question id -> "A".."D" | "skip", for questions with no answer in the source
    analysis: {}, // "id|lang" -> analysis
    mocks: {}, // question id -> [mock question, ...]
  };
}

function loadState() {
  const base = defaults();
  try {
    const saved = JSON.parse(localStorage.getItem(LS_KEY) || "null");
    if (saved) return { ...base, ...saved, settings: { ...base.settings, ...(saved.settings || {}) } };
    // Version 1 numbered questions differently, so only the settings carry over.
    const old = JSON.parse(localStorage.getItem(OLD_LS_KEY) || "null");
    if (old?.settings) base.settings = { ...base.settings, ...old.settings };
  } catch {
    /* start fresh */
  }
  return base;
}

function save() {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(state));
    localStorage.removeItem(OLD_LS_KEY);
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
function dateStr(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function prettyDate(s, opts = { weekday: "long", month: "long", day: "numeric" }) {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-US", opts);
}
function shortTime(ts) {
  return new Date(ts).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

// ---------- question bank and the current set ----------

function answerOf(q) {
  if (q.key) return q.key;
  const k = state.aiKeys[q.id];
  return LETTERS.includes(k) ? k : null;
}
const usable = (q) => q.key || state.aiKeys[q.id] !== "skip";
const isDone = (id) => !!state.done[id];

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// Random questions the student has not completed, avoiding `avoid` when there are enough others.
function pickQuestions(n, avoid = new Set()) {
  const open = [...bank.values()].filter((q) => usable(q) && !isDone(q.id));
  const fresh = shuffle(open.filter((q) => !avoid.has(q.id)));
  const picked = [...fresh, ...shuffle(open.filter((q) => avoid.has(q.id)))].slice(0, n);
  return picked.map((q) => q.id);
}

function refreshSet() {
  const avoid = new Set(state.current?.ids || []);
  state.current = { ids: pickQuestions(QUIZ_SIZE, avoid), date: dateStr() };
  uiState.clear();
  save();
}

// Keeps the current set valid; a new day starts a new set.
function ensureCurrent() {
  const cur = state.current;
  if (cur) cur.ids = cur.ids.filter((id) => bank.has(id));
  if (!cur || !cur.ids.length || cur.date !== dateStr()) refreshSet();
  return state.current;
}

function setStats(ids) {
  const answered = ids.filter(isDone).length;
  const correct = ids.filter((id) => state.done[id]?.correct).length;
  return { total: ids.length, answered, correct, complete: answered === ids.length };
}

function openCount() {
  let n = 0;
  for (const q of bank.values()) if (usable(q) && !isDone(q.id)) n++;
  return n;
}

// Completed questions, newest first, optionally only right or only wrong ones.
function completedIds(filter = "all") {
  return Object.entries(state.done)
    .filter(([id, d]) => bank.has(id) && (filter === "all" || (filter === "wrong" ? !d.correct : d.correct)))
    .sort((a, b) => b[1].at - a[1].at)
    .map(([id]) => id);
}

// ---------- answer keys from AI, for questions the source does not answer ----------

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
function replaceUnusable() {
  const ids = state.current.ids;
  let changed = false;
  ids.forEach((id, i) => {
    const q = bank.get(id);
    if (q && !usable(q) && !isDone(id)) {
      const [fresh] = pickQuestions(1, new Set(ids));
      if (fresh && !ids.includes(fresh)) {
        ids[i] = fresh;
        changed = true;
      }
    }
  });
  if (changed) save();
  return changed;
}

function prefetchKeys() {
  const ids = state.current.ids;
  if (ids.every((id) => bank.get(id)?.key)) return;
  resolveKeys(ids)
    .then(() => {
      if (replaceUnusable()) {
        render();
        prefetchKeys();
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
  const views = {
    loading: loadingView,
    error: errorView,
    home: homeView,
    quiz: quizView,
    result: resultView,
    completed: completedView,
    review: reviewView,
    settings: settingsView,
  };
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

function homeView() {
  if (!bank.size) {
    return `${topBar("SAT Tutor", { settings: true })}<main><section class="card"><h2>No questions found</h2><p class="muted">Add questions to <code>resource/sat_source.md</code> and reload.</p></section></main>`;
  }
  const cur = ensureCurrent();
  const s = setStats(cur.ids);
  const doneCount = completedIds().length;
  const left = openCount();
  const correctTotal = Object.entries(state.done).filter(([id, d]) => bank.has(id) && d.correct).length;

  const setCard = cur.ids.length
    ? `<section class="card hero">
        <div class="eyebrow">${esc(prettyDate(cur.date))}</div>
        <h2>Your 10 questions</h2>
        <p class="muted">${s.total} questions · Reading and Writing</p>
        ${progressBar(s)}
        <p class="stat-line">${s.answered ? `${s.answered} of ${s.total} answered · ${s.correct} correct` : "Not started yet"}</p>
        <button class="btn primary block" data-action="open-set">${!s.answered ? "Start quiz" : s.complete ? "See results" : "Continue quiz"}</button>
      </section>`
    : `<section class="card hero"><h2>All done!</h2><p class="muted">You have completed every question in the bank. Review them under Completed.</p></section>`;

  const keyHint = state.settings.apiKey
    ? ""
    : `<section class="card notice"><p><b>AI features are off.</b> Add your API key in Settings to turn on AI Analysis and Mock Test.</p><button class="btn" data-action="settings">Open Settings</button></section>`;

  return `${topBar("SAT Tutor", { settings: true })}
  <main>
    ${setCard}
    <div class="btn-row">
      <button class="btn" data-action="refresh" ${left ? "" : "disabled"}>↻ New 10 questions</button>
      <button class="btn" data-action="completed">✓ Completed (${doneCount})</button>
    </div>
    <section class="card stats">
      <div><b>${doneCount}</b><small>completed</small></div>
      <div><b>${left}</b><small>to go</small></div>
      <div><b>${doneCount ? Math.round((correctTotal / doneCount) * 100) + "%" : "–"}</b><small>accuracy</small></div>
    </section>
    ${keyHint}
  </main>`;
}

function optionButtons(q, { pick, answer, disabled }) {
  return `<div class="options">${LETTERS.map((l) => {
    let cls = "";
    if (answer) {
      if (l === answer.key) cls = "correct";
      else if (l === answer.pick) cls = "wrong";
    } else if (l === pick) cls = "selected";
    return `<button class="option ${cls}" data-action="pick" data-letter="${l}" ${disabled ? "disabled" : ""}>
      <span class="letter">${l}</span><span class="option-text">${renderInline(q.options[l])}</span>
    </button>`;
  }).join("")}</div>`;
}

// The question card plus its AI panels; shared by the quiz and the Completed review.
function questionBody(q) {
  const u = ui(q.id);
  const answer = state.done[q.id];
  const feedback = answer
    ? answer.correct
      ? `<div class="feedback ok"><b>Correct!</b></div>`
      : `<div class="feedback no"><b>Not quite.</b> You chose <b>${answer.pick}</b>; the correct answer is <b>${answer.key}</b>.</div>`
    : "";
  const checkError = u.error.check ? `<p class="error-text">${esc(u.error.check)}</p>` : "";
  const actions = answer
    ? `<div class="btn-row">
        <button class="btn ai ${u.showAnalysis ? "active" : ""}" data-action="analysis">✦ AI Analysis</button>
        <button class="btn ai" data-action="mock" ${u.busy.mock ? "disabled" : ""}>✦ Mock Test</button>
      </div>`
    : `<button class="btn primary block" data-action="check" ${u.pick && !u.busy.check ? "" : "disabled"}>${u.busy.check ? "Checking…" : "Check answer"}</button>
       <button class="btn ai block ${u.showAnalysis ? "active" : ""}" data-action="analysis">✦ AI Analysis</button>`;
  return `<article class="card question">
      <div class="q-meta"><span class="tag">${esc(q.category)}</span><span class="source">${esc(q.doc)} · #${q.page}</span></div>
      ${q.passage.length ? `<div class="passage">${renderPassage(q.passage)}</div>` : ""}
      <p class="stem">${renderInline(q.stem)}</p>
      ${optionButtons(q, { pick: u.pick, answer, disabled: !!answer || u.busy.check })}
      ${feedback}
      ${checkError}
      ${actions}
    </article>
    ${u.showAnalysis ? analysisPanel(q, u, !!answer) : ""}
    ${u.showMock ? mockPanel(q, u) : mockLink(q)}`;
}

function quizView() {
  const ids = state.current?.ids || [];
  if (!ids.length) return homeView();
  const idx = Math.min(view.qIdx, ids.length - 1);
  const q = bank.get(ids[idx]);
  const stats = setStats(ids);

  const pills = ids
    .map((qid, i) => {
      const a = state.done[qid];
      const cls = [i === idx ? "current" : "", a ? (a.correct ? "ok" : "no") : ""].join(" ");
      return `<button class="pill ${cls}" data-action="goto" data-i="${i}" aria-label="Question ${i + 1}">${i + 1}</button>`;
    })
    .join("");

  const isLast = idx === ids.length - 1;
  return `${topBar(`Question ${idx + 1} of ${ids.length}`, { back: true })}
  <main class="quiz">
    <nav class="pills" aria-label="Questions">${pills}</nav>
    ${questionBody(q)}
  </main>
  <footer class="navbar">
    <button class="btn" data-action="goto" data-i="${idx - 1}" ${idx === 0 ? "disabled" : ""}>‹ Previous</button>
    ${isLast
      ? `<button class="btn primary" data-action="finish">${stats.complete ? "See results" : "Finish"}</button>`
      : `<button class="btn primary" data-action="goto" data-i="${idx + 1}">Next ›</button>`}
  </footer>`;
}

function reviewView() {
  const list = completedIds(view.filter);
  const idx = list.indexOf(view.id);
  const q = bank.get(view.id);
  if (!q) return completedView();
  const done = state.done[q.id];
  return `${topBar(idx >= 0 ? `Completed ${idx + 1} of ${list.length}` : "Completed", { back: true })}
  <main class="quiz">
    <p class="muted small">Answered ${esc(shortTime(done?.at || Date.now()))}</p>
    ${questionBody(q)}
  </main>
  <footer class="navbar">
    <button class="btn" data-action="review-nav" data-id="${esc(list[idx - 1] || "")}" ${idx > 0 ? "" : "disabled"}>‹ Newer</button>
    <button class="btn" data-action="review-nav" data-id="${esc(list[idx + 1] || "")}" ${idx >= 0 && idx < list.length - 1 ? "" : "disabled"}>Older ›</button>
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
  const ids = state.current?.ids || [];
  if (!ids.length) return homeView();
  const s = setStats(ids);
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
  const rows = ids
    .map((id, i) => {
      const q = bank.get(id);
      const a = state.done[id];
      const mark = a ? (a.correct ? `<span class="mark ok">✓</span>` : `<span class="mark no">✗</span>`) : `<span class="mark">–</span>`;
      return `<li><button class="row-btn" data-action="goto-quiz" data-i="${i}">${mark}<span class="row-main"><b>Question ${i + 1}</b><small>${esc(q.category)}</small></span><span class="chev">›</span></button></li>`;
    })
    .join("");
  return `${topBar("Results", { back: true })}
  <main>
    <section class="card score-card">
      <div class="score"><span>${s.correct}</span><small>/ ${s.total}</small></div>
      <p>${message}</p>
    </section>
    <section class="card"><ul class="history">${rows}</ul></section>
    ${openCount() ? `<button class="btn primary block" data-action="refresh">↻ New 10 questions</button>` : ""}
    <button class="btn block" data-action="home">Back to home</button>
  </main>`;
}

function snippet(q) {
  const text = (passageText(q.passage) || q.stem).replace(/\*\*/g, "").replace(/`?_{3,}`?/g, "____");
  return text.length > 110 ? text.slice(0, 110).trimEnd() + "…" : text;
}

function completedView() {
  const filter = view.filter || "all";
  const all = completedIds();
  const list = completedIds(filter);
  const wrong = all.filter((id) => !state.done[id].correct).length;
  const limit = view.limit || LIST_PAGE;
  const tab = (key, label) =>
    `<button class="seg ${filter === key ? "on" : ""}" data-action="filter" data-filter="${key}">${label}</button>`;
  const rows = list
    .slice(0, limit)
    .map((id) => {
      const q = bank.get(id);
      const d = state.done[id];
      return `<li><button class="row-btn" data-action="review" data-id="${esc(id)}">
        <span class="mark ${d.correct ? "ok" : "no"}">${d.correct ? "✓" : "✗"}</span>
        <span class="row-main"><b>${esc(q.category)}</b><small>${esc(snippet(q))}</small></span>
        <span class="row-date">${esc(shortTime(d.at))}</span>
      </button></li>`;
    })
    .join("");
  const empty = !list.length
    ? `<p class="muted center-text">${all.length ? "Nothing here yet." : "Questions you answer will be saved here."}</p>`
    : "";
  return `${topBar("Completed", { back: true })}
  <main>
    <div class="segmented">${tab("all", `All (${all.length})`)}${tab("wrong", `Wrong (${wrong})`)}${tab("correct", `Correct (${all.length - wrong})`)}</div>
    ${list.length ? `<section class="card"><ul class="history">${rows}</ul></section>` : empty}
    ${list.length > limit ? `<button class="btn block" data-action="more">Show more (${list.length - limit} left)</button>` : ""}
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
      <p class="muted small">${bank.size} questions in the bank · ${completedIds().length} completed · ${Object.keys(state.analysis).length} analyses saved</p>
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

// The question shown on the quiz or review screen.
function activeQuestion() {
  if (view.name === "review") return bank.get(view.id);
  const ids = state.current?.ids || [];
  return bank.get(ids[Math.min(view.qIdx ?? 0, ids.length - 1)]);
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

async function checkAnswer(q, u) {
  if (!u.pick || u.busy.check || isDone(q.id)) return;
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
      replaceUnusable();
      return render();
    }
    if (!answerOf(q)) {
      u.error.check = u.error.check || "Could not check this answer. Please try again.";
      return render();
    }
  }
  const key = answerOf(q);
  state.done[q.id] = { pick: u.pick, key, correct: u.pick === key, at: Date.now() };
  save();
  render();
}

function openSet() {
  const ids = ensureCurrent().ids;
  if (setStats(ids).complete) return go({ name: "result" });
  prefetchKeys();
  go({ name: "quiz", qIdx: Math.max(ids.findIndex((id) => !isDone(id)), 0) });
}

const actions = {
  reload: () => location.reload(),

  // Full-size chart view; the viewer pinch-zooms and scrolls it like any page.
  zoom(d, el) {
    const src = el.querySelector("img")?.src;
    if (!src) return;
    const box = document.createElement("div");
    box.className = "zoom";
    box.innerHTML = `<button class="icon-btn zoom-close" aria-label="Close">✕</button><div class="zoom-scroll"><img alt="Enlarged chart"></div>`;
    box.querySelector("img").src = src;
    box.addEventListener("click", (e) => {
      if (e.target.closest(".zoom-close") || !e.target.closest("img")) box.remove();
    });
    document.body.appendChild(box);
  },
  back: () => history.back(),
  home: () => go({ name: "home" }),
  settings: () => go({ name: "settings" }),

  "open-set": openSet,

  refresh() {
    refreshSet();
    if (view.name === "home") render();
    else go({ name: "home" }, { replace: true });
  },

  completed: () => go({ name: "completed", filter: "all" }),
  filter: (d) => go({ name: "completed", filter: d.filter }, { replace: true }),
  more() {
    view.limit = (view.limit || LIST_PAGE) + LIST_PAGE;
    history.replaceState(view, "");
    render();
  },
  review: (d) => go({ name: "review", id: d.id, filter: view.filter || "all" }),
  "review-nav"(d) {
    if (d.id) go({ ...view, id: d.id }, { replace: true });
  },

  goto(d) {
    const i = Number(d.i);
    if (i < 0 || i >= (state.current?.ids.length || 0)) return;
    go({ name: "quiz", qIdx: i }, { replace: true });
  },
  "goto-quiz": (d) => go({ name: "quiz", qIdx: Number(d.i) }),
  finish: () => go({ name: "result" }),

  pick(d) {
    const q = activeQuestion();
    if (!q || isDone(q.id)) return;
    ui(q.id).pick = d.letter;
    render();
  },

  check() {
    const q = activeQuestion();
    if (q) checkAnswer(q, ui(q.id));
  },

  analysis() {
    const q = activeQuestion();
    const u = ui(q.id);
    u.showAnalysis = !u.showAnalysis || !!u.error.analysis;
    render();
    if (u.showAnalysis) runAnalysis(q, u);
  },

  "retry-analysis"() {
    const q = activeQuestion();
    runAnalysis(q, ui(q.id));
  },

  reveal() {
    ui(activeQuestion().id).reveal = true;
    render();
  },

  mock() {
    const q = activeQuestion();
    runMock(q, ui(q.id));
  },

  "show-mocks"() {
    const q = activeQuestion();
    const u = ui(q.id);
    u.showMock = true;
    u.mockIdx = (state.mocks[q.id] || []).length - 1;
    render();
  },

  "mock-nav"(d) {
    const u = ui(activeQuestion().id);
    u.mockIdx = Number(d.i);
    u.mockPick = null;
    render();
  },

  "mock-pick"(d) {
    ui(activeQuestion().id).mockPick = Number(d.i);
    render();
  },

  "mock-check"() {
    const id = activeQuestion().id;
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
    if (!confirm("Erase all completed questions, saved analyses and mock questions on this device? Your API key and settings are kept.")) return;
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
  actions[el.dataset.action]?.(el.dataset, el);
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
