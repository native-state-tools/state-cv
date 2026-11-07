const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const appSource = fs.readFileSync(path.join(__dirname, '../../app.js'), 'utf8');
const helperStart = appSource.indexOf('function importReplacementMessage(');
const helperEnd = appSource.indexOf('\nfunction confirmReplacingSavedCv(', helperStart);
assert.ok(helperStart >= 0 && helperEnd > helperStart, 'Could not isolate importReplacementMessage from app.js');

const sandbox = vm.createContext({});
vm.runInContext([
  appSource.slice(helperStart, helperEnd),
  'globalThis.importReplacementMessage = importReplacementMessage;'
].join('\n'), sandbox);

const { importReplacementMessage } = sandbox;
const snapshot = 'A copy is kept in Your data > Recent snapshots.';
const unreadable = 'Importing will replace the saved CV data on this device. It could not be read, so no snapshot copy is available. Continue?';

test('a blank saved CV with no versions skips the question', () => {
  assert.equal(importReplacementMessage({
    kind: 'pdf', readable: true, blank: true, savedVersionCount: 0, snapshot: false
  }), '');
  assert.equal(importReplacementMessage({
    kind: 'json', readable: true, blank: true, savedVersionCount: 0, incomingVersionCount: 2, snapshot: true
  }), '');
});

test('unreadable saved data never promises a snapshot', () => {
  assert.equal(importReplacementMessage({ kind: 'pdf', readable: false, snapshot: true }), unreadable);
  assert.equal(importReplacementMessage({ kind: 'json', readable: false, snapshot: true }), unreadable);
  assert.equal(unreadable.includes('Recent snapshots'), false);
});

test('PDF import says existing versions will be removed', () => {
  assert.equal(
    importReplacementMessage({ kind: 'pdf', savedVersionCount: 1, snapshot: true }),
    `Importing will replace your current CV. Your 1 version will be removed. ${snapshot} Continue?`
  );
  assert.equal(
    importReplacementMessage({ kind: 'pdf', savedVersionCount: 2, snapshot: true }),
    `Importing will replace your current CV. Your 2 versions will be removed. ${snapshot} Continue?`
  );
  assert.equal(
    importReplacementMessage({ kind: 'pdf', savedVersionCount: 0, snapshot: true }),
    `Importing will replace your current CV. ${snapshot} Continue?`
  );
});

test('a blank master with versions does not promise a snapshot', () => {
  assert.equal(
    importReplacementMessage({ kind: 'pdf', blank: true, savedVersionCount: 1, snapshot: false }),
    'Importing will replace your current CV. Your 1 version will be removed. Continue?'
  );
  assert.equal(
    importReplacementMessage({
      kind: 'json', blank: true, savedVersionCount: 1, incomingVersionCount: 0, snapshot: false
    }),
    'Importing this backup replaces your current master CV and versions with the backup. This backup has no versions. Continue?'
  );
});

test('JSON import replaces the master and versions with the backup', () => {
  const one = importReplacementMessage({
    kind: 'json', savedVersionCount: 2, incomingVersionCount: 1, snapshot: true
  });
  assert.equal(
    one,
    `Importing this backup replaces your current master CV and versions with the backup's master CV and its 1 version. ${snapshot} Continue?`
  );
  assert.equal(one.includes('will be removed'), false);
  const many = importReplacementMessage({
    kind: 'json', savedVersionCount: 0, incomingVersionCount: 3, snapshot: true
  });
  assert.equal(
    many,
    `Importing this backup replaces your current master CV and versions with the backup's master CV and its 3 versions. ${snapshot} Continue?`
  );
});

test('an older backup with no versions says the current versions are replaced with none', () => {
  const message = importReplacementMessage({
    kind: 'json', savedVersionCount: 2, incomingVersionCount: 0, snapshot: true
  });
  assert.equal(
    message,
    `Importing this backup replaces your current master CV and versions with the backup. This backup has no versions. ${snapshot} Continue?`
  );
  assert.equal(message.includes('will be removed'), false);
  assert.equal(
    importReplacementMessage({ kind: 'json', savedVersionCount: 0, incomingVersionCount: 0, snapshot: true }),
    `Importing will replace your current CV. ${snapshot} Continue?`
  );
});

test('app.js ends with one trailing newline', () => {
  assert.equal(appSource.endsWith('\n'), true);
  assert.equal(appSource.endsWith('\n\n'), false);
  assert.equal(appSource.endsWith('\r\n\r\n'), false);
});

test('empty launch markup highlights Start a new CV', () => {
  const html = fs.readFileSync(path.join(__dirname, '../../app/index.html'), 'utf8');
  const continueButton = html.match(/<button class="([^"]*)" id="continueButton"/);
  const newCvButton = html.match(/<button class="([^"]*)" id="newCvButton"/);
  assert.ok(continueButton, 'continueButton markup was not found');
  assert.ok(newCvButton, 'newCvButton markup was not found');
  assert.equal(continueButton[1].includes('launch-card-primary'), false);
  assert.equal(newCvButton[1].includes('launch-card-primary'), true);
});
