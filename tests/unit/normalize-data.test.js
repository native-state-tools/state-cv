const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const appSource = fs.readFileSync(path.join(__dirname, '../../app.js'), 'utf8');
const requiredConstants = ['SCHEMA_VERSION', 'MAX_EXPERIENCE_ENTRIES', 'MAX_EDUCATION_ENTRIES'];
const declarations = requiredConstants.map((name) => {
  const match = appSource.match(new RegExp(`^const ${name} = [^\\n]+;$`, 'm'));
  assert.ok(match, `Could not find ${name} in app.js`);
  return match[0];
});
const errorStart = appSource.indexOf('class ImportError extends Error {');
const errorEnd = appSource.indexOf('\nconst defaultData =', errorStart);
const normalizerStart = appSource.indexOf('function normalizeData(data, { strict = false } = {}) {');
const normalizerEnd = appSource.indexOf('\nfunction toStorable()', normalizerStart);
assert.ok(errorStart >= 0 && errorEnd > errorStart, 'Could not isolate ImportError from app.js');
assert.ok(normalizerStart >= 0 && normalizerEnd > normalizerStart, 'Could not isolate normalizeData from app.js');

const sandbox = vm.createContext({});
vm.runInContext([
  ...declarations,
  appSource.slice(errorStart, errorEnd),
  appSource.slice(normalizerStart, normalizerEnd),
  'globalThis.normalizeData = normalizeData;'
].join('\n'), sandbox);
const parseInSandbox = vm.runInContext('JSON.parse', sandbox);
const normalizeData = (data, options) => sandbox.normalizeData(parseInSandbox(JSON.stringify(data)), options);
const plain = (value) => JSON.parse(JSON.stringify(value));
const defaultShape = {
  basics: { name: '', title: '', location: '', email: '', phone: '', website: '' },
  exportName: '',
  summary: '',
  experience: [{ role: '', company: '', dates: '', highlights: '' }],
  education: [{ degree: '', school: '', dates: '' }],
  skills: ''
};

function makeMemoryStorage() {
  const values = new Map();
  return {
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
    removeItem(key) {
      values.delete(key);
    }
  };
}

test('strict and non-strict normalization fill missing fields deterministically', () => {
  assert.deepEqual(plain(normalizeData({}, { strict: true })), defaultShape);
  assert.deepEqual(plain(normalizeData({}, { strict: false })), defaultShape);
});

test('strict mode rejects wrong field, object, and array types while non-strict mode normalizes them', () => {
  const input = {
    basics: 'not an object',
    summary: 42,
    experience: 'not an array',
    education: [null]
  };
  assert.throws(() => normalizeData(input, { strict: true }), /basics must be an object/);
  assert.deepEqual(plain(normalizeData(input, { strict: false })), defaultShape);
  assert.throws(
    () => normalizeData({ basics: { name: 9 } }, { strict: true }),
    /basics name must be a string/
  );
  assert.equal(normalizeData({ basics: { name: 9 } }, { strict: false }).basics.name, '');
});

test('strict mode rejects oversized text and arrays; non-strict mode truncates them', () => {
  const longSummary = 'x'.repeat(501);
  assert.throws(() => normalizeData({ summary: longSummary }, { strict: true }), /summary is longer than 500/);
  assert.equal(normalizeData({ summary: longSummary }, { strict: false }).summary.length, 500);

  const longExperience = Array.from({ length: 31 }, () => ({ role: 'Role' }));
  assert.throws(
    () => normalizeData({ experience: longExperience }, { strict: true }),
    /experience has more than 30 entries/
  );
  assert.equal(normalizeData({ experience: longExperience }, { strict: false }).experience.length, 30);

  const longEducation = Array.from({ length: 21 }, () => ({ degree: 'Degree' }));
  assert.throws(
    () => normalizeData({ education: longEducation }, { strict: true }),
    /education has more than 20 entries/
  );
  assert.equal(normalizeData({ education: longEducation }, { strict: false }).education.length, 20);
});

