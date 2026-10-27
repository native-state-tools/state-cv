const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const appSource = fs.readFileSync(path.join(__dirname, '../../app.js'), 'utf8');

function sliceBetween(startMarker, endMarker) {
  const start = appSource.indexOf(startMarker);
  const end = appSource.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0 && end > start, `Could not isolate ${startMarker} from app.js`);
  return appSource.slice(start, end);
}

const sandbox = vm.createContext({});
vm.runInContext([
  sliceBetween('function pdfItemBoxes(items) {', '\nasync function extractPdfText('),
  sliceBetween('function dateLine(line) {', '\nfunction mergeWrappedLines('),
  sliceBetween('function parseEducation(lines) {', '\nfunction splitSkills('),
  sliceBetween('function splitSkills(lines) {', '\nfunction detectContact('),
  sliceBetween('function detectContact(text) {', '\nfunction importPdfLines('),
  'globalThis.pdfItemsToLines = pdfItemsToLines;',
  'globalThis.dateLine = dateLine;',
  'globalThis.extractDate = extractDate;',
  'globalThis.parseEducation = parseEducation;',
  'globalThis.splitSkills = splitSkills;',
  'globalThis.detectContact = detectContact;'
].join('\n'), sandbox);

const { pdfItemsToLines, dateLine, extractDate, parseEducation, splitSkills, detectContact } = sandbox;
const plain = (value) => JSON.parse(JSON.stringify(value));

test('detectContact reads phone formats and skips dates, ids, and the email domain', () => {
  const formats = ['+1 (555) 123-4567', '555-123-4567', '555.123.4567', '+44 20 7946 0958'];
  formats.forEach((phone) => {
    const contact = detectContact([
      'Alex Morgan',
      'alex.morgan@gmail.com',
      phone,
      'linkedin.com/in/alexmorgan'
    ].join('\n'));
    assert.equal(contact.phone, phone);
    assert.equal(contact.email, 'alex.morgan@gmail.com');
    assert.equal(contact.website, 'linkedin.com/in/alexmorgan');
  });

  const dated = detectContact([
    'Alex Morgan',
    'alex.morgan@gmail.com',
    '2015 - 2019',
    '01/2018 - 06/2020',
    'Employee ID 123456789012',
    'Reference 9988776655443'
  ].join('\n'));
  assert.equal(dated.phone, '');
  assert.equal(dated.website, '');
  assert.equal(dated.email, 'alex.morgan@gmail.com');

  const site = detectContact([
    'Sam Lee',
    'sam.lee@gmail.com',
    '555-123-4567',
    'https://www.samlee.com'
  ].join('\n'));
  assert.equal(site.email, 'sam.lee@gmail.com');
  assert.equal(site.phone, '555-123-4567');
  assert.notEqual(site.website, 'gmail.com');
  assert.equal(site.website, 'https://www.samlee.com');
});

test('splitSkills gives one clean list for commas, pipes, semicolons, and bullets', () => {
  const expected = 'JavaScript, Python, SQL';
  assert.equal(splitSkills(['JavaScript, Python, SQL']), expected);
  assert.equal(splitSkills(['JavaScript | Python | SQL']), expected);
  assert.equal(splitSkills(['JavaScript; Python; SQL']), expected);
  assert.equal(splitSkills(['• JavaScript', '• Python', '• SQL']), expected);
  assert.equal(splitSkills(['· JavaScript · Python · SQL']), expected);
  assert.equal(splitSkills(['▪ JavaScript', '▪ Python', '▪ SQL']), expected);
  assert.equal(splitSkills(['- JavaScript', '- Python', '- SQL']), expected);
  assert.equal(splitSkills(['\u2013 JavaScript', '\u2013 Python', '\u2013 SQL']), expected);
  assert.equal(splitSkills(['JavaScript, Python, JavaScript, , SQL', 'Python']), expected);
  assert.equal(splitSkills(['Problem-solving, Cross-functional work']), 'Problem-solving, Cross-functional work');
});

