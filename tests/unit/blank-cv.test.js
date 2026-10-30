const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const appSource = fs.readFileSync(path.join(__dirname, '../../app.js'), 'utf8');
const helperStart = appSource.indexOf('function isBlankCv(data) {');
const helperEnd = appSource.indexOf('\nfunction showUndoToast(', helperStart);
assert.ok(helperStart >= 0 && helperEnd > helperStart, 'Could not isolate isBlankCv from app.js');

const sandbox = vm.createContext({});
vm.runInContext(`${appSource.slice(helperStart, helperEnd)}\nglobalThis.isBlankCv = isBlankCv;`, sandbox);

const emptyCv = {
  basics: { name: '', title: '', location: '', email: '', phone: '', website: '' },
  exportName: '',
  summary: '',
  experience: [{ role: '', company: '', dates: '', highlights: '' }],
  education: [{ degree: '', school: '', dates: '' }],
  skills: ''
};

test('isBlankCv is true for an empty saved CV and false when any field has text', () => {
  assert.equal(sandbox.isBlankCv(emptyCv), true);
  assert.equal(sandbox.isBlankCv({ ...emptyCv, schemaVersion: 1, savedAt: '2026-10-29T00:00:00.000Z' }), true);
  assert.equal(sandbox.isBlankCv({
    ...emptyCv,
    basics: { ...emptyCv.basics, title: '   ' },
    summary: '\n'
  }), true);
  assert.equal(sandbox.isBlankCv({
    ...emptyCv,
    basics: { ...emptyCv.basics, title: 'Operations Analyst' }
  }), false);
  assert.equal(sandbox.isBlankCv({
    ...emptyCv,
    experience: [{ role: 'Analyst', company: '', dates: '', highlights: '' }]
  }), false);
  assert.equal(sandbox.isBlankCv(null), false);
  assert.equal(sandbox.isBlankCv({ ...emptyCv, experience: 'not a list' }), false);
});
