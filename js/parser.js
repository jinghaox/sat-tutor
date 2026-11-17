// Turns resource/sat_source.md into question objects.
//
// Expected shape of the source (markdown, optionally backslash-escaped):
//   ## 1. <exam name>.pdf
//   ### 原 PDF 第 N 页        <- one question per page
//   <passage paragraphs>
//   <question stem>
//   A. ...  B. ...  C. ...  D. ...
//   ---

const UNESCAPE = /\\([\\`*_{}\[\]()#+\-.!|>~])/g;
const LETTERS = ["A", "B", "C", "D"];
const ABBREVIATIONS = /^(Mr|Mrs|Ms|Dr|St|Jr|Sr|Prof|vs|etc|No|U\.S|U\.K)$/;

export function parseSource(md) {
  const lines = md.replace(/\r\n?/g, "\n").replace(UNESCAPE, "$1").split("\n");
  const blocks = [];
  let doc = "";
  let cur = null;
  let counter = 0;

  const flush = () => {
    if (cur && cur.lines.length) blocks.push(cur);
    cur = null;
  };
  const start = (page) => {
    flush();
    counter += 1;
    cur = { doc, page: page ?? counter, lines: [] };
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    let m;
    if ((m = line.match(/^###\s+(.*)$/))) {
      const n = m[1].match(/(\d+)/);
      start(n ? Number(n[1]) : null);
    } else if ((m = line.match(/^##\s+(?:\d+\.\s*)?(.+)$/))) {
      flush();
      doc = m[1].replace(/\.pdf$/i, "").trim();
      counter = 0;
    } else if (/^#\s/.test(line)) {
      flush();
    } else if (/^-{3,}$/.test(line)) {
      flush();
    } else if (/^\[[^\]]*\]\([^)]*\)$/.test(line)) {
      // "[查看原页](file.pdf#page=N)" link back to the PDF: not part of the question
    } else {
      if (!cur) start(null);
      cur.lines.push(line);
    }
  }
  flush();

  const questions = [];
  let rejected = 0;
  for (const b of blocks) {
    const q = toQuestion(b);
    if (q) questions.push(q);
    else rejected += 1;
  }
  return { questions, rejected };
}

function toQuestion(block) {
  const pre = [];
  const options = {};
  let current = null;
  for (const line of block.lines) {
    const expected = LETTERS[Object.keys(options).length];
    const m = line.match(/^([A-D])[.)](?:\s+(.*))?$/);
    if (m && m[1] === expected) {
      options[m[1]] = (m[2] || "").replace(/^[)\]]\s*/, "").trim();
      current = m[1];
    } else if (current) {
      options[current] += " " + line;
    } else {
      pre.push(line);
    }
  }
  if (LETTERS.some((l) => !options[l]) || pre.length === 0) return null;

  const stem = pre.pop();
  const passage = buildPassage(pre);
  const doc = block.doc || "Questions";
  return {
    id: `${doc}#${block.page}`,
    doc,
    page: block.page,
    passage,
    stem,
    options,
    category: categorize(stem, pre.join(" ")),
  };
}

// Student-notes questions list their notes as bullets on the real test, but the
// source runs them together into paragraphs, so split those back into bullets.
function buildPassage(paragraphs) {
  const out = [];
  let inNotes = false;
  for (const text of paragraphs) {
    if (inNotes) {
      const items = splitSentences(text);
      const last = out[out.length - 1];
      if (last && last.type === "ul") last.items.push(...items);
      else out.push({ type: "ul", items });
    } else {
      out.push({ type: "p", text });
      if (/following notes:?$/i.test(text)) inNotes = true;
    }
  }
  return out;
}

export function splitSentences(text) {
  const out = [];
  const re = /[.!?]["”’)]*\s+(?=["“(]?[A-Z])/g;
  let start = 0;
  let m;
  while ((m = re.exec(text))) {
    const lastWord = text.slice(start, m.index).split(/\s+/).pop() || "";
    if (/^[A-Z]$/.test(lastWord) || ABBREVIATIONS.test(lastWord)) continue;
    out.push(text.slice(start, m.index + m[0].trimEnd().length).trim());
    start = m.index + m[0].length;
  }
  const rest = text.slice(start).trim();
  if (rest) out.push(rest);
  return out;
}

