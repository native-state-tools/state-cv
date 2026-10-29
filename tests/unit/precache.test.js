const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '../..');
const source = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
const block = source.match(/const PRECACHE_URLS = \[([\s\S]*?)\];/);

test('every precached file exists', () => {
  assert.ok(block, 'PRECACHE_URLS was not found in sw.js');
  const urls = [...block[1].matchAll(/['"](\.\/[^'"]+)['"]/g)].map((match) => match[1]);
  assert.ok(urls.length > 0, 'PRECACHE_URLS is empty');
  for (const url of urls) {
    const filePath = path.join(root, url.replace(/^\.\//, ''));
    assert.equal(fs.existsSync(filePath) && fs.statSync(filePath).isFile(), true, `missing precache file: ${url}`);
  }
});

test('precache includes the landing page and the app, and the manifest opens the app', () => {
  assert.ok(block, 'PRECACHE_URLS was not found in sw.js');
  const urls = [...block[1].matchAll(/['"](\.\/[^'"]+)['"]/g)].map((match) => match[1]);
  assert.ok(urls.includes('./index.html'));
  assert.ok(urls.includes('./app/index.html'));
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  assert.equal(manifest.start_url, './app/');
  assert.equal(manifest.scope, './');
  assert.equal(manifest.id, './');
});
