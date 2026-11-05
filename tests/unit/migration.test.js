const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const createStorage = require('../../storage.js');

const appSource = fs.readFileSync(path.join(__dirname, '../../app.js'), 'utf8');
const requiredConstants = ['SCHEMA_VERSION', 'MAX_EXPERIENCE_ENTRIES', 'MAX_EDUCATION_ENTRIES', 'MAX_VERSIONS', 'ENTRY_ID_PATTERN'];
const declarations = requiredConstants.map((name) => {
  const match = appSource.match(new RegExp(`^const ${name} = [^\\n]+;$`, 'm'));
  assert.ok(match, `Could not find ${name} in app.js`);
  return match[0];
});
const errorStart = appSource.indexOf('class ImportError extends Error {');
const errorEnd = appSource.indexOf('\nconst defaultData =', errorStart);
const normalizerStart = appSource.indexOf('function createEntryId(prefix) {');
const normalizerEnd = appSource.indexOf('\nfunction toStorable()', normalizerStart);
const assignStart = appSource.indexOf('function assignEntryIds(records, prefix, makeId) {');
const assignEnd = appSource.indexOf('\nfunction blankExperience()', assignStart);
assert.ok(normalizerEnd > normalizerStart, 'Could not isolate normalizeData from app.js');
assert.ok(assignEnd > assignStart, 'Could not isolate assignEntryIds from app.js');

const sandbox = vm.createContext({});
vm.runInContext([
  ...declarations,
  appSource.slice(errorStart, errorEnd),
  appSource.slice(normalizerStart, normalizerEnd),
  'globalThis.normalizeData = normalizeData;',
  'globalThis.assignEntryIds = assignEntryIds;'
].join('\n'), sandbox);
const parseInSandbox = vm.runInContext('JSON.parse', sandbox);
const plain = (value) => JSON.parse(JSON.stringify(value));

function normalizeData(data, options = {}) {
  let sequence = 0;
  const makeId = typeof options.makeId === 'function' ? options.makeId : (prefix) => `${prefix}${++sequence}`;
  return sandbox.normalizeData(parseInSandbox(JSON.stringify(data)), { ...options, makeId });
}

const sampleV1 = {
  basics: { name: 'Ada Lovelace', title: 'Analyst', email: 'ada@example.com' },
  summary: 'Wrote the notes.',
  experience: [{ role: 'Analyst', company: 'Analytical Engines', dates: '1842 - 1843', highlights: 'Published notes.' }],
  education: [{ degree: 'Mathematics', school: 'Home', dates: '1835' }],
  skills: 'Mathematics'
};

test('assignEntryIds keeps valid ids and replaces missing, duplicate, and non-string ids', () => {
  let sequence = 0;
  const records = sandbox.assignEntryIds([
    { id: 'exp_keep', role: 'A' },
    { role: 'B' },
    { id: 'exp_keep', role: 'C' },
    { id: 12, role: 'D' },
    { id: '', role: 'E' },
    { id: 'exp_also', role: 'F' }
  ], 'exp_', (prefix) => `${prefix}${++sequence}`);
  assert.deepEqual(records.map((record) => record.id), [
    'exp_keep', 'exp_1', 'exp_2', 'exp_3', 'exp_4', 'exp_also'
  ]);
  assert.equal(records[1].role, 'B');
});

test('v1 with schemaVersion 1 and v1 with no schemaVersion become the same master with ids', () => {
  const withVersion = normalizeData({ schemaVersion: 1, ...sampleV1 }, { strict: true });
  const withoutVersion = normalizeData(sampleV1, { strict: true });
  assert.deepEqual(plain(withVersion), plain(withoutVersion));
  assert.equal(withVersion.master.basics.name, 'Ada Lovelace');
  assert.equal(withVersion.master.experience[0].role, 'Analyst');
  assert.equal(withVersion.master.experience[0].id, 'exp_1');
  assert.equal(withVersion.master.education[0].id, 'edu_2');
  assert.deepEqual(plain(withVersion.versions), []);
  assert.equal(Object.hasOwn(withVersion.master, 'schemaVersion'), false);
});

