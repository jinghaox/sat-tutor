# SAT Tutor

A phone-friendly web app for daily SAT Reading and Writing practice.

- **10 questions at a time**: picked at random from the questions not completed yet in `resource/sat_source.md`. A new set starts each day, or any time with **↻ New 10 questions**.
- **Completed**: every answered question is archived there, with All / Wrong / Correct filters, so it can be reviewed later with its AI Analysis and Mock Tests.
- **Instant marking**: each answer is checked as soon as it is submitted, with a results page at the end.
- **Charts**: chart questions show the embedded image; tap it to enlarge. The image is also sent to the AI.
- **AI Analysis**: explains the knowledge point a question tests and the best way to tackle it. Generated once per question, then saved and shown instantly afterwards.
- **Mock Test**: AI writes a new, similar question to practise the same skill. Tap again for another one.

Live site: https://jinghaox.github.io/sat-tutor/

## Using it on a phone

1. Open the live site in Chrome on the phone.
2. Menu (⋮) → **Add to Home screen** to install it like an app.
3. Open **Settings** (gear icon), paste a Claude API key, and tap **Save and test**.

The API key and all progress are stored only on that phone. The key is never part of this repository.

## Adding questions

1. Add questions to `resource/sat_source.md` in the same format as the existing ones (`## N. exam name.pdf`, `### 第 N 题`, passage, question, `A.`–`D.` choices, `**答案：X**`, `---`). Charts go on their own line as `![题目所需图表](data:image/webp;base64,...)`.
2. To correct an answer or leave a broken question out, add it to `resource/answer_key.json` (`"exam name": { "question number": "A" }`, or `"skip"`). Questions with no answer at all are solved by AI the first time they come up.
3. Run `npm run check` to see how the file was read, then commit and push.

## Development

```bash
npm install
```

```bash
npm run serve
```

Then open http://localhost:8123. There is no build step for the app itself. `npm run build:sdk` re-bundles the Anthropic SDK into `vendor/` after an SDK upgrade, and `python tools/make_icons.py` redraws the icons.
