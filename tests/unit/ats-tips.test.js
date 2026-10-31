const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const exportSource = fs.readFileSync(path.join(__dirname, '../../cv-export.js'), 'utf8');
const helperStart = exportSource.indexOf('function toPdfText(text) {');
const helperEnd = exportSource.indexOf('\nfunction cvToPlainText(data) {', helperStart);
assert.ok(helperStart >= 0 && helperEnd > helperStart, 'Could not isolate ATS tip helpers from cv-export.js');

const sandbox = vm.createContext({});
vm.runInContext([
  exportSource.slice(helperStart, helperEnd),
  'globalThis.getAtsTips = getAtsTips;'
].join('\n'), sandbox);

const { getAtsTips } = sandbox;
const plain = (value) => JSON.parse(JSON.stringify(value));

const completeCv = () => ({
  basics: {
    name: 'Alex Morgan',
    title: 'Product Designer',
    location: 'Austin, TX',
    email: 'alex@example.com',
    phone: '(555) 123-4567',
    website: 'linkedin.com/in/alexmorgan'
  },
  summary: 'Builds clear tools.',
  experience: [{
    role: 'Senior Product Designer',
    company: 'Northstar Labs',
    dates: '2020 - 2024',
    highlights: 'Redesigned onboarding'
  }],
  education: [{
    degree: 'BFA, Interaction Design',
    school: 'State University',
    dates: '2014 - 2018'
  }],
  skills: 'Figma, research'
});

test('an empty CV gives the missing-field tips', () => {
  const missing = [
    'Add your name.',
    'Add your email.',
    'Add your phone number.',
    'Add a professional summary.',
    'Add your skills.'
  ];
  assert.deepEqual(plain(getAtsTips({})), missing);
  assert.deepEqual(plain(getAtsTips({
    basics: { name: '  ', email: '', phone: '' },
    summary: '',
    skills: '   ',
    experience: [{ role: '', company: '', dates: '', highlights: '' }],
    education: [{ degree: '', school: '', dates: '' }]
  })), missing);
});

test('a complete CV gives no tips', () => {
  const data = completeCv();
  data.experience.push({ role: '', company: '', dates: '', highlights: '' });
  data.education.push({ degree: '', school: '', dates: '' });
  assert.deepEqual(plain(getAtsTips(data)), []);
});

test('an undated entry names how many in that section', () => {
  const experience = completeCv();
  experience.experience[0].dates = '';
  assert.deepEqual(plain(getAtsTips(experience)), ['1 experience entry has no dates.']);

  const education = completeCv();
  education.education[0].dates = '   ';
  assert.deepEqual(plain(getAtsTips(education)), ['1 education entry has no dates.']);

  const several = completeCv();
  several.experience[0].dates = '';
  several.experience.push({ role: 'Designer', company: 'Studio', dates: '', highlights: 'Shipped the portal' });
  assert.deepEqual(plain(getAtsTips(several)), ['2 experience entries have no dates.']);
});

test('a bullet over 200 characters names how many', () => {
  const data = completeCv();
  data.experience[0].highlights = 'a'.repeat(200);
  assert.deepEqual(plain(getAtsTips(data)), []);
  data.experience[0].highlights = `${'b'.repeat(201)}\nshort line`;
  assert.deepEqual(plain(getAtsTips(data)), ['1 bullet is longer than 200 characters.']);
  data.experience[0].highlights = `${'c'.repeat(201)}\n${'d'.repeat(240)}`;
  assert.deepEqual(plain(getAtsTips(data)), ['2 bullets are longer than 200 characters.']);
});

test('an unsupported character such as Łukasz is named in a tip', () => {
  const data = completeCv();
  data.basics.name = '\u0141ukasz';
  assert.equal(data.basics.name, 'Łukasz');
  assert.deepEqual(plain(getAtsTips(data)), ['Unsupported characters: \u0141.']);
});
