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
  'globalThis.applyVersion = applyVersion;',
  'globalThis.splitBullets = splitBullets;',
  'globalThis.splitSkillList = splitSkillList;'
].join('\n'), versionSandbox);
const { createVersion, duplicateVersion, applyVersion, splitBullets, splitSkillList } = versionSandbox;

function storedVersion(fields) {
  return {
    hiddenBullets: {},
    hiddenSkills: [],
    title: '',
    summary: '',
    exportName: '',
    ...fields
  };
}

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
  const hiddenBullets = { exp_1: ['Alpha'] };
  const version = {
    id: 'ver_1',
    name: 'Frontend',
    hiddenEntries: hidden,
    hiddenBullets,
    hiddenSkills: ['Java'],
    title: 'Engineer',
    summary: 'Notes',
    exportName: 'Ada file'
  };
  const first = duplicateVersion(version, ['Frontend'], (value) => {
    prefix = value;
    return `${value}new`;
  });
  assert.equal(prefix, 'ver_');
  assert.equal(first.id, 'ver_new');
  assert.equal(first.name, 'Frontend copy');
  assert.deepEqual(first.hiddenEntries, ['exp_1']);
  assert.deepEqual(plain(first.hiddenBullets), { exp_1: ['Alpha'] });
  assert.deepEqual(plain(first.hiddenSkills), ['Java']);
  assert.equal(first.title, 'Engineer');
  assert.equal(first.summary, 'Notes');
  assert.equal(first.exportName, 'Ada file');
  first.hiddenEntries.push('exp_9');
  first.hiddenBullets.exp_1.push('Beta');
  first.hiddenSkills.push('SQL');
  assert.deepEqual(hidden, ['exp_1']);
  assert.deepEqual(hiddenBullets, { exp_1: ['Alpha'] });
  assert.deepEqual(version.hiddenSkills, ['Java']);

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
  assert.deepEqual(plain(created), storedVersion({ id: 'ver_1', name: 'Acme', hiddenEntries: [] }));
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
    storedVersion({ id: 'ver_ok', name: 'Frontend', hiddenEntries: ['exp_keep', 'edu_keep'] }),
    storedVersion({ id: 'ver_blank', name: 'Untitled version', hiddenEntries: [] }),
    storedVersion({ id: 'ver_bad_hidden', name: 'Plain', hiddenEntries: [] })
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

test('applyVersion hides bullets by text, skills case-insensitively, and overrides only when filled', () => {
  const source = {
    basics: { name: 'Ada Lovelace', title: 'Master title' },
    summary: 'Master summary',
    experience: [
      { id: 'exp_1', role: 'Analyst', highlights: '- Alpha\n* Beta\n\u2022 Gamma' },
      { id: 'exp_2', role: 'Inventor', highlights: '- Keep\n- Drop' }
    ],
    education: [{ id: 'edu_1', degree: 'Mathematics' }],
    skills: 'Figma, Research, Prototyping'
  };
  const before = plain(source);
  assert.deepEqual(plain(splitBullets(source.experience[0].highlights)), ['Alpha', 'Beta', 'Gamma']);
  assert.deepEqual(plain(splitSkillList('Figma, user research | prototyping; accessibility')), [
    'Figma',
    'user research',
    'prototyping',
    'accessibility'
  ]);

  const hidden = applyVersion(source, {
    hiddenEntries: [],
    hiddenBullets: { exp_1: ['  - Beta  '], exp_2: ['Drop'] },
    hiddenSkills: ['research'],
    title: '',
    summary: '   '
  });
  assert.equal(hidden.experience[0].highlights, '- Alpha\n\u2022 Gamma');
  assert.equal(hidden.experience[1].highlights, '- Keep');
  assert.equal(hidden.skills, 'Figma, Prototyping');
  assert.equal(hidden.basics.title, 'Master title');
  assert.equal(hidden.summary, 'Master summary');
  assert.notEqual(hidden.experience[0], source.experience[0]);

  const reordered = applyVersion({
    ...source,
    experience: [{ id: 'exp_1', highlights: '\u2022 Gamma\n- Alpha\n* Beta' }]
  }, { hiddenBullets: { exp_1: ['Beta'] } });
  assert.equal(reordered.experience[0].highlights, '\u2022 Gamma\n- Alpha');

  const overridden = applyVersion(source, { title: 'Version title', summary: 'Version summary' });
  assert.equal(overridden.basics.title, 'Version title');
  assert.equal(overridden.summary, 'Version summary');
  assert.equal(overridden.skills, source.skills);
  overridden.basics.title = 'Changed';
  overridden.summary = 'Changed';
  overridden.skills = 'Changed';
  overridden.experience[0].highlights = 'Changed';
  assert.deepEqual(plain(source), before);

  const piped = applyVersion({ skills: 'Alpha | Beta | Gamma' }, { hiddenSkills: ['BETA'] });
  assert.equal(piped.skills, 'Alpha | Gamma');

  const untouched = applyVersion(source, null);
  assert.equal(untouched.basics.title, 'Master title');
  assert.equal(untouched.summary, 'Master summary');
  assert.equal(untouched.experience[0].highlights, source.experience[0].highlights);
  untouched.experience.pop();
  assert.equal(source.experience.length, 2);
});

