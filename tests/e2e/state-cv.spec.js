const { test: base, expect } = require('@playwright/test');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const test = base.extend({
  browserDiagnostics: [async ({ context }, use, testInfo) => {
    const errors = [];
    const observedPages = new WeakSet();
    const monitorPage = (page) => {
      if (observedPages.has(page)) return;
      observedPages.add(page);
      page.on('console', (message) => {
        if (message.type() === 'error') errors.push(`${page.url()} console error: ${message.text()}`);
      });
      page.on('pageerror', (error) => errors.push(`${page.url()} uncaught page error: ${error.message}`));
    };
    context.on('page', monitorPage);
    context.pages().forEach(monitorPage);
    await context.addInitScript(() => {
      window.__stateCvCspViolations = [];
      document.addEventListener('securitypolicyviolation', (event) => {
        window.__stateCvCspViolations.push(`${event.violatedDirective}: ${event.blockedURI}`);
      });
    });

    await use();

    const cspViolations = [];
    for (const page of context.pages()) {
      if (page.isClosed()) continue;
      cspViolations.push(...await page.evaluate(() => window.__stateCvCspViolations || []));
    }
    expect(errors, `Browser errors in ${testInfo.title}`).toEqual([]);
    expect(cspViolations, `CSP violations in ${testInfo.title}`).toEqual([]);
  }, { auto: true }]
});

const validBackup = {
  schemaVersion: 1,
  basics: { name: 'Recovered CV', title: 'Researcher', location: '', email: '', phone: '', website: '' },
  exportName: '',
  summary: 'Recovered locally from a JSON backup.',
  experience: [{ role: '', company: '', dates: '', highlights: '' }],
  education: [{ degree: '', school: '', dates: '' }],
  skills: ''
};

async function openApp(page) {
  await page.goto('/');
  await expect(page.getByRole('button', { name: /Continue/ })).toBeVisible();
}

async function enterEditor(page) {
  await page.getByRole('button', { name: /Continue/ }).click();
  await expect(page.getByLabel('Full name')).toBeVisible();
}

async function openDataDialog(page) {
  await page.locator('.more-menu summary').click();
  await page.getByRole('button', { name: 'Your data' }).click();
  await expect(page.getByRole('dialog', { name: 'Your data' })).toBeVisible();
}

async function savedName(page) {
  return page.evaluate(() => {
    const raw = localStorage.getItem('state-cv-data-v1');
    return raw ? JSON.parse(raw).basics.name : null;
  });
}

test('start screen shows the expected local CV options', async ({ page }) => {
  await openApp(page);
  await expect(page.getByRole('button', { name: 'Start a new CV' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Import a PDF' })).toBeVisible();
  await expect(page.getByText('Your data stays in this browser')).toBeVisible();
});

test('viewport layout has no horizontal overflow and the bottom bar matches the breakpoint', async ({ page, isMobile }) => {
  await openApp(page);
  await enterEditor(page);
  const dimensions = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth
  }));
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.innerWidth);

  const bottomBar = page.locator('nav[aria-label="Editor navigation"]');
  if (isMobile) await expect(bottomBar).toBeVisible();
  else await expect(bottomBar).toBeHidden();
});

test('edited fields persist after reload', async ({ page }) => {
  await openApp(page);
  await enterEditor(page);
  await page.getByLabel('Full name').fill('Persistent Name');
  await expect.poll(() => savedName(page)).toBe('Persistent Name');
  await page.reload();
  await enterEditor(page);
  await expect(page.getByLabel('Full name')).toHaveValue('Persistent Name');
});

test('damaged data can be downloaded and recovered with a JSON backup', async ({ page }) => {
  const raw = '{"broken":';
  await page.addInitScript((damaged) => localStorage.setItem('state-cv-data-v1', damaged), raw);
  await openApp(page);
  await expect(page.locator('#storageNotice')).toContainText('Saved data could not be validated');
  await expect.poll(() => page.evaluate(() => localStorage.getItem('state-cv-damaged-v1'))).toBe(raw);
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download damaged data' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('state-cv-damaged-data.json');
  const downloadPath = await download.path();
  expect(downloadPath).not.toBeNull();
  expect(await fs.readFile(downloadPath, 'utf8')).toBe(raw);

  await page.locator('#importInput').setInputFiles({
    name: 'recovery.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(validBackup))
  });
  await expect(page.getByLabel('Full name')).toHaveValue('Recovered CV');
  await expect.poll(() => savedName(page)).toBe('Recovered CV');
});