test('parseEducation keeps degree text on a row that also has dates', () => {
  const combined = parseEducation([
    'BSc Computer Science    2015 - 2019',
    'State University'
  ]);
  assert.equal(combined.length, 1);
  assert.equal(combined[0].degree, 'BSc Computer Science');
  assert.equal(combined[0].school, 'State University');
  assert.equal(combined[0].dates, '2015 - 2019');

  const alone = parseEducation(['BSc Computer Science    2015 - 2019']);
  assert.equal(alone[0].degree, 'BSc Computer Science');
  assert.equal(alone[0].dates, '2015 - 2019');

  const separate = parseEducation([
    'BSc Computer Science',
    'State University',
    '2015 - 2019',
    'MSc Software Engineering',
    'City College',
    '2019 - 2021'
  ]);
  assert.deepEqual(plain(separate), [
    { degree: 'BSc Computer Science', school: 'State University', dates: '2015 - 2019' },
    { degree: 'MSc Software Engineering', school: 'City College', dates: '2019 - 2021' }
  ]);
});

test('inferredTitle no longer exists in app.js', () => {
  assert.equal(appSource.includes('inferredTitle'), false);
  assert.equal(appSource.toLowerCase().includes('logistics professional'), false);
});

test('date pattern reads month, numeric, and to ranges', () => {
  const ranges = ['Mar 2021 \u2013 Present', '05/2018 - 06/2020', '2015 to 2019'];
  ranges.forEach((range) => {
    assert.equal(dateLine(range), true);
    assert.equal(extractDate(range), range);
  });
});

function pdfTextItem(str, x, y, width, size = 10) {
  return { str, width, height: size, transform: [size, 0, 0, size, x, y] };
}

test('pdfItemsToLines joins a ligature, reads columns, keeps a right-aligned date, and drops a page footer', () => {
  assert.deepEqual(plain(pdfItemsToLines([
    pdfTextItem('fi', 0, 100, 8),
    pdfTextItem('nance', 8, 100, 36)
  ])), ['finance']);

  const left = ['Summary', 'Reporting', 'Forecasts', 'Warehouses', 'Mentoring', 'Shipments'];
  const right = ['Profile', 'Contact', 'Education', 'Skills', 'Projects', 'History'];
  const columns = [];
  left.forEach((text, index) => columns.push(pdfTextItem(text, 40, 700 - index * 20, 80)));
  right.forEach((text, index) => columns.push(pdfTextItem(text, 320, 700 - index * 20, 80)));
  assert.deepEqual(plain(pdfItemsToLines(columns)), [...left, ...right]);

  const roles = ['Senior Operations Analyst', 'Operations Analyst', 'Logistics Coordinator', 'Warehouse Associate', 'Shipping Clerk', 'Inventory Aide'];
  const dates = ['Mar 2021 \u2013 Present', '05/2018 - 06/2020', '2015 to 2019', 'Jun 2018 \u2013 Feb 2021', 'Aug 2016 \u2013 May 2018', 'Jan 2014 \u2013 Dec 2015'];
  const dated = [];
  const undated = [];
  roles.forEach((role, index) => {
    const y = 500 - index * 20;
    dated.push(pdfTextItem(role, 40, y, 140), pdfTextItem(dates[index], 260, y, 100));
    undated.push(pdfTextItem(role, 40, y, 140), pdfTextItem('Regional team', 260, y, 100));
  });
  assert.deepEqual(plain(pdfItemsToLines(dated)), roles.map((role, index) => `${role}\t${dates[index]}`));
  assert.deepEqual(plain(pdfItemsToLines(undated)), [...roles, ...Array(roles.length).fill('Regional team')]);

  assert.deepEqual(plain(pdfItemsToLines([
    pdfTextItem('Jordan Ellis', 40, 700, 80),
    pdfTextItem('Page 1 of 2', 40, 30, 70)
  ])), ['Jordan Ellis']);
});
