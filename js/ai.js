// All Claude API calls: AI Analysis, Mock Test, and answer-key lookup.
// The API key lives only in this browser (Settings) and is sent only to Anthropic.
import Anthropic from "../vendor/anthropic-sdk.js";
import { questionText } from "./parser.js";

export const MODELS = [
  { id: "claude-opus-5-5", label: "Claude Opus 5.5 (recommended)" },
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5 (faster, lower cost)" },
  { id: "claude-haiku-5-5", label: "Claude Haiku 5.5 (fastest, lowest cost)" },
  { id: "claude-fable-5-2", label: "Claude Fable 5.2 (most capable, highest cost)" },
];
export const DEFAULT_MODEL = "claude-opus-5-5";

// Models where a declined request can be re-run automatically on another model.
const FALLBACK_MODELS = new Set(["claude-opus-5-5", "claude-sonnet-5-5", "claude-fable-5-2"]);
const FALLBACK_BETA = "server-side-fallback-2026-07-01";

const LETTERS = ["A", "B", "C", "D"];

const TUTOR = `You are an expert SAT Reading and Writing tutor working one-on-one with a high-school student who is preparing for the digital SAT. You know the official question types (Words in Context, Text Structure and Purpose, Cross-Text Connections, Central Ideas and Details, Command of Evidence, Inferences, Boundaries, Form/Structure/Sense, Transitions, Rhetorical Synthesis) and the fastest reliable way to solve each one.

The questions you are shown were scanned from paper, so they may contain small scanning mistakes (a missing letter, a stray symbol, a blank written as ______). Read past these the way a careful teacher would and do not comment on them unless they change the answer.`;

function languageRule(lang) {
  return lang === "zh"
    ? "Write every explanation in Simplified Chinese (简体中文). Keep words, phrases and answer choices quoted from the question in their original English."
    : "Write in clear, plain English that a high-school student can follow. Explain any grammar term you use.";
}

class AiError extends Error {}

function friendlyError(err) {
  if (err instanceof AiError) return err;
  if (err instanceof Anthropic.AuthenticationError) return new AiError("The API key was rejected. Check it in Settings.");
  if (err instanceof Anthropic.PermissionDeniedError) return new AiError("This API key is not allowed to use the selected model. Try another model in Settings.");
  if (err instanceof Anthropic.NotFoundError) return new AiError("The selected model is not available for this API key. Try another model in Settings.");
  if (err instanceof Anthropic.RateLimitError) return new AiError("Too many requests right now. Wait a moment and try again.");
  if (err instanceof Anthropic.BadRequestError) return new AiError("The AI service rejected the request: " + err.message);
  if (err instanceof Anthropic.APIConnectionError) return new AiError("Could not reach the AI service. Check the internet connection and try again.");
  if (err instanceof Anthropic.APIError) return new AiError(`The AI service returned an error (${err.status ?? "unknown"}). Try again in a moment.`);
  return new AiError(err?.message || "Something went wrong. Please try again.");
}

function clientFor(settings) {
  if (!settings.apiKey) throw new AiError("Add your API key in Settings to use the AI features.");
  // The key is typed in by the person using this device and stored only on it.
  return new Anthropic({ apiKey: settings.apiKey, dangerouslyAllowBrowser: true });
}

async function callJSON(settings, { system, user, schema, effort }) {
  const client = clientFor(settings);
  const model = settings.model || DEFAULT_MODEL;
  const params = {
    model,
    max_tokens: 16000,
    system,
    messages: [{ role: "user", content: user }],
    output_config: { effort, format: { type: "json_schema", schema } },
  };

  let message;
  try {
    message = FALLBACK_MODELS.has(model)
      ? await client.beta.messages.create({ ...params, betas: [FALLBACK_BETA], fallbacks: "default" })
      : await client.messages.create(params);
  } catch (err) {
    throw friendlyError(err);
  }

  if (message.stop_reason === "refusal") throw new AiError("The AI declined to answer this one. Try again or pick another model in Settings.");
  if (message.stop_reason === "max_tokens") throw new AiError("The AI answer was cut off. Please try again.");

  const text = message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
  try {
    return JSON.parse(text);
  } catch {
    throw new AiError("The AI returned an answer that could not be read. Please try again.");
  }
}

// ---------- AI Analysis ----------

const ANALYSIS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["skill", "knowledge_point", "strategy", "solution", "choices", "correct_answer", "takeaway"],
  properties: {
    skill: { type: "string", description: "Official SAT question type, e.g. 'Words in Context' or 'Boundaries (punctuation)'." },
    knowledge_point: { type: "string", description: "What this question tests and the rule or idea the student must know. 2-4 sentences. Must not reveal which choice is correct." },
    strategy: {
      type: "array",
      items: { type: "string" },
      description: "3-5 short steps: the best way to tackle this type of question, phrased so the student can reuse them. Must not reveal which choice is correct.",
    },
    solution: { type: "string", description: "Those steps applied to this exact question, ending at the correct answer." },
    choices: {
      type: "array",
      description: "One entry per answer choice, in order A, B, C, D.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["letter", "correct", "reason"],
        properties: {
          letter: { type: "string", enum: LETTERS },
          correct: { type: "boolean" },
          reason: { type: "string", description: "One or two sentences: why this choice is right, or the specific trap that makes it wrong." },
        },
      },
    },
    correct_answer: { type: "string", enum: LETTERS },
    takeaway: { type: "string", description: "One sentence the student should remember for the next question of this type." },
  },
};