test('unknown fields are ignored and legacy schema-less/current-schema data are accepted', () => {
  const result = normalizeData({
    basics: { name: 'Legacy', unexpected: 'ignored' },
    schemaVersion: 1,
    unexpected: { key: 'ignored' }
  }, { strict: true });
  assert.equal(result.basics.name, 'Legacy');
  assert.equal(Object.hasOwn(result, 'unexpected'), false);
  assert.equal(Object.hasOwn(result.basics, 'unexpected'), false);
  assert.deepEqual(plain(normalizeData({ basics: { name: 'Old backup' } }, { strict: true })).basics.name, 'Old backup');
  assert.throws(() => normalizeData({ schemaVersion: 2 }, { strict: true }), /newer version/);
});

test('hostile markup remains inert plain text and is never evaluated by normalization', () => {
  const payload = '<script>globalThis.__hostileExecuted = true</script><img src=x onerror=alert(1)>';
  const result = normalizeData({ basics: { name: payload }, summary: payload }, { strict: true });

  assert.equal(result.basics.name, payload);
  assert.equal(result.summary, payload);
  assert.equal(sandbox.__hostileExecuted, undefined);
});

test('app snapshot helper de-duplicates equivalent normalized data', () => {
  const fakeStorage = makeMemoryStorage();
  const createStorage = require('../../storage.js');
  const stateStorage = createStorage(fakeStorage);
  const takeSnapshotStart = appSource.indexOf('function takeSnapshot(');
  const takeSnapshotEnd = appSource.indexOf('\nfunction snapshotLatestStored(', takeSnapshotStart);
  assert.ok(takeSnapshotStart >= 0 && takeSnapshotEnd > takeSnapshotStart, 'Could not isolate takeSnapshot from app.js');
  const snapshotSandbox = vm.createContext({
    stateStorage,
    normalizeData,
    structuredClone,
    defaultData: defaultShape,
    console
  });
  vm.runInContext([
    'let lastSnapshotAt = Date.now();',
    appSource.slice(takeSnapshotStart, takeSnapshotEnd),
    'globalThis.takeSnapshot = takeSnapshot;'
  ].join('\n'), snapshotSandbox);

  const cv = { basics: { name: 'Snapshot' }, experience: [{ role: 'Designer' }] };
  snapshotSandbox.takeSnapshot(cv, 1);
  snapshotSandbox.takeSnapshot({ ...cv, ignored: 'same normalized value' }, 1);
  assert.equal(stateStorage.readSnapshots().length, 1);
});

test('app restoreSnapshot preserves the pre-restore CV as an undo snapshot', () => {
  const createStorage = require('../../storage.js');
  const stateStorage = createStorage(makeMemoryStorage());
  const beforeRestore = normalizeData({
    basics: { name: 'Current CV' },
    experience: [{ role: 'Current role' }]
  }, { strict: true });
  const restored = normalizeData({
    basics: { name: 'Snapshot CV' },
    experience: [{ role: 'Earlier role' }]
  }, { strict: true });
  stateStorage.writeData('state-cv-data-v1', { schemaVersion: 1, ...beforeRestore }, 0);
  stateStorage.addSnapshot({
    savedAt: '2026-01-01T00:00:00.000Z',
    revision: 0,
    data: restored
  });

  const takeSnapshotStart = appSource.indexOf('function takeSnapshot(');
  const takeSnapshotEnd = appSource.indexOf('\nfunction snapshotLatestStored(', takeSnapshotStart);
  const restoreStart = appSource.indexOf('function restoreSnapshot(index, normalizedData) {');
  const restoreEnd = appSource.indexOf('\nfunction openYourDataDialog()', restoreStart);
  assert.ok(takeSnapshotEnd > takeSnapshotStart, 'Could not isolate takeSnapshot from app.js');
  assert.ok(restoreStart >= 0 && restoreEnd > restoreStart, 'Could not isolate restoreSnapshot from app.js');

  const restoreSandbox = vm.createContext({
    STORAGE_KEY: 'state-cv-data-v1',
    SCHEMA_VERSION: 1,
    stateStorage,
    normalizeData,
    structuredClone,
    defaultData: defaultShape,
    resumeData: beforeRestore,
    loadedRevision: 1,
    lastSnapshotAt: Date.now(),
    storageConflict: false,
    storageLoadFailed: false,
    storageDamaged: false,
    console: { error() {} },
    document: { querySelector: () => ({ removeAttribute() {}, textContent: '' }) },
    cancelScheduledSave() {},
    renderFields() {},
    updatePreview() {},
    updateCompletion() {},
    renderYourDataDialog() {},
    showStorageConflict() {},
    hideUndoToast() {},
    takeSnapshot: undefined
  });
  vm.runInContext([
    'function toStorable() { return { schemaVersion: SCHEMA_VERSION, ...resumeData }; }',
    'function saveData() { loadedRevision = stateStorage.writeData(STORAGE_KEY, { ...toStorable(), savedAt: "2026-01-02T00:00:00.000Z" }, loadedRevision); return true; }',
    appSource.slice(takeSnapshotStart, takeSnapshotEnd),
    appSource.slice(restoreStart, restoreEnd),
    'globalThis.runRestore = restoreSnapshot;'
  ].join('\n'), restoreSandbox);

  restoreSandbox.runRestore(0, restored);
  assert.equal(restoreSandbox.resumeData.basics.name, 'Snapshot CV');
  assert.equal(JSON.parse(stateStorage.getItem('state-cv-data-v1')).basics.name, 'Snapshot CV');
  assert.equal(stateStorage.readSnapshots().length, 2);
  assert.equal(stateStorage.readSnapshots()[1].data.basics.name, 'Current CV');
});

