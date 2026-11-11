# Agent notes

- Language for code, comments, UI texts, commits and docs: American English.
- No runtime dependencies. The add-on is plain ES modules loaded by Thunderbird directly.
- Decision logic goes into `src/lib/core.js` so `npm test` covers it without Thunderbird.

## Verified for real

A change counts as checked only when:

1. `npm test` passes.
2. `npm run test:e2e` passes in Thunderbird 153 ESR. It sends through a fake SMTP server and checks what actually left Thunderbird (envelope sender, recipients, headers, body).
3. Every touched UI (popup, settings page, compose window) was looked at in screenshots from `E2E_SCREENSHOTS=<dir> npm run test:e2e`.
4. A change to the guard comes with a counter-check: the new e2e check fails when the guard is switched off.

The fake SimpleLogin API in `test/e2e/run.mjs` follows the real one in `docs/api.md` of simple-login/app. Real SimpleLogin behavior, for example the reply-phase checks, remains a manual check with a real account.

## README style

- Centered icon on top, title, bold tagline, one badge row (at most six).
- Every `##` heading starts with an emoji. Fixed ones: ✨ Features,
  📦 Installation, 🚀 Usage, ⚙️ Configuration, 🖼️ Screenshots,
  🩺 Troubleshooting, 💬 Support, 🙏 Credits, 📄 License. Other sections get
  a fitting emoji of their own, never one twice per file.
- Install path first, features as bullets, configuration as a table, one
  screenshot when there is a UI, GitHub alerts for warnings.
- The repository is private, so badges are static shields.io badges; keep
  their values (Thunderbird version, status) in sync with the manifest.
