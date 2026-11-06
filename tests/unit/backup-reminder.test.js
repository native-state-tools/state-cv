const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const appSource = fs.readFileSync(path.join(__dirname, '../../app.js'), 'utf8');
const helperStart = appSource.indexOf('function shouldRemindBackup(state, now, options) {');
const helperEnd = appSource.indexOf('\nfunction downloadBackup()', helperStart);
assert.ok(helperStart >= 0 && helperEnd > helperStart, 'Could not isolate shouldRemindBackup from app.js');

const sandbox = vm.createContext({});
vm.runInContext([
  appSource.slice(helperStart, helperEnd),
  'globalThis.shouldRemindBackup = shouldRemindBackup;'
].join('\n'), sandbox);

const { shouldRemindBackup } = sandbox;
const weekMs = 7 * 24 * 60 * 60 * 1000;
const now = Date.UTC(2026, 9, 27);

test('under 50 edits gives false', () => {
  assert.equal(shouldRemindBackup({ editsSinceBackup: 49, lastBackupAt: 0, snoozeUntil: 0 }, now), false);
  assert.equal(shouldRemindBackup({ editsSinceBackup: 0 }, now), false);
  assert.equal(shouldRemindBackup({ editsSinceBackup: 49, lastBackupAt: now - weekMs - 1, snoozeUntil: 0 }, now), false);
});

test('50 or more edits with no backup gives true', () => {
  assert.equal(shouldRemindBackup({ editsSinceBackup: 50, lastBackupAt: 0, snoozeUntil: 0 }, now), true);
  assert.equal(shouldRemindBackup({ editsSinceBackup: 55 }, now), true);
  assert.equal(shouldRemindBackup({ editsSinceBackup: 50, lastBackupAt: 0, snoozeUntil: now }, now), true);
});

test('a recent backup gives false', () => {
  assert.equal(shouldRemindBackup({
    editsSinceBackup: 60,
    lastBackupAt: now - (24 * 60 * 60 * 1000),
    snoozeUntil: 0
  }, now), false);
  assert.equal(shouldRemindBackup({
    editsSinceBackup: 60,
    lastBackupAt: now - weekMs,
    snoozeUntil: 0
  }, now), false);
});

test('an old backup gives true', () => {
  assert.equal(shouldRemindBackup({
    editsSinceBackup: 50,
    lastBackupAt: now - weekMs - 1,
    snoozeUntil: 0
  }, now), true);
});

test('an active snooze gives false', () => {
  assert.equal(shouldRemindBackup({
    editsSinceBackup: 60,
    lastBackupAt: 0,
    snoozeUntil: now + 1
  }, now), false);
  assert.equal(shouldRemindBackup({
    editsSinceBackup: 60,
    lastBackupAt: now - weekMs - weekMs,
    snoozeUntil: now + weekMs
  }, now), false);
});

test('a PDF export reminds when nothing has been backed up yet', () => {
  assert.equal(shouldRemindBackup({
    editsSinceBackup: 1,
    lastBackupAt: 0,
    snoozeUntil: 0
  }, now, { afterPdfExport: true }), true);
  assert.equal(shouldRemindBackup({
    editsSinceBackup: 0,
    lastBackupAt: 0,
    snoozeUntil: 0
  }, now, { afterPdfExport: true }), true);
  assert.equal(shouldRemindBackup({
    editsSinceBackup: 1,
    lastBackupAt: 0,
    snoozeUntil: now + 1
  }, now, { afterPdfExport: true }), false);
  assert.equal(shouldRemindBackup({
    editsSinceBackup: 60,
    lastBackupAt: now - 1000,
    snoozeUntil: 0
  }, now, { afterPdfExport: true }), false);
});

test('garbage input gives false without throwing', () => {
  assert.doesNotThrow(() => {
    assert.equal(shouldRemindBackup(null, now), false);
    assert.equal(shouldRemindBackup(undefined, undefined), false);
    assert.equal(shouldRemindBackup('nope', 'later'), false);
    assert.equal(shouldRemindBackup({
      editsSinceBackup: '20',
      lastBackupAt: 'yesterday',
      snoozeUntil: 'soon'
    }, now), false);
    assert.equal(shouldRemindBackup({
      editsSinceBackup: NaN,
      lastBackupAt: Infinity,
      snoozeUntil: null
    }, NaN), false);
    assert.equal(shouldRemindBackup([], {}), false);
  });
});