test('app loadData quarantines malformed JSON and a successful forced save keeps the raw copy', () => {
  const createStorage = require('../../storage.js');
  const stateStorage = createStorage(makeMemoryStorage());
  const damagedRaw = '{"damaged":';
  stateStorage.setItem('state-cv-data-v1', damagedRaw);

  const loadStart = appSource.indexOf('function loadData() {');
  const loadEnd = appSource.indexOf('\nfunction preserveDamagedData(', loadStart);
  const preserveStart = loadEnd + 1;
  const preserveEnd = appSource.indexOf('\nfunction saveData(', preserveStart);
  const saveStart = preserveEnd + 1;
  const saveEnd = appSource.indexOf('\nasync function requestStoragePersistence()', saveStart);
  const toStorableStart = appSource.indexOf('function toStorable() {');
  const toStorableEnd = appSource.indexOf('\nfunction loadData()', toStorableStart);
  assert.ok(saveEnd > saveStart, 'Could not isolate saveData from app.js');
  assert.ok(preserveEnd > preserveStart, 'Could not isolate preserveDamagedData from app.js');
  assert.ok(toStorableEnd > toStorableStart, 'Could not isolate toStorable from app.js');

  const loadSandbox = vm.createContext({
    STORAGE_KEY: 'state-cv-data-v1',
    SCHEMA_VERSION: 1,
    stateStorage,
    normalizeData,
    structuredClone,
    defaultData: defaultShape,
    resumeData: defaultShape,
    loadedRevision: 0,
    storageLoadFailed: false,
    storageDamaged: false,
    storageWriteFailed: false,
    storageConflict: false,
    damagedRaw: null,
    damagedCopyStored: false,
    lastSnapshotAt: Date.now(),
    storageNoticeKind: null,
    console: { warn() {}, error() {} },
    setStatus() {},
    showDamagedNotice() {},
    showStorageConflict() {},
    showStorageUnavailableNotice() {},
    requestStoragePersistence() {},
    noteBackupReminderEdit() {},
    updateBackupReminderNotice() {}
  });
  vm.runInContext([
    appSource.slice(toStorableStart, toStorableEnd),
    appSource.slice(loadStart, loadEnd),
    appSource.slice(preserveStart, preserveEnd),
    appSource.slice(saveStart, saveEnd),
    'globalThis.loadDataFromApp = loadData;',
    'globalThis.saveAfterDamagedLoad = () => saveData({ force: storageLoadFailed || storageDamaged });'
  ].join('\n'), loadSandbox);

  const loaded = loadSandbox.loadDataFromApp();
  assert.deepEqual(plain(loaded), defaultShape);
  assert.equal(stateStorage.getItem('state-cv-data-v1'), damagedRaw);
  assert.equal(stateStorage.getItem('state-cv-damaged-v1'), damagedRaw);

  assert.equal(loadSandbox.saveAfterDamagedLoad(), true);
  assert.equal(JSON.parse(stateStorage.getItem('state-cv-data-v1')).schemaVersion, 1);
  assert.equal(stateStorage.getItem('state-cv-damaged-v1'), damagedRaw);
});
