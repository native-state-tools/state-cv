const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const appSource = fs.readFileSync(path.join(__dirname, '../../app.js'), 'utf8');
const exportSource = fs.readFileSync(path.join(__dirname, '../../cv-export.js'), 'utf8');
const helperStart = appSource.indexOf('function completionPercent(data) {');
const helperEnd = appSource.indexOf('\nfunction updateCompletion()', helperStart);
assert.ok(helperStart >= 0 && helperEnd > helperStart, 'Could not isolate completion helpers from app.js');
const atsStart = exportSource.indexOf('function toPdfText(text) {');
const atsEnd = exportSource.indexOf('\nfunction cvToPlainText(data) {', atsStart);
assert.ok(atsStart >= 0 && atsEnd > atsStart, 'Could not isolate ATS tip helpers from cv-export.js');

const sandbox = vm.createContext({});
vm.runInContext([
  appSource.slice(helperStart, helperEnd),
  exportSource.slice(atsStart, atsEnd),
  'globalThis.completionPercent = completionPercent;',
  'globalThis.completionStatusText = completionStatusText;',
  'globalThis.getSectionStatus = getSectionStatus;',
  'globalThis.getAtsTips = getAtsTips;'
].join('\n'), sandbox);

const { completionPercent, completionStatusText, getSectionStatus, getAtsTips } = sandbox;
const plain = (value) => JSON.parse(JSON.stringify(value));

function emptyCv() {
  return {
    basics: { name: '', title: '', location: '', email: '', phone: '', website: '' },
    summary: '',
    experience: [{ role: '', company: '', dates: '', highlights: '' }],
    education: [{ degree: '', school: '', dates: '' }],
    skills: ''
  };
}

function filledCv() {
  return {
    basics: {
      name: 'Alex Morgan',
      title: 'Product Designer',
      location: 'Austin, TX',
      email: 'alex@example.com',
      phone: '',
      website: ''
    },
    summary: 'Builds clear tools.',
    experience: [{ role: 'Designer', company: 'Northstar', dates: '2020 - 2024', highlights: '' }],
    education: [{ degree: 'BFA', school: 'State University', dates: '2014 - 2018' }],
    skills: 'Research'
  };
}

test('seven equal master checks round to the existing percentages', () => {
  const data = emptyCv();
  assert.equal(completionPercent(data), 0);
  data.basics.name = 'Alex';
  assert.equal(completionPercent(data), 14);
  data.basics.title = 'Designer';
  assert.equal(completionPercent(data), 29);
  data.basics.email = 'alex@example.com';
  assert.equal(completionPercent(data), 43);
  data.summary = 'Builds clear tools.';
  assert.equal(completionPercent(data), 57);
  data.experience[0].role = 'Designer';
  assert.equal(completionPercent(data), 71);
  data.education[0].school = 'State University';
  assert.equal(completionPercent(data), 86);
  data.skills = 'Research';
  assert.equal(completionPercent(data), 100);
});

test('spaces count for the percentage while section checks ignore them', () => {
  const data = emptyCv();
  data.basics.name = ' ';
  data.basics.title = ' ';
  data.basics.email = ' ';
  assert.equal(completionPercent(data), 43);
  assert.equal(getSectionStatus(data).contact, false);
});

test('phone, location, dates, and highlight-only entries stay out of the percentage', () => {
  const data = emptyCv();
  data.basics.phone = '555-0100';
  data.basics.location = 'Austin, TX';
  data.basics.website = 'example.com';
  data.experience[0].highlights = 'Shipped the checklist';
  data.experience[0].dates = '2020 - 2024';
  assert.equal(completionPercent(data), 0);
});

test('a full percentage can still have an ATS phone suggestion, and a missing title does not', () => {
  const missingPhone = filledCv();
  assert.equal(completionPercent(missingPhone), 100);
  assert.deepEqual(plain(getAtsTips(missingPhone)), ['Add your phone number.']);

  const missingTitle = filledCv();
  missingTitle.basics.phone = '555-0100';
  missingTitle.basics.title = '';
  missingTitle.experience[0].dates = '2020 - 2024';
  assert.equal(completionPercent(missingTitle), 86);
  assert.deepEqual(plain(getAtsTips(missingTitle)), []);
});

test('status text keeps the 70 percent threshold without a readiness label', () => {
  assert.equal(completionStatusText(0), 'Add your details');
  assert.equal(completionStatusText(57), 'Add your details');
  assert.equal(completionStatusText(69), 'Add your details');
  assert.equal(completionStatusText(70), 'Looking strong');
  assert.equal(completionStatusText(71), 'Looking strong');
  assert.equal(completionStatusText(100), 'Looking strong');
});

test('the score reads the master CV and ATS tips read the exported version', () => {
  const updateStart = appSource.indexOf('function updateCompletion()');
  const updateEnd = appSource.indexOf('\nfunction updateSectionChecks(', updateStart);
  const updateBody = appSource.slice(updateStart, updateEnd);
  assert.match(updateBody, /completionPercent\(resumeData\)/);
  assert.doesNotMatch(updateBody, /currentExportData\(\)/);
  assert.match(appSource, /const tips = getAtsTips\(currentExportData\(\)\);/);
});
