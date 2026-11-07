const path = require('node:path');

function resolveManualScreenshotDir(configured, pathApi = path) {
  if (configured == null || configured === '') return null;
  if (!pathApi.isAbsolute(configured)) {
    throw new Error('STATE_CV_SCREENSHOT_DIR must be an absolute path on this platform.');
  }
  return configured;
}

module.exports = { resolveManualScreenshotDir };