test('two-tab conflict supports Reload latest and Keep mine', async ({ page }) => {
  await openApp(page);
  await enterEditor(page);
  const secondPage = await page.context().newPage();
  await openApp(secondPage);
  await enterEditor(secondPage);

  await page.getByLabel('Full name').fill('First tab');
  await expect.poll(() => savedName(page)).toBe('First tab');
  await secondPage.getByLabel('Full name').fill('Discarded tab edit');
  await expect(secondPage.locator('#storageNotice')).toContainText('saved in another tab');
  await secondPage.getByRole('button', { name: 'Reload latest' }).click();
  await expect(secondPage.getByLabel('Full name')).toHaveValue('First tab');

  await page.getByLabel('Full name').fill('Latest from first tab');
  await expect.poll(() => savedName(page)).toBe('Latest from first tab');
  await secondPage.getByLabel('Full name').fill('Kept from second tab');
  await expect(secondPage.locator('#storageNotice')).toContainText('saved in another tab');
  await secondPage.getByRole('button', { name: 'Keep mine' }).click();
  await expect.poll(() => savedName(secondPage)).toBe('Kept from second tab');
  await expect(secondPage.locator('#storageNotice')).toBeHidden();
});

test('starting a new CV and restoring a snapshot keeps the pre-restore CV undoable', async ({ page }) => {
  await openApp(page);
  await enterEditor(page);
  await page.getByLabel('Full name').fill('Snapshot CV');
  await expect.poll(() => savedName(page)).toBe('Snapshot CV');

  await page.locator('.more-menu summary').click();
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Start new CV', exact: true }).click();
  await expect(page.getByLabel('Full name')).toHaveValue('');

  await page.getByLabel('Full name').fill('New CV after starting fresh');
  await expect.poll(() => savedName(page)).toBe('New CV after starting fresh');
  await openDataDialog(page);
  const snapshotEntries = page.locator('#snapshotsList article');
  await expect(snapshotEntries).toHaveCount(1);
  await snapshotEntries.last().getByRole('button', { name: 'Restore' }).click();
  await expect(page.getByLabel('Full name')).toHaveValue('Snapshot CV');
  await expect(page.locator('#dataDialogStatus')).toContainText('Snapshot restored and saved');

  await expect(snapshotEntries).toHaveCount(2);
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('state-cv-snapshots-v1')).map((snapshot) => snapshot.data.basics.name)))
    .toEqual(['Snapshot CV', 'New CV after starting fresh']);
  await snapshotEntries.last().getByRole('button', { name: 'Restore' }).click();
  await expect(page.getByLabel('Full name')).toHaveValue('New CV after starting fresh');
  await expect(page.locator('#dataDialogStatus')).toContainText('Snapshot restored and saved');
});

test('Clear all data requires a second click and then empties local storage', async ({ page }) => {
  await openApp(page);
  await enterEditor(page);
  await page.getByLabel('Full name').fill('Clear this CV');
  await expect.poll(() => savedName(page)).toBe('Clear this CV');
  await expect.poll(() => page.evaluate(() => localStorage.getItem('state-cv-persistence-v1'))).not.toBeNull();
  await openDataDialog(page);

  await page.getByRole('button', { name: 'Clear all data' }).click();
  await expect(page.getByRole('button', { name: /Click again to clear/ })).toBeVisible();
  await expect.poll(() => savedName(page)).toBe('Clear this CV');
  await page.getByRole('button', { name: /Click again to clear/ }).click();
  await expect(page.locator('#dataDialogStatus')).toContainText('All State CV data was cleared');
  await expect.poll(() => page.evaluate(() => Object.keys(localStorage).filter((key) => key.startsWith('state-cv-')))).toEqual([]);
});

test('file:// load starts and supports editing without service-worker registration', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-1440', 'Direct-file support is checked on the desktop project only.');
  const indexPath = path.resolve(__dirname, '../../index.html');
  await page.goto(pathToFileURL(indexPath).href);
  await expect(page.getByRole('button', { name: /Continue/ })).toBeVisible();
  expect(page.context().serviceWorkers()).toHaveLength(0);
  await enterEditor(page);
  await page.getByLabel('Full name').fill('File URL CV');
  await expect.poll(() => savedName(page)).toBe('File URL CV');
});
