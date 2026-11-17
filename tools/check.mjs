// Parses the question source and prints a summary: `npm run check`
import fs from "node:fs";
import { parseSource, buildBank, questionText } from "../js/parser.js";

const md = fs.readFileSync("./resource/sat_source.md", "utf8");
const key = fs.existsSync("./resource/answer_key.json")
  ? JSON.parse(fs.readFileSync("./resource/answer_key.json", "utf8"))
  : {};

const { questions, rejected } = parseSource(md);
const { bank, dropped } = buildBank(questions, key);

console.log(`parsed ${questions.length} questions (${rejected} blocks rejected)`);
console.log(`bank: ${bank.length} usable (${dropped} skipped or duplicate)`);
console.log(`without answer key: ${bank.filter((q) => !q.key).length}`);
for (const q of bank) {
  console.log(`\n[${q.id}] ${q.category} — key ${q.key ?? "?"}`);
  if (process.argv.includes("--full")) console.log(questionText(q));
  else console.log("  " + q.stem.slice(0, 90));
}
