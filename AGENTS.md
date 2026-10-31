# State CV Agent Instructions

## Start here

- Read `plan.md` at the repo root before starting work. It is the master plan: roadmap, current phase, decisions, and notes for AI assistants. It is kept local and is not committed (see `.gitignore`), so it may be missing in a fresh clone; if it is, ask the owner for it rather than guessing the current phase.
- Read [PRIVACY.md](PRIVACY.md) before changing anything that touches data handling, and [README.md](README.md) for supported behavior.
- Work on one sub-phase at a time, on its own branch. Do not start work outside the current sub-phase without approval.

## Project profile

- State CV is a local-first, privacy-first ATS CV builder by Native State Tools.
- Vanilla HTML/CSS/JavaScript, hosted on GitHub Pages. `index.html` is the landing page. `app/index.html` owns the app markup and its CSP. `app.js` owns editor state; `cv-import.js` owns PDF import parsing; `cv-export.js` owns PDF and plain-text export; `storage.js` owns local persistence (revisions, snapshots, damaged-data quarantine); `styles.css` owns presentation; `sw.js` is the offline service worker.
- `server.js` is only a Node built-in-module static development server bound to `127.0.0.1:3000`. It is not an application backend.
- PDF.js 3.11.174 and jsPDF 2.5.1 are vendored in `vendor/`. Never replace them with CDN scripts or runtime downloads.

## Non-negotiable constraints

- **Data stays on the device.** No analytics, telemetry, tracking, or outbound runtime requests. No Web Share or any other path that sends a CV off the device without a separate privacy review. Accounts, sync and cloud storage are out of scope until a reviewed phase in `plan.md` approves them.
- **CSP is a meta tag** (GitHub Pages cannot send headers). Preserve and tighten it. Keep scripts, styles, workers, fonts, images and connections local.
- **Classic scripts only.** No ES modules. `app/index.html` must keep working when opened from `file://`. New script files load in order from `app/index.html`.
- **No dynamic HTML.** Build UI with DOM calls (`createElement`, `textContent`). Never use `innerHTML`, `insertAdjacentHTML` or `outerHTML` with dynamic data. No inline `style` attributes and no `setAttribute('style')`; CSSOM (`el.style.x`, `style.setProperty`) is fine.
- **Storage format is fixed.** Do not change storage keys or the data format without a migration. Keys: `state-cv-data-v1`, `state-cv-snapshots-v1`, `state-cv-damaged-v1`, `state-cv-persistence-v1`, `state-cv-backup-reminder-v1`. Keep JSON backup and restore human-readable.
- **Service worker:** bump `CACHE_NAME` in `sw.js` on ANY change to a precached file, and add new precached files to its list.
- **Approval required** before editing `vendor/`, adding any dependency, or bundling any new asset (fonts, libraries). The only dev dependency is `@playwright/test`.
- Validate imported files and keep the existing size, page and parsing limits.
- Update `PRIVACY.md` whenever data handling changes, and keep `README.md` accurate for commands, offline behavior and user-visible features.

## Accessibility

- Hide inactive views with `inert`. Do not add `aria-hidden` on top of it.
- Visible `:focus-visible` on every interactive element. Contrast of at least 4.5:1 for text and 3:1 for UI borders and focus rings (enforced by a test). Use the existing color variables (`--line`, `--control-border`, `--focus-ring`, `--notice-border`, `--muted`) rather than new hardcoded colors.
- Respect `prefers-reduced-motion`. Inputs stay at 16px or larger. Touch targets stay at 44px on coarse pointers. Status messages use `role="status"` without a duplicate `aria-live`.

## Code details that are easy to break

- Source files use CRLF line endings. Keep CRLF when editing.
- Unit tests slice real functions out of `app.js`, `cv-import.js`, and `cv-export.js` using `indexOf` markers. Do not break these boundaries: `cv-import.js` runs from `function pdfItemBoxes(items)` through the end of `function importPdfLines(lines)`, and the `[data-path]` `forEach` stays in `app.js`; `cv-export.js` runs from `const PDF_TEXT_SIZES` through the end of `function downloadPlainText()`; the `restoreSnapshot` slice in `app.js` ends at `\nfunction openYourDataDialog()`; the `getSectionStatus` slice in `app.js` runs from `function getSectionStatus(data)` through the line before `function updateCompletion()`. If code moves, update the markers in the same change.
- New logic that needs unit tests should be pure functions (no DOM access) so tests can extract them.
- The existing e2e PDF test exports a blank CV and expects status `/PDF exported.*(Download started|Save to Files)/`. It must keep passing.

## Testing and validation

- Run `npm run lint`, `npm run lint:selftest`, `npm run test:unit` and `npm run test:e2e`. Report each as PASS / FAIL / COULD NOT TEST with the command output. Do not claim a result you did not see.
- Smoke test with `npm start` at `127.0.0.1:3000/app/`; opening `app/index.html` directly must still work.
- Confirm there are no new external URLs, package downloads, console errors, CSP violations or data transmissions. Verify with networking disabled when practical.
- Use the Playwright projects (360x640, 390x844, 1440x900) for viewport claims, not a manually resized window.
- Mobile is tested on Android only. iPhone/iOS is not a tested target; do not raise or schedule iOS work.

## Git and housekeeping

- Do not push or merge. The owner reviews and merges.
- Restore any localStorage you change during testing.
- Put screenshots and other scratch files outside the repository (`C:\Users\brian\test-shots\`).
