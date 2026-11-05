const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const appSource = fs.readFileSync(path.join(__dirname, '../../app.js'), 'utf8');
const exportSource = fs.readFileSync(path.join(__dirname, '../../cv-export.js'), 'utf8');

const versionStart = appSource.indexOf('function createVersion(name, makeId) {');
const versionEnd = appSource.indexOf('\nfunction entryCardTitle(type, item)', versionStart);
assert.ok(versionStart >= 0 && versionEnd > versionStart, 'Could not isolate version helpers from app.js');

const versionSandbox = vm.createContext({});
vm.runInContext([
  appSource.slice(versionStart, versionEnd),
  'globalThis.createVersion = createVersion;',
  'globalThis.duplicateVersion = duplicateVersion;',
  'globalThis.applyVersion = applyVersion;'
].join('\n'), versionSandbox);
const { createVersion, duplicateVersion, applyVersion } = versionSandbox;

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
assert.ok(normalizerEnd > normalizerStart, 'Could not isolate normalizeData from app.js');

const normalizerSandbox = vm.createContext({});
vm.runInContext([
  ...declarations,
  appSource.slice(errorStart, errorEnd),
  appSource.slice(normalizerStart, normalizerEnd),
  'globalThis.normalizeData = normalizeData;',
  'globalThis.assignEntryIds = assignEntryIds;'
].join('\n'), normalizerSandbox);
const parseInSandbox = vm.runInContext('JSON.parse', normalizerSandbox);
const plain = (value) => JSON.parse(JSON.stringify(value));

function normalizeData(data, options = {}) {
  let sequence = 0;
  const makeId = typeof options.makeId === 'function' ? options.makeId : (prefix) => `${prefix}${++sequence}`;
  return normalizerSandbox.normalizeData(parseInSandbox(JSON.stringify(data)), { ...options, makeId });
}

const helperStart = exportSource.indexOf('function toPdfText(text) {');
const helperEnd = exportSource.indexOf('\nfunction exportPdf(data) {', helperStart);
assert.ok(helperEnd > helperStart, 'Could not isolate cvToPlainText from cv-export.js');
const exportSandbox = vm.createContext({});
vm.runInContext([
  exportSource.slice(helperStart, helperEnd),
  'globalThis.cvToPlainText = cvToPlainText;'
].join('\n'), exportSandbox);

const master = {
  basics: { name: 'Ada Lovelace' },
  summary: 'Wrote the notes.',
  experience: [
    { id: 'exp_1', role: 'Analyst', company: 'Engines', dates: '1842', highlights: 'Published notes.' },
    { id: 'exp_2', role: 'Inventor', company: 'Home', dates: '1833', highlights: 'Built a model.' }
  ],
  education: [
    { id: 'edu_1', degree: 'Mathematics', school: 'Home', dates: '1835' },
    { id: 'edu_2', degree: 'Science', school: 'Library', dates: '1840' }
  ],
  skills: 'Mathematics'
};

test('applyVersion hides only the chosen entries and does not mutate the master', () => {
  const before = plain(master);
  const result = applyVersion(master, {
    id: 'ver_1',
    name: 'Short',
    hiddenEntries: ['exp_2', 'edu_1', 'missing']
  });
  assert.deepEqual(result.experience.map((item) => item.id), ['exp_1']);
  assert.deepEqual(result.education.map((item) => item.id), ['edu_2']);
  assert.equal(result.basics.name, 'Ada Lovelace');
  assert.equal(result.summary, 'Wrote the notes.');
  assert.notEqual(result, master);
  assert.notEqual(result.experience, master.experience);
  assert.notEqual(result.experience[0], master.experience[0]);
  result.experience[0].role = 'Changed';
  result.basics.name = 'Changed';
  assert.deepEqual(plain(master), before);

  const unchanged = applyVersion(master, null);
  assert.deepEqual(unchanged.experience.map((item) => item.id), ['exp_1', 'exp_2']);
  assert.deepEqual(unchanged.education.map((item) => item.id), ['edu_1', 'edu_2']);
  assert.notEqual(unchanged, master);
  unchanged.experience.pop();
  assert.equal(master.experience.length, 2);

  const emptyExperience = applyVersion(master, { hiddenEntries: ['exp_1', 'exp_2'] });
  assert.deepEqual(emptyExperience.experience, []);
  assert.equal(master.experience.length, 2);
  const text = exportSandbox.cvToPlainText(plain(emptyExperience));
  assert.equal(text.includes('Experience'), false);
  assert.equal(text.includes('Inventor'), false);
  assert.equal(text.includes('Mathematics'), true);
});

