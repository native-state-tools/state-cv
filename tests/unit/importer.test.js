const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const importSource = fs.readFileSync(path.join(__dirname, '../../cv-import.js'), 'utf8');

function sliceBetween(startMarker, endMarker) {
  const start = importSource.indexOf(startMarker);
  const end = importSource.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0 && end > start, `Could not isolate ${startMarker} from cv-import.js`);
  return importSource.slice(start, end);
}

const sandbox = vm.createContext({});
vm.runInContext([
  sliceBetween('function pdfItemBoxes(items) {', '\nasync function extractPdfText('),
  sliceBetween('function dateLine(line) {', '\nfunction parseEducation(lines) {'),
  sliceBetween('function parseEducation(lines) {', '\nfunction splitSkills('),
  sliceBetween('function splitSkills(lines) {', '\nfunction detectContact('),
  sliceBetween('function detectContact(text) {', '\nfunction importPdfLines('),
  'globalThis.pdfItemsToLines = pdfItemsToLines;',
  'globalThis.dateLine = dateLine;',
  'globalThis.extractDate = extractDate;',
  'globalThis.parseExperience = parseExperience;',
  'globalThis.parseEducation = parseEducation;',
  'globalThis.reviewImportedEntries = reviewImportedEntries;',
  'globalThis.isDateShaped = isDateShaped;',
  'globalThis.splitSkills = splitSkills;',
  'globalThis.detectContact = detectContact;'
].join('\n'), sandbox);

const { pdfItemsToLines, dateLine, extractDate, parseExperience, parseEducation, reviewImportedEntries, isDateShaped, splitSkills, detectContact } = sandbox;
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

test('inferredTitle no longer exists in app.js, cv-import.js, or cv-export.js', () => {
  for (const file of ['app.js', 'cv-import.js', 'cv-export.js']) {
    const source = fs.readFileSync(path.join(__dirname, '../../', file), 'utf8');
    assert.equal(source.includes('inferredTitle'), false, file);
    assert.equal(source.toLowerCase().includes('logistics professional'), false, file);
  }
});

test('date pattern reads month, numeric, and to ranges', () => {
  const ranges = ['Mar 2021 \u2013 Present', '05/2018 - 06/2020', '2015 to 2019'];
  ranges.forEach((range) => {
    assert.equal(dateLine(range), true);
    assert.equal(extractDate(range), range);
  });
  assert.equal(dateLine('2021'), false);
  assert.equal(extractDate('2021'), '');
  assert.equal(dateLine('Class of 2021'), false);
});

function fixtureBlocks(name) {
  const text = fs.readFileSync(path.join(__dirname, '../fixtures', name), 'utf8').replace(/\r\n/g, '\n');
  const blocks = {};
  let current = '';
  text.split('\n').forEach((line) => {
    if (line.startsWith('--- ')) {
      current = line.slice(4).trim();
      blocks[current] = [];
      return;
    }
    if (current && line.trim()) blocks[current].push(line);
  });
  return blocks;
}

test('semicolon date ranges stay in dates and keep the company', () => {
  const lines = fixtureBlocks('import-field-shapes.txt')['semicolon-ranges'];
  assert.ok(lines[0].includes('\t'), 'expected a tab between the role and the ranges');
  const jobs = parseExperience(lines);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].role, 'Customer Advocate');
  assert.equal(jobs[0].company, 'Sample Autos');
  assert.equal(jobs[0].dates, '01/2022 - 09/2022; 07/2023 - 08/2025');
  assert.equal(jobs[0].highlights, 'Kept the handover list current.');
  assert.equal(isDateShaped(jobs[0].company), false);
  assert.equal(isDateShaped('01/2022 - 09/2022; 07/2023 - 08/2025'), true);
});

test('a long role | company header keeps both fields', () => {
  const jobs = parseExperience(fixtureBlocks('import-field-shapes.txt')['long-header']);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].role, 'Customer Advocate II & Training Mentor');
  assert.equal(jobs[0].company, 'Sample Autos, Jackson, MO');
  assert.equal(jobs[0].dates, '07/2023 \u2013 08/2025');
  assert.equal(jobs[0].highlights, 'Mentored new associates on service protocols.');
  assert.equal(jobs[0].highlights.includes('Sample Autos'), false);
});

test('a role and Remote line keeps the company on the following line', () => {
  const jobs = parseExperience([
    'Customer Advocate | Remote',
    '01/2022 \u2013 09/2022',
    'Carvana',
    '\u2022 Helped customers'
  ]);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].role, 'Customer Advocate, Remote');
  assert.equal(jobs[0].company, 'Carvana');
  assert.equal(jobs[0].dates, '01/2022 \u2013 09/2022');
  assert.equal(jobs[0].highlights, 'Helped customers');
  assert.equal(jobs[0].highlights.includes('Carvana'), false);
});

