# State CV

Live version: https://native-state-tools.github.io/state-cv/

A local-first ATS-compatible CV builder built with HTML, CSS, and JavaScript. Part of **Native State Tools**.

## Run

```bash
npm start
```

Then open `127.0.0.1:3000`. The server uses only Node's built-in modules and does not install or download anything. The app also works by opening `index.html` directly in a browser.

## Features

- Live ATS-friendly CV preview
- Local autosave with `localStorage`
- JSON import and export for backup (imports up to 2 MB); backups are versioned and validated before use
- PDF import with local selectable-text extraction (up to 10 MB and 20 pages); parsing disables scripting and eval features and stops after 30 seconds
- Native selectable-text PDF export in Letter or A4 format
- Responsive editor, full-screen preview, and an Edit | Preview | Export bottom bar on screens narrower than 1024px
- No account or external service required

PDF import reads selectable text in the browser and maps common contact, summary, experience, education, and skills headings into the editor. It supports common single-column layouts, separate or combined role/company/date lines, numeric dates, month-name dates, and several heading variations. Image-only or scanned PDFs need OCR before they can be imported; heavily designed multi-column PDFs may still need a quick manual review because PDF text order is not standardized.

Letter is the default for US applications. A4 is available for international applications.

The `Export PDF` button creates a native Letter or A4 PDF with selectable text, controlled page breaks, and no browser date, URL, or page labels. The browser print dialog is only used as a fallback if the local PDF library cannot load.

## Offline operation

PDF.js 3.11.174 and jsPDF 2.5.1 are vendored locally in `vendor/`, fonts use local system stacks, and the Content Security Policy blocks external scripts, styles, fonts, images, workers, and connections. State CV can run with Wi-Fi disabled and makes no external network requests.

## License

Released under the MIT License. The vendored PDF.js and jsPDF distributions retain their original license notices.
