# CV Forge Agent Instructions

## Project Profile

- CV Forge is a local-first, privacy-first ATS CV builder. Read [PRIVACY.md](PRIVACY.md) before changing data flows and [README.md](README.md) for supported behavior.
- The current app is a vanilla HTML/CSS/JavaScript browser app. `app.js` owns editor state, local persistence, PDF import, and PDF export; `index.html` owns markup and the CSP; `styles.css` owns presentation.
- `server.js` is only a Node built-in-module static development server bound to `127.0.0.1:3000`. It is not an application backend.
- PDF.js and jsPDF are vendored in `vendor/`. Do not replace them with CDN scripts or runtime package downloads.

## Non-Negotiable Constraints

- Keep all user data on the device. Do not add accounts, authentication, cloud databases, sync services, analytics, telemetry, tracking, or outbound runtime requests.
- Preserve and tighten the Content Security Policy when needed. Keep scripts, styles, workers, fonts, images, and connections local unless a change is explicitly justified and reviewed against the privacy policy.
- Treat browser storage as a fallback tier, not a cloud substitute. Keep JSON backup and restore human-readable and usable as the universal data bridge.
- Escape user-controlled text before inserting it into HTML. Validate imported files and retain local size and parsing limits.
- Update `PRIVACY.md` whenever behavior affecting data handling changes. Keep `README.md` accurate for commands, offline behavior, and user-visible features.

## Implementation Preferences

- Prefer vanilla JavaScript and existing local helpers over adding a framework or abstraction. Keep state normalization and storage behavior deterministic.
- Keep the existing public file layout and vendored dependency approach unless the task requires a migration.
- For a new native project, prefer Tauri with vanilla HTML/CSS/JS. Android via Tauri or Capacitor is the next target; do not add iOS support unless explicitly requested. Challenge Firebase/Supabase, auth, analytics, auto-sync, Electron, and framework lock-in because they conflict with the project profile.
- For a new repository, create `ARCHITECTURE.md` and `PRIVACY.md` before application code, and include `LICENSE`, `README.md`, and `src/storage.js`. Do not create those scaffolding files as unrelated work in this existing CV Forge repository.

## Validation

- Run `npm start` for the local smoke test and open `127.0.0.1:3000`; direct opening of `index.html` should remain supported.
- Verify changes with networking disabled when practical. Check local autosave, JSON backup/restore, PDF import, PDF export, and responsive behavior when those paths are touched.
- Confirm there are no new external URLs, package downloads, console errors, CSP violations, or data transmissions.