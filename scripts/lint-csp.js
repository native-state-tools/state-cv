const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const ALLOWED_ANCHOR_HREFS = new Set([
  'https://nativestatetools.com/',
  'https://github.com/native-state-tools/state-cv',
  'https://ko-fi.com/nativestatetools'
]);

function withoutAllowedAnchors(text) {
  return text.replace(/<a\b[^>]*>/gi, (tag) => {
    const hrefMatch = tag.match(/\bhref\s*=\s*(['"])([^'"]*)\1/i);
    if (!hrefMatch || !ALLOWED_ANCHOR_HREFS.has(hrefMatch[2])) return tag;
    return tag.replace(/\bhref\s*=\s*(['"])[^'"]*\1/i, 'href="./"');
  });
}

function sourceForRule(ruleName, text) {
  return ruleName === 'external-runtime-target' ? withoutAllowedAnchors(text) : text;
}

const rules = [
  ['inline-style-attribute', /<\s*[^>]+\sstyle\s*=/i, 'HTML style attribute'],
  ['style-setattribute', /\.setAttribute\s*\(\s*(['"])style\1/i, "setAttribute('style')"],
  ['innerhtml-assignment', /\.innerHTML\s*=/i, 'innerHTML assignment'],
  ['insert-adjacent-html', /\.insertAdjacentHTML\s*\(/i, 'insertAdjacentHTML'],
  ['outerhtml-assignment', /\.outerHTML\s*=/i, 'outerHTML assignment'],
  ['document-write', /\bdocument\.write\s*\(/i, 'document.write'],
  ['eval-call', /\beval\s*\(/i, 'eval('],
  ['function-constructor', /\bnew\s+Function\s*\(/i, 'new Function'],
  ['module-script', /\btype\s*=\s*(['"])module\1/i, 'type="module"'],
  ['module-import-export', /^\s*(?:import\s+(?!\()|export\s+)/m, 'import/export statement'],
  ['external-runtime-target', /\b(?:src|href)\s*=\s*(['"])https?:\/\/|fetch\s*\(\s*(['"])https?:\/\//i, 'external src/href/fetch target'],
  ['html-string-inline-style', /(["'`])[^\\\r\n]*?<\s*[a-z][^>]*\sstyle\s*=/i, 'HTML-in-string style attribute'],
  ['xmlhttprequest', /\bXMLHttpRequest\b/i, 'XMLHttpRequest'],
  ['websocket', /\bWebSocket\b/i, 'WebSocket'],
  ['import-scripts', /\bimportScripts\s*\(/i, 'importScripts('],
  ['send-beacon', /\bnavigator\s*\.\s*sendBeacon\s*\(/i, 'navigator.sendBeacon']
];

const samples = [
  ['<p style="color:red">', 'inline-style-attribute'],
  ["node.setAttribute('style', 'color:red')", 'style-setattribute'],
  ['node.innerHTML = value', 'innerhtml-assignment'],
  ["node.insertAdjacentHTML('beforeend', value)", 'insert-adjacent-html'],
  ['node.outerHTML = value', 'outerhtml-assignment'],
  ['document.write(value)', 'document-write'],
  ['eval(value)', 'eval-call'],
  ['new Function(value)', 'function-constructor'],
  ['<script type="module">', 'module-script'],
  ['import value from "./value.js";', 'module-import-export'],
  ['export const value = 1;', 'module-import-export'],
  ['<script src="https://example.test/app.js"></script>', 'external-runtime-target'],
  ['<a href="http://example.test/">', 'external-runtime-target'],
  ['<a href="https://example.test/">', 'external-runtime-target'],
  ['<link href="https://example.test/style.css">', 'external-runtime-target'],
  ['<link href="https://nativestatetools.com/">', 'external-runtime-target'],
  ['<a href="https://nativestatetools.com/" src="https://evil.test/x">', 'external-runtime-target'],
  ["fetch('https://example.test/data')", 'external-runtime-target'],
  [`const markup = '<span style="color:red">';`, 'html-string-inline-style'],
  ['const request = new XMLHttpRequest();', 'xmlhttprequest'],
  ['const socket = new WebSocket(url);', 'websocket'],
  ["importScripts('worker.js');", 'import-scripts'],
  ["navigator.sendBeacon('/metrics', data);", 'send-beacon']
];

function matchingRules(text) {
  return rules.filter(([name, pattern]) => pattern.test(sourceForRule(name, text))).map(([name]) => name);
}

function selfTest() {
  samples.forEach(([sample, expectedRule], index) => {
    const matches = matchingRules(sample);
    assert.ok(
      matches.includes(expectedRule),
      `Expected sample ${index + 1} to trigger ${expectedRule}: ${sample}`
    );
  });
  const safeSamples = [
    'fetch("/local.json"); node.textContent = value;',
    '<a href="https://nativestatetools.com/" rel="noreferrer">Native State Tools</a>',
    '<a href="https://github.com/native-state-tools/state-cv" rel="noreferrer">Source code</a>',
    '<a href="https://ko-fi.com/nativestatetools" rel="noopener noreferrer" target="_blank">Support State CV</a>'
  ];
  safeSamples.forEach((sample) => {
    assert.equal(matchingRules(sample).length, 0, `Expected a local-safe sample to pass: ${sample}`);
  });
  console.log(`Lint self-test passed: ${samples.length} in-memory bad samples were rejected; ${safeSamples.length} local-safe samples accepted.`);
}

function listJavaScriptFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return listJavaScriptFiles(entryPath);
    return entry.isFile() && entry.name.endsWith('.js') ? [entryPath] : [];
  });
}

function checkSyntax(files) {
  for (const file of files) {
    execFileSync(process.execPath, ['--check', file], { cwd: root, stdio: 'pipe' });
  }
  console.log(`Syntax check passed: ${files.length} JavaScript files.`);
}

function lintSources() {
  const htmlFiles = ['index.html', 'about.html', 'app/index.html'].map((file) => {
    const htmlPath = path.join(root, file);
    return [htmlPath, fs.readFileSync(htmlPath, 'utf8')];
  });
  const scriptPaths = ['app.js', 'storage.js', 'sw.js'].map((file) => path.join(root, file));
  const scriptSources = scriptPaths.map((file) => [file, fs.readFileSync(file, 'utf8')]);
  const appAndStorage = scriptSources.filter(([file]) => ['app.js', 'storage.js'].includes(path.basename(file)));

  const findings = [];
  for (const [ruleName, pattern, description] of rules) {
    let targets = scriptSources;
    if (ruleName === 'inline-style-attribute' || ruleName === 'module-script') targets = htmlFiles;
    else if (ruleName === 'external-runtime-target') targets = [...htmlFiles, ...scriptSources];
    else if (ruleName === 'html-string-inline-style') targets = appAndStorage.concat(scriptSources.filter(([file]) => path.basename(file) === 'sw.js'));
    else if (['xmlhttprequest', 'websocket', 'import-scripts', 'send-beacon'].includes(ruleName)) targets = appAndStorage;
    for (const [file, source] of targets) {
      if (pattern.test(sourceForRule(ruleName, source))) findings.push(`${path.relative(root, file)}: ${description}`);
    }
  }
  if (findings.length) {
    console.error(`CSP lint failed:\n${findings.map((finding) => `- ${finding}`).join('\n')}`);
    process.exitCode = 1;
    return;
  }
  console.log('CSP lint passed: no disallowed HTML/script patterns or external runtime targets.');
}

function main() {
  selfTest();
  if (process.argv.includes('--self-test')) return;
  const syntaxFiles = [
    path.join(root, 'app.js'),
    path.join(root, 'storage.js'),
    path.join(root, 'sw.js'),
    path.join(root, 'server.js'),
    path.join(root, 'playwright.config.js'),
    ...listJavaScriptFiles(path.join(root, 'scripts')),
    ...listJavaScriptFiles(path.join(root, 'tests'))
  ];
  checkSyntax(syntaxFiles);
  lintSources();
}

main();
