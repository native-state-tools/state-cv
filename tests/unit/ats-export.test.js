const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const exportSource = fs.readFileSync(path.join(__dirname, '../../cv-export.js'), 'utf8');
const helperStart = exportSource.indexOf('function toPdfText(text) {');
const helperEnd = exportSource.indexOf('\nfunction exportPdf() {', helperStart);
assert.ok(helperStart >= 0 && helperEnd > helperStart, 'Could not isolate PDF text helpers from cv-export.js');

const sandbox = vm.createContext({});
vm.runInContext([
  exportSource.slice(helperStart, helperEnd),
  'globalThis.toPdfText = toPdfText;',
  'globalThis.findUnsupportedChars = findUnsupportedChars;',
  'globalThis.cvToPlainText = cvToPlainText;'
].join('\n'), sandbox);

const { toPdfText, findUnsupportedChars, cvToPlainText } = sandbox;
const plain = (value) => JSON.parse(JSON.stringify(value));

test('toPdfText maps smart quotes, dashes, ellipsis, and bullets', () => {
  assert.equal(toPdfText('\u201CQuote\u201D and \u2018single\u2019'), '"Quote" and \'single\'');
  assert.equal(toPdfText('2019 \u2013 2021 \u2014 now'), '2019 - 2021 - now');
  assert.equal(toPdfText('Wait\u2026'), 'Wait...');
  assert.equal(toPdfText('\u2022 bullet \u25CF square'), '- bullet - square');
  assert.equal(toPdfText('Jos\u00e9 M\u00fcller'), 'Jos\u00e9 M\u00fcller');
});

test('findUnsupportedChars names letters the PDF font cannot draw', () => {
  const name = '\u0141ukasz \u0110\u1EB7ng';
  assert.equal(name, 'Łukasz Đặng');
  assert.deepEqual(plain(findUnsupportedChars({ basics: { name } })), ['\u0141', '\u0110', '\u1EB7']);
  assert.deepEqual(plain(findUnsupportedChars({
    basics: { name: 'Jos\u00e9 M\u00fcller' },
    summary: '\u201CQuoted\u201D \u2013 done \u2022 now\u2026'
  })), []);
  assert.deepEqual(plain(findUnsupportedChars({
    experience: [{ highlights: 'Shipped \u2192 launch' }],
    education: [{ degree: '\u0110' }]
  })), ['\u2192', '\u0110']);
});

test('cvToPlainText keeps importer headings and role, company, date order', () => {
  const text = cvToPlainText({
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
      highlights: 'Redesigned onboarding\n\u2022 Shipped the system'
    }],
    education: [{
      degree: 'BFA, Interaction Design',
      school: 'State University',
      dates: '2014 - 2018'
    }],
    skills: 'Figma, research'
  });
  const role = text.indexOf('Senior Product Designer');
  const company = text.indexOf('Northstar Labs');
  const dates = text.indexOf('2020 - 2024');
  assert.ok(text.indexOf('Experience') !== -1 && text.indexOf('Experience') < role);
  assert.ok(role !== -1 && role < company && company < dates);
  assert.ok(text.indexOf('- Redesigned onboarding') > dates);
  assert.equal(text.includes('- Shipped the system'), true);
  const degree = text.indexOf('BFA, Interaction Design');
  const school = text.indexOf('State University');
  const eduDates = text.indexOf('2014 - 2018');
  assert.ok(text.indexOf('Education') !== -1 && text.indexOf('Education') < degree);
  assert.ok(degree !== -1 && degree < school && school < eduDates);
  assert.equal(text.includes('Professional Summary'), true);
  assert.equal(text.includes('Skills'), true);
  assert.equal(
    text.includes('Austin, TX | alex@example.com | (555) 123-4567 | linkedin.com/in/alexmorgan'),
    true
  );
  assert.equal(text.includes('Your Name'), false);
  assert.equal(text.includes('Professional Title'), false);
  assert.equal(/\bRole\b/.test(text), false);
  assert.equal(/\bDegree\b/.test(text), false);
});

test('cvToPlainText skips empty fields and empty sections', () => {
  assert.equal(cvToPlainText({}), '');
  assert.equal(cvToPlainText({
    basics: { name: '', title: '', email: 'a@b.co' },
    experience: [{ role: '', company: '', dates: '', highlights: '' }],
    education: [{ degree: '', school: 'State University', dates: '' }],
    summary: '   ',
    skills: ''
  }), 'a@b.co\n\nEducation\nState University');
});
