# Privacy Policy

State CV is a local-first application. This is the complete list of what it does with your data, which is: nothing that leaves your device.

- **No accounts.** There is nothing to sign up for and nothing to identify you.

- **No data transmission.** Your CV content, keystrokes, and files are processed entirely in your browser. No CV data, identifiers, or usage information is ever sent to any server — including ours (there isn't one).

- **No analytics or tracking.** The application contains no telemetry, cookies for tracking, or third-party analytics of any kind. A Content Security Policy blocks all external connections at the browser level.

- **Storage is browser-local.** Drafts remain under the existing `state-cv-data-v1` key and include a revision for detecting conflicting edits in another tab. State CV keeps up to five recent local snapshots under `state-cv-snapshots-v1`, and copies an invalid saved value unchanged to `state-cv-damaged-v1` before reporting the issue. The result of the browser-persistence request is stored locally under `state-cv-persistence-v1`. Saving damaged data stays blocked until you import a JSON backup or explicitly start a new CV; the damaged copy is not removed automatically.

- **Browser persistence is best-effort.** After the first successful save, State CV calls the browser's persistent-storage API when available and records whether the request was granted, not granted, or unavailable. If it was not granted, the request is retried on later page loads. The **Your data** dialog also reads the browser's current persistence status when available. A grant does not replace a JSON backup. Browser storage behavior can differ when opening `index.html` directly from the file system; it should not be assumed to match the hosted site.

- **You control local copies.** The **Your data** dialog can download a backup or preserved damaged data, restore a snapshot, and clear the draft, snapshots, damaged copy, and persistence result from this browser.

- **Files are checked on this device.** Backup files and PDFs are checked before use, with size limits. A file that fails validation never replaces the current CV. Backups include a schema version.

- **No liability for lost drafts.** Because data lives only in your browser, the operator accepts no responsibility for lost work. Back up what matters to you.

This policy applies to the application at this repository and its hosted version.

The application makes no outbound requests; visiting this project page is the only interaction that involves a server.
