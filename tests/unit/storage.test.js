const test = require('node:test');
const assert = require('node:assert/strict');
const createStorage = require('../../storage.js');

class MemoryStorage {
  constructor() {
    this.values = new Map();
    this.failSet = null;
    this.failRemove = null;
  }

  getItem(key) {
    return this.values.has(key) ? this.values.get(key) : null;
  }

  setItem(key, value) {
    if (this.failSet && this.failSet(key, value)) throw new Error('QuotaExceededError');
    this.values.set(key, String(value));
  }

  removeItem(key) {
    if (this.failRemove && this.failRemove(key)) throw new Error('StorageError');
    this.values.delete(key);
  }
}

test('writeData and load preserve data and increment revisions', () => {
  const fake = new MemoryStorage();
  const storage = createStorage(fake);
  const payload = { schemaVersion: 1, basics: { name: 'Ada' } };

  assert.equal(storage.writeData('state-cv-data-v1', payload, 0), 1);
  assert.deepEqual(JSON.parse(storage.getItem('state-cv-data-v1')), { ...payload, revision: 1 });
  assert.equal(storage.getDataRevision('state-cv-data-v1'), 1);
  assert.equal(storage.writeData('state-cv-data-v1', { ...payload, basics: { name: 'Grace' } }, 1), 2);
  assert.equal(JSON.parse(storage.getItem('state-cv-data-v1')).basics.name, 'Grace');
});

test('writeData detects a revision changed by another tab without overwriting it', () => {
  const fake = new MemoryStorage();
  const tabA = createStorage(fake);
  const tabB = createStorage(fake);
  tabA.writeData('state-cv-data-v1', { basics: { name: 'Tab A' } }, 0);

  assert.throws(
    () => tabB.writeData('state-cv-data-v1', { basics: { name: 'Tab B' } }, 0),
    (error) => error.code === 'conflict' && error.actualRevision === 1
  );
  assert.equal(JSON.parse(fake.getItem('state-cv-data-v1')).basics.name, 'Tab A');
});

test('snapshot list retains at most five entries and drops the oldest', () => {
  const fake = new MemoryStorage();
  const storage = createStorage(fake);
  for (let index = 1; index <= 6; index += 1) {
    storage.addSnapshot({ savedAt: `2026-01-0${index}T00:00:00.000Z`, revision: index, data: { value: index } });
  }

  assert.deepEqual(storage.readSnapshots().map((snapshot) => snapshot.revision), [2, 3, 4, 5, 6]);
});

test('snapshot writer retries quota failures by dropping oldest snapshots', () => {
  const fake = new MemoryStorage();
  const storage = createStorage(fake);
  fake.setItem('state-cv-snapshots-v1', JSON.stringify([
    { revision: 1 }, { revision: 2 }
  ]));
  let failDataWrite = true;
  fake.failSet = (key) => {
    if (key === 'state-cv-data-v1' && failDataWrite) {
      failDataWrite = false;
      return true;
    }
    return false;
  };

  assert.equal(storage.writeData('state-cv-data-v1', { basics: { name: 'Saved' } }, 0), 1);
  assert.deepEqual(storage.readSnapshots(), [{ revision: 2 }]);
  assert.equal(JSON.parse(storage.getItem('state-cv-data-v1')).basics.name, 'Saved');
});

test('damaged JSON is preserved separately and the original value remains unchanged', () => {
  const fake = new MemoryStorage();
  const storage = createStorage(fake);
  const raw = '{"broken":';
  fake.setItem('state-cv-data-v1', raw);

  assert.throws(() => storage.getDataRevision('state-cv-data-v1'), (error) => error.code === 'damaged');
  storage.preserveDamagedData(raw);
  assert.equal(fake.getItem('state-cv-data-v1'), raw);
  assert.equal(fake.getItem('state-cv-damaged-v1'), raw);
});

test('storage errors are surfaced when writes cannot be recovered', () => {
  const fake = new MemoryStorage();
  const storage = createStorage(fake);
  fake.failSet = () => true;

  assert.throws(() => storage.writeData('state-cv-data-v1', { basics: {} }, 0), /QuotaExceededError/);
});

test('clearAll removes all State CV keys and rolls back if a removal fails', () => {
  const fake = new MemoryStorage();
  const storage = createStorage(fake);
  const keys = [
    'state-cv-data-v1',
    'state-cv-snapshots-v1',
    'state-cv-damaged-v1',
    'state-cv-persistence-v1'
  ];
  keys.forEach((key) => fake.setItem(key, `saved:${key}`));

  storage.clearAll();
  keys.forEach((key) => assert.equal(fake.getItem(key), null));

  keys.forEach((key) => fake.setItem(key, `restored:${key}`));
  fake.failRemove = (key) => key === 'state-cv-persistence-v1';
  assert.throws(() => storage.clearAll(), /Clear all data failed; the saved items were restored/);
  keys.forEach((key) => assert.equal(fake.getItem(key), `restored:${key}`));
});