test('duplicateVersion names the copy and keeps going when that name is taken', () => {
  let prefix = '';
  const hidden = ['exp_1'];
  const version = { id: 'ver_1', name: 'Frontend', hiddenEntries: hidden };
  const first = duplicateVersion(version, ['Frontend'], (value) => {
    prefix = value;
    return `${value}new`;
  });
  assert.equal(prefix, 'ver_');
  assert.equal(first.id, 'ver_new');
  assert.equal(first.name, 'Frontend copy');
  assert.deepEqual(first.hiddenEntries, ['exp_1']);
  first.hiddenEntries.push('exp_9');
  assert.deepEqual(hidden, ['exp_1']);

  assert.equal(duplicateVersion(version, ['Frontend copy'], () => 'ver_2').name, 'Frontend copy 2');
  assert.equal(
    duplicateVersion(version, ['Frontend copy', 'Frontend copy 2'], () => 'ver_3').name,
    'Frontend copy 3'
  );
  assert.equal(duplicateVersion({ name: '   ' }, [], () => 'ver_4').name, 'Untitled version copy');
});

test('createVersion trims the name and stores nothing as hidden', () => {
  let prefix = '';
  const created = createVersion('  Acme  ', (value) => {
    prefix = value;
    return `${value}1`;
  });
  assert.equal(prefix, 'ver_');
  assert.deepEqual(plain(created), { id: 'ver_1', name: 'Acme', hiddenEntries: [] });
  assert.equal(createVersion('   ', () => 'ver_blank').name, 'Untitled version');
  assert.equal(createVersion('N'.repeat(150), () => 'ver_long').name.length, 120);
});

test('normalizeVersionList fixes bad ids, duplicate ids, blank names, a 51st item, and unknown hidden entries', () => {
  const versions = normalizeData({
    schemaVersion: 2,
    master: {
      experience: [{ id: 'exp_keep', role: 'A' }, { id: 'exp_other', role: 'B' }],
      education: [{ id: 'edu_keep', degree: 'BSc' }]
    },
    versions: [
      { id: 'ver_ok', name: '  Frontend  ', hiddenEntries: ['exp_keep', 'nope', 'exp_keep', 4, 'edu_keep'] },
      { id: 'bad id', name: 'Nope' },
      { id: 'ver_ok', name: 'Duplicate' },
      { id: 'ver_blank', name: '   ' },
      { id: 'ver_bad_hidden', name: 'Plain', hiddenEntries: 'exp_keep' },
      { id: `ver_${'x'.repeat(80)}`, name: 'Too long' }
    ]
  }, { strict: true }).versions;
  assert.deepEqual(plain(versions), [
    { id: 'ver_ok', name: 'Frontend', hiddenEntries: ['exp_keep', 'edu_keep'] },
    { id: 'ver_blank', name: 'Untitled version', hiddenEntries: [] },
    { id: 'ver_bad_hidden', name: 'Plain', hiddenEntries: [] }
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

test('assignEntryIds replaces ids that are too long or use other characters', () => {
  let sequence = 0;
  const longId = 'e'.repeat(81);
  const records = normalizerSandbox.assignEntryIds([
    { id: 'exp_ok', role: 'A' },
    { id: 'bad id', role: 'B' },
    { id: longId, role: 'C' },
    { id: 'exp_ok', role: 'D' }
  ], 'exp_', (prefix) => `${prefix}${++sequence}`);
  assert.equal(records[0].id, 'exp_ok');
  assert.notEqual(records[1].id, 'bad id');
  assert.match(records[1].id, /^[A-Za-z0-9_-]{1,80}$/);
  assert.notEqual(records[2].id, longId);
  assert.match(records[2].id, /^[A-Za-z0-9_-]{1,80}$/);
  assert.notEqual(records[3].id, 'exp_ok');
  assert.equal(records[1].role, 'B');
});
