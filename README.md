# SAT Tutor

A phone-friendly web app for daily SAT Reading and Writing practice.

- **Daily quiz**: 10 questions picked at random each day from `resource/sat_source.md`, favouring questions not answered yet.
- **Instant marking**: each answer is checked as soon as it is submitted, with a results page at the end.
- **AI Analysis**: explains the knowledge point a question tests and the best way to tackle it. Generated once per question, then saved and shown instantly afterwards.
- **Mock Test**: AI writes a new, similar question to practise the same skill. Tap again for another one.

Live site: https://jinghaox.github.io/sat-tutor/

## Using it on a phone

1. Open the live site in Chrome on the phone.
2. Menu (⋮) → **Add to Home screen** to install it like an app.
3. Open **Settings** (gear icon), paste a Claude API key, and tap **Save and test**.

The API key and all progress are stored only on that phone. The key is never part of this repository.

## Adding questions

1. Add questions to `resource/sat_source.md` in the same format as the existing ones (`## exam name`, `### 原 PDF 第 N 页`, passage, question, `A.`–`D.` choices, `---`).
2. Optionally add answers to `resource/answer_key.json` (`"exam name": { "page": "A" }`). Use `"skip"` to leave a broken question out. Questions without an entry are solved by AI the first time they come up.
3. Run `npm run check` to see how the file was read, then commit and push.

## Development

```bash
npm install
```

```bash
npm run serve
```

Then open http://localhost:8123. There is no build step for the app itself. `npm run build:sdk` re-bundles the Anthropic SDK into `vendor/` after an SDK upgrade, and `python tools/make_icons.py` redraws the icons.
