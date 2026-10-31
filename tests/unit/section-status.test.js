const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const appSource = fs.readFileSync(path.join(__dirname, '../../app.js'), 'utf8');
const helperStart = appSource.indexOf('function getSectionStatus(data) {');
const helperEnd = appSource.indexOf('\nfunction updateCompletion()', helperStart);
assert.ok(helperStart >= 0 && helperEnd > helperStart, 'Could not isolate getSectionStatus from app.js');

const sandbox = vm.createContext({});
vm.runInContext(`${appSource.slice(helperStart, helperEnd)}\nglobalThis.getSectionStatus = getSectionStatus;`, sandbox);

const { getSectionStatus } = sandbox;
const plain = (value) => JSON.parse(JSON.stringify(value));
const none = { contact: false, summary: false, experience: false, education: false, skills: false };

const emptyCv = () => ({
  basics: { name: '', title: '', location: '', email: '', phone: '', website: '' },
  summary: '',
  experience: [{ role: '', company: '', dates: '', highlights: '' }],
  education: [{ degree: '', school: '', dates: '' }],
  skills: ''
});

test('an empty or missing CV has no complete sections', () => {
  assert.deepEqual(plain(getSectionStatus(undefined)), none);
  assert.deepEqual(plain(getSectionStatus(null)), none);
  assert.deepEqual(plain(getSectionStatus([])), none);
  assert.deepEqual(plain(getSectionStatus({})), none);
  assert.deepEqual(plain(getSectionStatus(emptyCv())), none);
  const blank = emptyCv();
  blank.basics.name = '   ';
  blank.basics.title = '\n';
  blank.basics.email = ' ';
  blank.summary = '  ';
  blank.skills = '\t';
  blank.experience[0].role = ' ';
  blank.experience[0].highlights = 'Shipped something';
  blank.education[0].dates = '2014';
  assert.deepEqual(plain(getSectionStatus(blank)), none);
});

test('contact is complete only when name, title, and email are filled', () => {
  const data = emptyCv();
  data.basics.name = 'Alex Morgan';
  data.basics.title = 'Product Designer';
  assert.equal(getSectionStatus(data).contact, false);
  data.basics.email = 'alex@example.com';
  assert.equal(getSectionStatus(data).contact, true);
  assert.equal(getSectionStatus(data).summary, false);
});

test('summary and skills follow their own fields', () => {
  const summary = emptyCv();
  summary.summary = 'Builds clear tools.';
  assert.equal(getSectionStatus(summary).summary, true);
  assert.equal(getSectionStatus(summary).skills, false);

  const skills = emptyCv();
  skills.skills = 'Figma, research';
  assert.equal(getSectionStatus(skills).skills, true);
  assert.equal(getSectionStatus(skills).summary, false);
});

test('experience and education need a role, company, degree, or school', () => {
  const roleOnly = emptyCv();
  roleOnly.experience = [{ role: 'Designer', company: '', dates: '', highlights: '' }];
  assert.equal(getSectionStatus(roleOnly).experience, true);

  const companyOnly = emptyCv();
  companyOnly.experience = [
    { role: '', company: '', dates: '', highlights: 'Only a bullet' },
    { role: '', company: 'Northstar Labs', dates: '', highlights: '' }
  ];
  assert.equal(getSectionStatus(companyOnly).experience, true);

  const degreeOnly = emptyCv();
  degreeOnly.education = [{ degree: 'BFA', school: '', dates: '' }];
  assert.equal(getSectionStatus(degreeOnly).education, true);

  const schoolOnly = emptyCv();
  schoolOnly.education = [{ degree: '  ', school: 'State University', dates: '' }];
  assert.equal(getSectionStatus(schoolOnly).education, true);
  assert.equal(getSectionStatus(schoolOnly).experience, false);
});

test('a filled CV marks every section complete and does not change the input', () => {
  const data = {
    basics: { name: 'Alex Morgan', title: 'Product Designer', email: 'alex@example.com' },
    summary: 'Builds clear tools.',
    experience: [{ role: 'Designer', company: 'Studio' }],
    education: [{ degree: '', school: 'State University' }],
    skills: 'Figma'
  };
  const before = JSON.stringify(data);
  assert.deepEqual(plain(getSectionStatus(data)), {
    contact: true,
    summary: true,
    experience: true,
    education: true,
    skills: true
  });
  assert.equal(JSON.stringify(data), before);
});