test('a role and Hybrid line keeps the company on the following line', () => {
  const jobs = parseExperience([
    'Customer Advocate | Hybrid',
    '01/2022 \u2013 09/2022',
    'Carvana',
    '\u2022 Helped customers'
  ]);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].role, 'Customer Advocate, Hybrid');
  assert.equal(jobs[0].company, 'Carvana');
  assert.equal(jobs[0].dates, '01/2022 \u2013 09/2022');
  assert.equal(jobs[0].highlights, 'Helped customers');
  assert.equal(jobs[0].highlights.includes('Carvana'), false);
});

test('a role and Remote (US) line keeps the company on the following line', () => {
  const jobs = parseExperience([
    'Customer Advocate | Remote (US)',
    '01/2022 \u2013 09/2022',
    'Carvana',
    '\u2022 Helped customers'
  ]);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].role, 'Customer Advocate, Remote (US)');
  assert.equal(jobs[0].company, 'Carvana');
  assert.equal(jobs[0].dates, '01/2022 \u2013 09/2022');
  assert.equal(jobs[0].highlights, 'Helped customers');
  assert.equal(jobs[0].highlights.includes('Carvana'), false);
});

test('a company and location line keeps the job title on the following line', () => {
  const jobs = parseExperience([
    'Acme Corp \u2014 Austin, TX',
    '01/2022 \u2013 09/2022',
    'Senior Analyst'
  ]);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].role, 'Acme Corp, Austin, TX');
  assert.equal(jobs[0].company, 'Senior Analyst');
  assert.equal(jobs[0].dates, '01/2022 \u2013 09/2022');
  assert.equal(String(jobs[0].highlights).includes('Senior Analyst'), false);
});

test('separate role and company lines with one date range still import', () => {
  const jobs = parseExperience([
    'Senior Operations Analyst\tMar 2021 \u2013 Present',
    'Harbor Logistics Group, Austin, TX',
    'Cut average order-to-ship time by 22% by redesigning the dispatch workflow across 4 warehouses.'
  ]);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].role, 'Senior Operations Analyst');
  assert.equal(jobs[0].company, 'Harbor Logistics Group, Austin, TX');
  assert.equal(jobs[0].dates, 'Mar 2021 \u2013 Present');
  assert.match(jobs[0].highlights, /dispatch workflow/);
});

test('standalone education year stays out of the school field', () => {
  const lines = fs.readFileSync(path.join(__dirname, '../fixtures/alex-example-education.txt'), 'utf8')
    .replace(/\r\n/g, '\n').split('\n').map((line) => line.trim()).filter(Boolean);
  assert.deepEqual(lines, [
    'Associate Degree in Business Administration',
    'Example Community College',
    '2021'
  ]);
  const parsed = parseEducation(lines);
  assert.deepEqual(plain(parsed), [{
    degree: 'Associate Degree in Business Administration',
    school: 'Example Community College',
    dates: '2021'
  }]);

  const combined = parseEducation(['Associate Degree in Business Administration\t2021', 'Example Community College']);
  assert.equal(combined[0].degree, 'Associate Degree in Business Administration');
  assert.equal(combined[0].school, 'Example Community College');
  assert.equal(combined[0].dates, '2021');

  const several = parseEducation([
    'Associate Degree in Business Administration',
    'Example Community College',
    '2021',
    'B.A. History',
    'State College',
    'May 2018 - Jun 2020'
  ]);
  assert.deepEqual(plain(several), [
    { degree: 'Associate Degree in Business Administration', school: 'Example Community College', dates: '2021' },
    { degree: 'B.A. History', school: 'State College', dates: 'May 2018 - Jun 2020' }
  ]);

  const yearLike = parseEducation(['Class of 2021 Leadership Seminar', 'Example Community College']);
  assert.equal(yearLike[0].degree, 'Class of 2021 Leadership Seminar');
  assert.equal(yearLike[0].school, 'Example Community College');
  assert.equal(yearLike[0].dates, '');
});

test('import review flags empty or date-like company, dates, and education fields', () => {
  const flags = reviewImportedEntries({
    experience: [
      { role: 'Advocate', company: '', dates: '', highlights: 'Kept notes.' },
      { role: 'Driver', company: '07/2023 - 08/2025', dates: '01/2022 - 09/2022', highlights: '' },
      { role: '', company: '', dates: '', highlights: '' }
    ],
    education: [
      { degree: 'Certificate', school: '', dates: '' },
      { degree: '2021', school: '2021', dates: '' }
    ]
  });
  const got = flags.map((flag) => `${flag.section}:${flag.field}:${flag.issue}`);
  const expected = [
    'experience:company:empty',
    'experience:dates:empty',
    'experience:company:date',
    'education:school:empty',
    'education:dates:empty',
    'education:degree:date',
    'education:school:date',
    'education:dates:empty'
  ];
  assert.equal(got.join('\n'), expected.join('\n'), JSON.stringify(flags, null, 2));
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