/** Explains what a question tests and how to solve it. */
export async function analyze(settings, question, knownAnswer) {
  const keyLine = knownAnswer
    ? `The answer key gives ${knownAnswer} as the correct answer. Build the explanation around that answer.`
    : "There is no answer key for this question, so work out the correct answer yourself first.";
  const user = `Here is an SAT Reading and Writing question. Words wrapped in **double asterisks** are underlined on the test.

<question>
${questionText(question)}
</question>

${keyLine}

Explain this question to the student: which knowledge point it tests, the best way to tackle questions of this type, how that approach plays out on this question, and why each choice is right or wrong. The student sees the knowledge point and strategy before the solution, sometimes before they have answered, so keep the answer out of those two parts.

${languageRule(settings.lang)}`;
  return callJSON(settings, { system: TUTOR, user, schema: ANALYSIS_SCHEMA, effort: "medium" });
}

// ---------- Mock Test ----------

const MOCK_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["topic", "skill", "passage", "question", "options", "explanation"],
  properties: {
    topic: { type: "string", description: "The passage's subject in 2-5 words, e.g. 'coral reef bleaching'." },
    skill: { type: "string", description: "Official SAT question type being practised." },
    passage: { type: "string", description: "The text the student reads. Use ______ for a blank. For student-notes questions, put each note on its own line starting with '• '. Empty string only if the original question has no passage." },
    question: { type: "string", description: "The question stem, worded the way the real SAT words it." },
    options: {
      type: "array",
      description: "Exactly four answer choices, exactly one of them correct. No letter labels: the app adds A-D and shuffles the order.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["text", "correct", "why"],
        properties: {
          text: { type: "string" },
          correct: { type: "boolean" },
          why: { type: "string", description: "One or two sentences on why this choice is right or wrong. Do not refer to choices by letter." },
        },
      },
    },
    explanation: { type: "string", description: "A short walk-through of how to reach the correct answer. Do not refer to choices by letter." },
  },
};

/** Writes a new practice question that tests the same skill as `question`. */
export async function mockQuestion(settings, question, previousTopics = []) {
  const avoid = previousTopics.length
    ? `The student has already practised with passages about: ${previousTopics.join("; ")}. Choose a clearly different subject.`
    : "";
  const user = `Here is an SAT Reading and Writing question the student just worked on. Words wrapped in **double asterisks** are underlined on the test.

<question>
${questionText(question)}
</question>

Write one new, original practice question that tests the same skill in the same format and at the same difficulty, so the student can try the skill again on fresh material. Use a different subject and a newly written passage of similar length, with realistic SAT-style content (science, history, the arts, literature). The wrong choices should be tempting in the same ways the real test's are, and exactly one choice must be defensibly correct. ${avoid}

Write the passage, question and choices in English, as on the real test. For the explanations: ${languageRule(settings.lang)}`;

  const mock = await callJSON(settings, { system: TUTOR, user, schema: MOCK_SCHEMA, effort: "medium" });
  const options = Array.isArray(mock.options) ? mock.options : [];
  if (options.length !== 4 || options.filter((o) => o.correct).length !== 1) {
    throw new AiError("The AI wrote a question without exactly one correct answer. Tap Mock Test to try again.");
  }
  // Shuffle so the correct answer is not predictably in one position.
  for (let i = options.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [options[i], options[j]] = [options[j], options[i]];
  }
  return { ...mock, options };
}

// ---------- Answer key for questions that have none ----------

const SOLVE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["results"],
  properties: {
    results: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["number", "usable", "answer"],
        properties: {
          number: { type: "integer", description: "The question's number as given." },
          usable: { type: "boolean", description: "False only if scanning damage makes the question impossible to answer with confidence, e.g. two choices are identical or the correct choice is missing." },
          answer: { type: "string", enum: LETTERS },
        },
      },
    },
  },
};

/** Returns a Map of question id -> "A".."D", or "skip" for unusable questions. */
export async function solve(settings, questions) {
  const body = questions.map((q, i) => `<question number="${i + 1}">\n${questionText(q)}\n</question>`).join("\n\n");
  const user = `These SAT Reading and Writing questions have no answer key. The student's work will be marked against your answers, so solve each one carefully. Words wrapped in **double asterisks** are underlined on the test.

${body}

For each question give the single best answer. Mark a question as not usable only when scanning damage means no choice can be confidently called correct.`;
  const out = await callJSON(settings, { system: TUTOR, user, schema: SOLVE_SCHEMA, effort: "high" });
  const map = new Map();
  for (const r of out.results || []) {
    const q = questions[r.number - 1];
    if (q) map.set(q.id, r.usable === false ? "skip" : r.answer);
  }
  return map;
}

/** Tiny request used by the "Test connection" button in Settings. */
export async function ping(settings) {
  const client = clientFor(settings);
  try {
    await client.messages.create({
      model: settings.model || DEFAULT_MODEL,
      max_tokens: 256,
      output_config: { effort: "low" },
      messages: [{ role: "user", content: "Reply with the single word: ready" }],
    });
  } catch (err) {
    throw friendlyError(err);
  }
}
