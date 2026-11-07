const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { resolveManualScreenshotDir } = require('../screenshot-dir');

test('an unset screenshot directory stays on the test output path', () => {
  assert.equal(resolveManualScreenshotDir(undefined, path.posix), null);
  assert.equal(resolveManualScreenshotDir('', path.win32), null);
});

test('a relative path is rejected on both platforms', () => {
  assert.throws(() => resolveManualScreenshotDir('test-shots', path.posix), /absolute path/);
  assert.throws(() => resolveManualScreenshotDir('test-shots', path.win32), /absolute path/);
  assert.throws(() => resolveManualScreenshotDir('C:shots', path.win32), /absolute path/);
});

test('a Windows path is absolute only under Windows path rules', () => {
  const windowsPath = 'C:\\Users\\brian\\test-shots';
  assert.throws(() => resolveManualScreenshotDir(windowsPath, path.posix), /absolute path/);
  assert.equal(resolveManualScreenshotDir(windowsPath, path.win32), windowsPath);
});

test('a POSIX absolute path is accepted under POSIX path rules', () => {
  assert.equal(resolveManualScreenshotDir('/tmp/state-cv-shots', path.posix), '/tmp/state-cv-shots');
});