test('v2 round trip keeps ids and versions unchanged', () => {
  const input = {
    schemaVersion: 2,
    master: {
      basics: { name: 'Ada Lovelace', title: 'Analyst', email: 'ada@example.com' },
      summary: 'Wrote the notes.',
      experience: [{
        id: 'exp_keep',
        role: 'Analyst',
        company: 'Analytical Engines',
        dates: '1842 - 1843',
        highlights: 'Published notes.'
      }],
      education: [{ id: 'edu_keep', degree: 'Mathematics', school: 'Home', dates: '1835' }],
      skills: 'Mathematics'
    },
    versions: [{ id: 'ver_1', name: 'Frontend at Acme' }]
  };
  const once = normalizeData(input, { strict: true });
  const twice = normalizeData({
    schemaVersion: 2,
    master: once.master,
    versions: once.versions
  }, { strict: true });
  assert.deepEqual(plain(twice), plain(once));
  assert.equal(once.master.experience[0].id, 'exp_keep');
  assert.equal(once.master.education[0].id, 'edu_keep');
  assert.deepEqual(plain(once.versions), [{ id: 'ver_1', name: 'Frontend at Acme', hiddenEntries: [] }]);
});

test('missing, duplicate, and non-string entry ids are replaced and valid ids are kept', () => {
  const result = normalizeData({
    schemaVersion: 2,
    master: {
      experience: [
        { id: 'exp_keep', role: 'A' },
        { role: 'B' },
        { id: 'exp_keep', role: 'C' },
        { id: 9, role: 'D' },
        { id: 'exp_also', role: 'E' }
      ],
      education: [
        { id: 'edu_keep', degree: 'BSc' },
        { id: null, degree: 'MSc' }
      ]
    },
    versions: []
  }, { strict: true });
  assert.deepEqual(plain(result.master.experience.map((record) => record.id)), [
    'exp_keep', 'exp_1', 'exp_2', 'exp_3', 'exp_also'
  ]);
  assert.deepEqual(plain(result.master.education.map((record) => record.id)), ['edu_keep', 'edu_4']);
});

test('versions must be an array, bad items are dropped, and more than 50 is rejected', () => {
  assert.throws(
    () => normalizeData({ schemaVersion: 2, master: {}, versions: { id: 'ver_1' } }, { strict: true }),
    /versions must be an array/
  );
  assert.deepEqual(plain(normalizeData({
    schemaVersion: 2,
    master: {},
    versions: { id: 'ver_1' }
  }, { strict: false }).versions), []);

  const name = `  ${'N'.repeat(130)}  `;
  const versions = normalizeData({
    schemaVersion: 2,
    master: { basics: { name: 'Ada' } },
    versions: [
      { id: 'ver_ok', name: '  Frontend  ', extra: 'drop me' },
      { id: 4, name: 'Number id' },
      { name: 'Missing id' },
      null,
      ['ver_array', 'Name'],
      { id: 'ver_long', name },
      { id: 'ver_blank', name: '   ' }
    ]
  }, { strict: true }).versions;
  assert.deepEqual(plain(versions), [
    { id: 'ver_ok', name: 'Frontend', hiddenEntries: [] },
    { id: 'ver_long', name: 'N'.repeat(120), hiddenEntries: [] },
    { id: 'ver_blank', name: 'Untitled version', hiddenEntries: [] }
  ]);

  const tooMany = Array.from({ length: 51 }, (_, index) => ({ id: `ver_${index}`, name: `Version ${index}` }));
  assert.throws(
    () => normalizeData({ schemaVersion: 2, master: {}, versions: tooMany }, { strict: true }),
    /more than 50/
  );
  assert.equal(normalizeData({
    schemaVersion: 2,
    master: {},
    versions: tooMany
  }, { strict: false }).versions.length, 50);
});

test('schemaVersion 3 and other damaged input are still rejected', () => {
  assert.throws(() => normalizeData({ schemaVersion: 3, master: { basics: { name: 'Future' } } }, { strict: true }), /newer version/);
  assert.throws(() => normalizeData(null, { strict: true }), /not a State CV backup/);
  assert.throws(() => normalizeData(['not-an-object'], { strict: true }), /not a State CV backup/);
  assert.throws(() => normalizeData('backup', { strict: true }), /not a State CV backup/);
  assert.throws(() => normalizeData({ schemaVersion: 0 }, { strict: true }), /invalid schema version/);
  assert.throws(() => normalizeData({ schemaVersion: 1.5 }, { strict: true }), /invalid schema version/);
  assert.throws(() => normalizeData({ schemaVersion: 2, master: 'nope' }, { strict: true }), /master must be an object/);
  assert.throws(() => normalizeData({ schemaVersion: 1, basics: { name: 9 } }, { strict: true }), /basics name must be a string/);
  assert.throws(() => normalizeData({ experience: 'not-a-list' }, { strict: true }), /experience must be an array/);
});