test('normalizeVersionList drops bad hidden bullets and skills without rejecting the file', () => {
  const manyBullets = Array.from({ length: 201 }, (_, index) => `Bullet ${index}`);
  const manySkills = Array.from({ length: 201 }, (_, index) => `Skill ${index}`);
  const versions = normalizeData({
    schemaVersion: 2,
    master: {
      experience: [{ id: 'exp_keep', role: 'A' }],
      education: [{ id: 'edu_keep', degree: 'BSc' }]
    },
    versions: [{
      id: 'ver_ok',
      name: 'Frontend',
      hiddenBullets: {
        exp_keep: ['  - Kept  ', '- Kept', 'Second', 4, 'x'.repeat(10001), ...manyBullets],
        edu_keep: ['Not experience'],
        missing: ['Gone']
      },
      hiddenSkills: ['Alpha', ' alpha ', 3, 'b'.repeat(201), 'Beta', ...manySkills],
      title: `T${'t'.repeat(250)}`,
      summary: 'S'.repeat(600),
      exportName: 'E'.repeat(150)
    }, {
      id: 'ver_bad',
      name: 'Bad',
      hiddenBullets: 'nope',
      hiddenSkills: { skill: 'Alpha' },
      title: 5,
      summary: null,
      exportName: { name: 'file' }
    }]
  }, { strict: true }).versions;

  const keptBullets = plain(versions[0].hiddenBullets.exp_keep);
  assert.deepEqual(keptBullets.slice(0, 3), ['Kept', 'Second', 'Bullet 0']);
  assert.equal(keptBullets.length, 200);
  assert.equal(keptBullets.includes('x'.repeat(10001)), false);
  assert.equal(versions[0].hiddenBullets.edu_keep, undefined);
  assert.equal(versions[0].hiddenBullets.missing, undefined);
  assert.equal(versions[0].hiddenSkills[0], 'Alpha');
  assert.equal(versions[0].hiddenSkills[1], 'Beta');
  assert.equal(versions[0].hiddenSkills.length, 200);
  assert.equal(versions[0].title.length, 200);
  assert.equal(versions[0].summary.length, 500);
  assert.equal(versions[0].exportName.length, 120);
  assert.deepEqual(plain(versions[1].hiddenBullets), {});
  assert.deepEqual(plain(versions[1].hiddenSkills), []);
  assert.equal(versions[1].title, '');
  assert.equal(versions[1].summary, '');
  assert.equal(versions[1].exportName, '');

  assert.doesNotThrow(() => normalizeData({
    schemaVersion: 2,
    master: { experience: [{ id: 'exp_keep', role: 'A' }] },
    versions: [{ id: 'ver_ok', name: 'Frontend', hiddenBullets: null, hiddenSkills: 'nope', title: 9 }]
  }, { strict: false }));
});

test('toStorable drops unmatched hidden bullets and skills, and keeps a removed entry during undo', () => {
  const toStorableStart = appSource.indexOf('function toStorable() {');
  const toStorableEnd = appSource.indexOf('\nfunction loadData()', toStorableStart);
  const storeSandbox = vm.createContext({
    SCHEMA_VERSION: 2,
    resumeData: {
      skills: 'Alpha, Beta',
      experience: [{ id: 'exp_1', highlights: '- Alpha\n- Beta' }],
      education: []
    },
    cvVersions: [{
      id: 'ver_1',
      name: 'Short',
      hiddenEntries: ['exp_1', 'exp_gone'],
      hiddenBullets: { exp_1: ['Beta', '- Beta', 'Missing'], exp_missing: ['Nope'] },
      hiddenSkills: ['beta', 'Gone', 'BETA'],
      title: 'T',
      summary: 'S',
      exportName: 'File'
    }],
    pendingEntryRemoval: null
  });
  vm.runInContext([
    appSource.slice(versionStart, versionEnd),
    appSource.slice(toStorableStart, toStorableEnd),
    'globalThis.toStorable = toStorable;'
  ].join('\n'), storeSandbox);

  const saved = plain(storeSandbox.toStorable());
  assert.deepEqual(saved.versions[0].hiddenEntries, ['exp_1']);
  assert.deepEqual(saved.versions[0].hiddenBullets, { exp_1: ['Beta'] });
  assert.deepEqual(saved.versions[0].hiddenSkills, ['beta']);
  assert.equal(saved.versions[0].title, 'T');
  assert.equal(saved.versions[0].exportName, 'File');

  storeSandbox.resumeData = { skills: 'Alpha', experience: [], education: [] };
  storeSandbox.cvVersions[0].hiddenEntries = ['exp_undo'];
  storeSandbox.cvVersions[0].hiddenBullets = { exp_undo: ['Secret', 'Old'] };
  storeSandbox.pendingEntryRemoval = {
    list: 'experience',
    item: { id: 'exp_undo', highlights: '- Secret' }
  };
  const duringUndo = plain(storeSandbox.toStorable());
  assert.deepEqual(duringUndo.versions[0].hiddenEntries, ['exp_undo']);
  assert.deepEqual(duringUndo.versions[0].hiddenBullets, { exp_undo: ['Secret'] });

  storeSandbox.pendingEntryRemoval = null;
  const afterWindow = plain(storeSandbox.toStorable());
  assert.deepEqual(afterWindow.versions[0].hiddenEntries, []);
  assert.deepEqual(afterWindow.versions[0].hiddenBullets, {});
});