export function categorize(stem, passage = "") {
  const s = stem.toLowerCase();
  if (/text 1/i.test(passage) && /text 2/i.test(passage)) return "Cross-Text Connections";
  if (s.includes("most nearly mean") || s.includes("logical and precise word")) return "Words in Context";
  if (s.includes("conventions of standard english")) return "Standard English Conventions";
  if (s.includes("logical transition")) return "Transitions";
  if (s.includes("from the notes") || s.includes("from the given sentences")) return "Rhetorical Synthesis";
  if (s.includes("most logically completes")) return "Inferences";
  if (/main (idea|purpose)|overall structure|function of/.test(s)) return /main idea/.test(s) ? "Central Ideas and Details" : "Text Structure and Purpose";
  if (/support|weaken|undermine|data from|graph|table|illustrate/.test(s)) return "Command of Evidence";
  if (/according to the text|based on the text|best states/.test(s)) return "Central Ideas and Details";
  return "Reading and Writing";
}

// Letters and digits only: used to spot the same question scanned twice.
export function fingerprint(q) {
  return (passageText(q.passage) + q.stem).toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Applies the answer key and drops skipped / duplicate questions. */
export function buildBank(questions, answerKey = {}) {
  const bank = [];
  const seen = new Set();
  let dropped = 0;
  for (const q of questions) {
    const raw = answerKey[q.doc]?.[String(q.page)];
    const key = typeof raw === "string" ? raw.trim().toUpperCase() : "";
    if (key === "SKIP") {
      dropped += 1;
      continue;
    }
    const fp = fingerprint(q);
    if (seen.has(fp)) {
      dropped += 1;
      continue;
    }
    seen.add(fp);
    bank.push({ ...q, key: LETTERS.includes(key) ? key : null });
  }
  return { bank, dropped };
}

// ---------- text helpers shared by the UI and the AI prompts ----------

export function passageText(passage) {
  return passage
    .map((b) => (b.type === "ul" ? b.items.map((i) => "• " + i).join("\n") : b.text))
    .join("\n\n");
}

/** Plain-text version of a question for an AI prompt. */
export function questionText(q) {
  const clean = (t) => t.replace(/`?_{3,}`?/g, "______");
  const parts = [];
  if (q.passage.length) parts.push(clean(passageText(q.passage)));
  parts.push("Question: " + clean(q.stem));
  parts.push(LETTERS.map((l) => `${l}. ${clean(q.options[l])}`).join("\n"));
  return parts.join("\n\n");
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/** Escapes text, then renders blanks (______) and **underlined** words. */
export function renderInline(text) {
  return escapeHtml(text)
    .replace(/`?_{3,}`?/g, '<span class="blank" aria-label="blank"></span>')
    .replace(/\*\*(.+?)\*\*/g, "<u>$1</u>");
}

/** Renders a parsed passage (array of paragraph / bullet-list blocks). */
export function renderPassage(passage) {
  return passage
    .map((b) =>
      b.type === "ul"
        ? `<ul>${b.items.map((i) => `<li>${renderInline(i)}</li>`).join("")}</ul>`
        : `<p>${renderInline(b.text)}</p>`
    )
    .join("");
}

/** Renders free text from the AI: blank lines split paragraphs, "•"/"-" lines become bullets. */
export function renderFreeText(text) {
  const blocks = [];
  for (const raw of String(text).split(/\n+/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(/^(?:[•\-*–]|\d+[.)])\s+(.*)$/);
    const last = blocks[blocks.length - 1];
    if (m) {
      if (last && last.type === "ul") last.items.push(m[1]);
      else blocks.push({ type: "ul", items: [m[1]] });
    } else {
      blocks.push({ type: "p", text: line });
    }
  }
  return renderPassage(blocks);
}