function memoryStorage() {
  const values = new Map();
  return {
    values,
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      if (this.failSet && this.failSet(key, value)) throw new Error('QuotaExceededError');
      values.set(key, String(value));
    },
    removeItem(key) {
      values.delete(key);
    },
    failSet: null
  };
}

function runMigration({ raw, resumeData, failPremigration = false, failSnapshot = false, existingPremigration = null, loadedRevision = 0 }) {
  const fake = memoryStorage();
  fake.setItem('state-cv-data-v1', raw);
  if (existingPremigration !== null) fake.setItem('state-cv-premigration-v1', existingPremigration);
  fake.failSet = (key) => failPremigration && key === 'state-cv-premigration-v1';
  const stateStorage = createStorage(fake);
  const migrateStart = appSource.indexOf('function migratePendingV1() {');
  const migrateEnd = appSource.indexOf('\nfunction preserveDamagedData(', migrateStart);
  const toStorableStart = appSource.indexOf('function toStorable() {');
  const toStorableEnd = appSource.indexOf('\nfunction loadData()', toStorableStart);
  assert.ok(migrateEnd > migrateStart, 'Could not isolate migratePendingV1 from app.js');
  let snapshotCalls = 0;
  let snapshotArgument = null;
  const calls = { conflict: null };
  const context = vm.createContext({
    SCHEMA_VERSION: 2,
    PREMIGRATION_KEY: 'state-cv-premigration-v1',
    STORAGE_KEY: 'state-cv-data-v1',
    stateStorage,
    resumeData,
    loadedRevision,
    storageLoadFailed: false,
    storageWriteFailed: false,
    console: { error() {} },
    takeSnapshot(data) {
      snapshotCalls += 1;
      snapshotArgument = data;
      if (failSnapshot) {
        const error = new Error('snapshot full');
        error.code = 'snapshot';
        throw error;
      }
    },
    showStorageConflict(revision) {
      calls.conflict = revision;
    },
    setStatus() {}
  });
  vm.runInContext([
    `let pendingV1Raw = ${JSON.stringify(raw)};`,
    appSource.slice(toStorableStart, toStorableEnd),
    appSource.slice(migrateStart, migrateEnd),
    'globalThis.migrate = migratePendingV1;',
    'globalThis.readFlags = () => ({ storageLoadFailed, storageWriteFailed, loadedRevision });'
  ].join('\n'), context);
  context.migrate();
  return {
    fake,
    snapshotCalls,
    snapshotArgument,
    calls,
    flags: context.readFlags()
  };
}

test('v1 migration copies the raw string, snapshots it, and writes schemaVersion 2', () => {
  const raw = JSON.stringify({ schemaVersion: 1, basics: { name: 'Ada' } });
  const resumeData = {
    basics: { name: 'Ada', title: '', location: '', email: '', phone: '', website: '' },
    exportName: '',
    summary: '',
    experience: [{ id: 'exp_1', role: '', company: '', dates: '', highlights: '' }],
    education: [{ id: 'edu_2', degree: '', school: '', dates: '' }],
    skills: ''
  };
  const result = runMigration({ raw, resumeData });
  assert.equal(result.fake.getItem('state-cv-premigration-v1'), raw);
  assert.equal(result.snapshotCalls, 1);
  assert.equal(result.snapshotArgument.basics.name, 'Ada');
  assert.equal(result.flags.storageLoadFailed, false);
  const saved = JSON.parse(result.fake.getItem('state-cv-data-v1'));
  assert.equal(saved.schemaVersion, 2);
  assert.deepEqual(saved.versions, []);
  assert.deepEqual(saved.master, resumeData);
  assert.equal(saved.revision, 1);
});

test('a failed premigration copy or snapshot does not write schemaVersion 2', () => {
  const raw = JSON.stringify({ schemaVersion: 1, basics: { name: 'Ada' } });
  const resumeData = { basics: { name: 'Ada' } };
  const copyFailed = runMigration({ raw, resumeData, failPremigration: true });
  assert.equal(copyFailed.fake.getItem('state-cv-data-v1'), raw);
  assert.equal(copyFailed.fake.getItem('state-cv-premigration-v1'), null);
  assert.equal(copyFailed.snapshotCalls, 0);
  assert.equal(copyFailed.flags.storageLoadFailed, true);
  assert.equal(copyFailed.flags.storageWriteFailed, true);

  const snapshotFailed = runMigration({ raw, resumeData, failSnapshot: true });
  assert.equal(snapshotFailed.fake.getItem('state-cv-data-v1'), raw);
  assert.equal(snapshotFailed.fake.getItem('state-cv-premigration-v1'), raw);
  assert.equal(snapshotFailed.snapshotCalls, 1);
  assert.equal(snapshotFailed.flags.storageLoadFailed, true);
});

