const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const appSource = fs.readFileSync(path.join(__dirname, '../../app.js'), 'utf8');
const helperStart = appSource.indexOf('function entryCardTitle(type, item) {');
const helperEnd = appSource.indexOf('\nfunction renderFields()', helperStart);
assert.ok(helperStart >= 0 && helperEnd > helperStart, 'Could not isolate entryCardTitle and moveEntry from app.js');

const sandbox = vm.createContext({});
vm.runInContext(`${appSource.slice(helperStart, helperEnd)}\nglobalThis.entryCardTitle = entryCardTitle;\nglobalThis.moveEntry = moveEntry;`, sandbox);

const { entryCardTitle, moveEntry } = sandbox;

test('entryCardTitle uses the filled role and company, or degree and school', () => {
  assert.equal(entryCardTitle('experience', { role: 'Designer', company: 'Northstar Labs' }), 'Designer, Northstar Labs');
  assert.equal(entryCardTitle('experience', { role: '  Designer  ', company: ' ' }), 'Designer');
  assert.equal(entryCardTitle('experience', { role: '', company: 'Northstar Labs' }), 'Northstar Labs');
  assert.equal(entryCardTitle('education', { degree: 'BFA', school: 'State University' }), 'BFA, State University');
  assert.equal(entryCardTitle('education', { degree: '', school: '  State University ' }), 'State University');
});

test('entryCardTitle names a blank entry', () => {
  assert.equal(entryCardTitle('experience', { role: '', company: '' }), 'New experience entry');
  assert.equal(entryCardTitle('experience', { role: ' \n ', company: '\t' }), 'New experience entry');
  assert.equal(entryCardTitle('experience', null), 'New experience entry');
  assert.equal(entryCardTitle('education', {}), 'New education entry');
  assert.equal(entryCardTitle('education', { degree: 12, school: null }), 'New education entry');
});

test('moveEntry reorders in place and reports whether the move was valid', () => {
  const down = ['a', 'b', 'c'];
  assert.equal(moveEntry(down, 0, 1), true);
  assert.deepEqual(down, ['b', 'a', 'c']);

  const up = [{ id: 1 }, { id: 2 }, { id: 3 }];
  const moved = up[2];
  assert.equal(moveEntry(up, 2, 0), true);
  assert.equal(up[0], moved);
  assert.deepEqual(up.map((item) => item.id), [3, 1, 2]);

  const unchanged = ['a', 'b', 'c'];
  assert.equal(moveEntry(unchanged, 1, 1), false);
  assert.equal(moveEntry(unchanged, -1, 0), false);
  assert.equal(moveEntry(unchanged, 0, 3), false);
  assert.equal(moveEntry(unchanged, 4, 1), false);
  assert.equal(moveEntry(unchanged, 1.5, 0), false);
  assert.equal(moveEntry([], 0, 0), false);
  assert.equal(moveEntry(null, 0, 1), false);
  assert.equal(moveEntry('ab', 0, 1), false);
  assert.deepEqual(unchanged, ['a', 'b', 'c']);
});