test('an existing premigration copy is never overwritten', () => {
  const raw = JSON.stringify({ schemaVersion: 1, basics: { name: 'Ada' } });
  const result = runMigration({
    raw,
    resumeData: { basics: { name: 'Ada' } },
    existingPremigration: 'ORIGINAL'
  });
  assert.equal(result.fake.getItem('state-cv-premigration-v1'), 'ORIGINAL');
  assert.equal(JSON.parse(result.fake.getItem('state-cv-data-v1')).schemaVersion, 2);
});

test('a revision conflict during migration does not overwrite the other tab', () => {
  const raw = JSON.stringify({ schemaVersion: 1, basics: { name: 'This tab' } });
  const fake = memoryStorage();
  const stateStorage = createStorage(fake);
  stateStorage.writeData('state-cv-data-v1', { schemaVersion: 1, basics: { name: 'Other tab' } }, 0);
  const migrateStart = appSource.indexOf('function migratePendingV1() {');
  const migrateEnd = appSource.indexOf('\nfunction preserveDamagedData(', migrateStart);
  const toStorableStart = appSource.indexOf('function toStorable() {');
  const toStorableEnd = appSource.indexOf('\nfunction loadData()', toStorableStart);
  const calls = { conflict: null, snapshots: 0 };
  const context = vm.createContext({
    SCHEMA_VERSION: 2,
    PREMIGRATION_KEY: 'state-cv-premigration-v1',
    STORAGE_KEY: 'state-cv-data-v1',
    stateStorage,
    resumeData: { basics: { name: 'This tab' } },
    loadedRevision: 0,
    storageLoadFailed: false,
    storageWriteFailed: false,
    console: { error() {} },
    takeSnapshot() { calls.snapshots += 1; },
    showStorageConflict(revision) { calls.conflict = revision; },
    setStatus() {}
  });
  vm.runInContext([
    `let pendingV1Raw = ${JSON.stringify(raw)};`,
    appSource.slice(toStorableStart, toStorableEnd),
    appSource.slice(migrateStart, migrateEnd),
    'globalThis.migrate = migratePendingV1;'
  ].join('\n'), context);
  context.migrate();
  assert.equal(calls.conflict, 1);
  assert.equal(calls.snapshots, 1);
  assert.equal(JSON.parse(fake.getItem('state-cv-data-v1')).basics.name, 'Other tab');
  assert.equal(fake.getItem('state-cv-premigration-v1'), raw);
  assert.equal(context.storageLoadFailed, false);
});

test('loadData leaves a newer schema untouched and quarantines the raw value', () => {
  const raw = JSON.stringify({ schemaVersion: 3, master: { basics: { name: 'Future' } } });
  const fake = memoryStorage();
  fake.setItem('state-cv-data-v1', raw);
  const stateStorage = createStorage(fake);
  const loadStart = appSource.indexOf('function loadData() {');
  const loadEnd = appSource.indexOf('\nfunction preserveDamagedData(', loadStart);
  const preserveStart = loadEnd + 1;
  const preserveEnd = appSource.indexOf('\nfunction saveData(', preserveStart);
  const context = vm.createContext({
    STORAGE_KEY: 'state-cv-data-v1',
    stateStorage,
    normalizeData,
    structuredClone,
    freshResumeData: () => ({ basics: { name: '' } }),
    pendingV1Raw: null,
    loadedRevision: 0,
    storageLoadFailed: false,
    storageDamaged: false,
    damagedRaw: null,
    damagedCopyStored: false,
    console: { warn() {}, error() {} }
  });
  vm.runInContext([
    appSource.slice(loadStart, loadEnd),
    appSource.slice(preserveStart, preserveEnd),
    'globalThis.loadDataFromApp = loadData;'
  ].join('\n'), context);
  const loaded = context.loadDataFromApp();
  assert.equal(loaded.basics.name, '');
  assert.equal(fake.getItem('state-cv-data-v1'), raw);
  assert.equal(fake.getItem('state-cv-damaged-v1'), raw);
  assert.equal(context.storageLoadFailed, true);
  assert.equal(context.storageDamaged, true);
});
