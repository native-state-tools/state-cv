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

test('contact fields use mobile-appropriate types and autofill hints', async ({ page }) => {
  await openApp(page);
  await enterEditor(page);

  await expect(page.getByLabel('Full name')).toHaveAttribute('type', 'text');
  await expect(page.getByLabel('Full name')).toHaveAttribute('autocomplete', 'name');
  await expect(page.getByLabel('Full name')).toHaveAttribute('enterkeyhint', 'next');
  await expect(page.getByLabel('Location')).toHaveAttribute('autocomplete', 'address-level2');
  await expect(page.getByLabel('Email')).toHaveAttribute('type', 'email');
  await expect(page.getByLabel('Email')).toHaveAttribute('inputmode', 'email');
  await expect(page.getByLabel('Email')).toHaveAttribute('autocomplete', 'email');
  await expect(page.getByLabel('Email')).toHaveAttribute('autocapitalize', 'none');
  await expect(page.getByLabel('Email')).toHaveAttribute('spellcheck', 'false');
  await expect(page.getByLabel('Phone')).toHaveAttribute('type', 'tel');
  await expect(page.getByLabel('Phone')).toHaveAttribute('autocomplete', 'tel');
  await expect(page.getByLabel('LinkedIn or portfolio')).toHaveAttribute('type', 'url');
  await expect(page.getByLabel('LinkedIn or portfolio')).toHaveAttribute('inputmode', 'url');
  await expect(page.getByLabel('LinkedIn or portfolio')).toHaveAttribute('autocomplete', 'url');

  await page.getByRole('button', { name: 'Add experience' }).click();
  await page.getByRole('button', { name: 'Add education' }).click();
  await expect(page.getByRole('button', { name: 'Remove experience entry 2' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Remove education entry 2' })).toBeVisible();
  const repeatedTypes = await page.locator('#experienceList input, #educationList input').evaluateAll((fields) =>
    fields.map((field) => field.type)
  );
  expect(repeatedTypes.length).toBeGreaterThan(0);
  expect(repeatedTypes.every((type) => type === 'text')).toBe(true);
});

test('editor controls use at least 16px computed text', async ({ page }) => {
  await openApp(page);
  await enterEditor(page);
  const fontSizes = await page.locator('input:not([type="file"]):not([type="hidden"]), textarea, select').evaluateAll((fields) =>
    fields.map((field) => ({ id: field.id, fontSize: Number.parseFloat(getComputedStyle(field).fontSize) }))
  );
  expect(fontSizes.length).toBeGreaterThan(0);
  expect(fontSizes.filter(({ fontSize }) => fontSize < 16)).toEqual([]);
});

test('coarse-pointer repeat-entry controls have distinct 44px targets', async ({ page, isMobile }) => {
  await openApp(page);
  await enterEditor(page);
  await page.getByRole('button', { name: 'Add experience' }).click();
  await page.getByRole('button', { name: 'Add education' }).click();
  const repeatPaddingTop = await page.locator('.repeat-item').first().evaluate((element) => getComputedStyle(element).paddingTop);
  console.log(`Repeat-entry top padding at ${isMobile ? 'phone' : 'desktop'} viewport: ${repeatPaddingTop}`);
  const targets = [
    page.getByRole('button', { name: 'Remove experience entry 2' }),
    page.getByRole('button', { name: 'Remove education entry 2' })
  ];
  for (const target of targets) {
    await expect(target).toBeVisible();
    if (isMobile) {
      const box = await target.boundingBox();
      expect(box.width).toBeGreaterThanOrEqual(44);
      expect(box.height).toBeGreaterThanOrEqual(44);
    }
  }
});

test('200 percent root text setting keeps phone layout and controls in bounds', async ({ page, isMobile }) => {
  await openApp(page);
  await enterEditor(page);
  const dimensions = await page.evaluate(() => {
    document.documentElement.style.fontSize = '200%';
    const controls = [...document.querySelectorAll('a, button, input, textarea, select, summary')]
      .filter((element) => {
        const style = getComputedStyle(element);
        const box = element.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0 &&
          !element.closest('[inert], [aria-hidden="true"]') && box.width > 0 && box.height > 0;
      })
      .map((element) => {
        const box = element.getBoundingClientRect();
        return {
          name: element.getAttribute('aria-label') || element.textContent.trim(),
          left: box.left,
          right: box.right,
          clipped: element.scrollWidth > element.clientWidth + 1
        };
      });
    const nav = document.querySelector('.mobile-view-nav');
    const topbar = document.querySelector('.topbar');
    const obscuredFields = [];
    [...document.querySelectorAll('#resumeForm input, #resumeForm textarea')].forEach((field) => {
      field.scrollIntoView({ behavior: 'instant', block: 'nearest' });
      const box = field.getBoundingClientRect();
      const navBox = nav.getBoundingClientRect();
      const topbarBox = topbar.getBoundingClientRect();
      const overlaps = (first, second) =>
        Math.min(first.right, second.right) > Math.max(first.left, second.left) &&
        Math.min(first.bottom, second.bottom) > Math.max(first.top, second.top);
      if (getComputedStyle(nav).display !== 'none' && overlaps(box, navBox)) {
        obscuredFields.push(field.dataset.path || field.dataset.key);
      }
      if (getComputedStyle(topbar).display !== 'none' && overlaps(box, topbarBox)) {
        obscuredFields.push(field.dataset.path || field.dataset.key);
      }
    });
    const overlappingRemoveTargets = [...document.querySelectorAll('.repeat-item')].filter((item) =>
      item.querySelector('.remove-item').getBoundingClientRect().bottom >
      item.querySelector('.form-grid').getBoundingClientRect().top
    ).length;
    return {
      width: window.innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      rootFontSize: getComputedStyle(document.documentElement).fontSize,
      controlsOutsideViewport: controls.filter(({ left, right }) => left < -1 || right > window.innerWidth + 1),
      clippedControls: controls.filter(({ clipped }) => clipped).map(({ name }) => name),
      obscuredFields,
      overlappingRemoveTargets
    };
  });
  expect(dimensions.rootFontSize).toBe('32px');
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.width);
  expect(dimensions.controlsOutsideViewport).toEqual([]);
  expect(dimensions.clippedControls).toEqual([]);
  expect(dimensions.obscuredFields).toEqual([]);
  if (isMobile) expect(dimensions.overlappingRemoveTargets).toBe(0);
});

test('active view exposes one h1 and More opens and closes by keyboard', async ({ page }) => {
  await openApp(page);
  const activeViewHeading = page.locator('#launchScreen:not(.is-hidden) h1, #appShell:not([inert]) h1');
  await expect(activeViewHeading).toHaveCount(1);
  await enterEditor(page);
  await expect(activeViewHeading).toHaveCount(1);
  const more = page.locator('.more-menu summary');
  await expect(page.locator('#moreMenuContent')).toBeHidden();
  await more.focus();
  await page.keyboard.press('Space');
  await expect(page.locator('#moreMenuContent')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#moreMenuContent')).toBeHidden();
  await expect(more).toBeFocused();
});

test('Your data dialog traps focus, closes with Escape, and restores its opener', async ({ page }) => {
  await openApp(page);
  await enterEditor(page);
  const more = page.locator('.more-menu summary');
  await more.click();
  const opener = page.getByRole('button', { name: 'Your data' });
  await opener.click();
  const dialog = page.getByRole('dialog', { name: 'Your data' });
  await expect(dialog).toBeVisible();
  await expect(page.locator('#closeYourDataButton')).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(page.locator('#closeYourDataFooterButton')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(page.locator('.more-menu')).not.toHaveAttribute('open', '');
  await expect(more).toBeFocused();
});

test('keyboard Tab reaches the editor and navigation controls', async ({ page, isMobile }) => {
  await openApp(page);
  await enterEditor(page);
  await page.locator('#brandHome').focus();
  const targets = new Set(['importButton', 'addExperience', 'addEducation']);
  if (isMobile) {
    targets.add('mobileExportButton');
    targets.add('edit');
    targets.add('preview');
  } else {
    targets.add('printButton');
  }
  const reached = new Set();
  for (let index = 0; index < 80 && reached.size < targets.size; index += 1) {
    await page.keyboard.press('Tab');
    const active = await page.evaluate(() => {
      const element = document.activeElement;
      return element.dataset.mobileViewButton || element.id;
    });
    if (targets.has(active)) reached.add(active);
  }
  expect([...reached].sort()).toEqual([...targets].sort());
});

test('WCAG contrast for text, controls, focus, links, placeholders, and notices meets thresholds', async ({ page }) => {
  await openApp(page);
  await enterEditor(page);
  const measurements = await page.evaluate(() => {
    const channels = (color) => {
      const hex = color.match(/^#([\da-f]{3}|[\da-f]{6})$/i);
      if (hex) {
        const value = hex[1].length === 3 ? [...hex[1]].map((part) => part + part).join('') : hex[1];
        return [0, 2, 4].map((index) => Number.parseInt(value.slice(index, index + 2), 16)).concat(1);
      }
      const values = color.match(/[\d.]+/g) || [];
      return values.length >= 3 ? [Number(values[0]), Number(values[1]), Number(values[2]), values.length > 3 ? Number(values[3]) : 1] : [0, 0, 0, 1];
    };
    const composite = (foreground, background) => {
      const front = channels(foreground);
      const back = channels(background);
      const alpha = front[3] + back[3] * (1 - front[3]);
      return `rgb(${front.slice(0, 3).map((value, index) => Math.round((value * front[3] + back[index] * back[3] * (1 - front[3])) / alpha)).join(', ')})`;
    };
    const luminance = (color) => channels(color).slice(0, 3).map((value) => {
      const channel = value / 255;
      return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    }).reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0);
    const ratio = (foreground, background) => {
      const visibleForeground = composite(foreground, background);
      const values = [luminance(visibleForeground), luminance(background)].sort((a, b) => b - a);
      return Number(((values[0] + 0.05) / (values[1] + 0.05)).toFixed(2));
    };
    const root = getComputedStyle(document.documentElement);
    const canvas = root.getPropertyValue('--canvas').trim();
    const paper = root.getPropertyValue('--paper').trim();
    const topbar = getComputedStyle(document.querySelector('.topbar')).backgroundColor;
    const previewBackground = composite(getComputedStyle(document.querySelector('.preview-panel')).backgroundColor, canvas);
    const results = [];
    const add = (name, foreground, background, threshold = 4.5) =>
      results.push({ name, foreground, background, ratio: ratio(foreground, background), threshold });
    const color = (selector, pseudo = null) => getComputedStyle(document.querySelector(selector), pseudo).color;
    add('body text', getComputedStyle(document.body).color, canvas);
    add('muted launch text', color('.launch-intro'), canvas);
    add('field label', color('.field > span'), paper);
    add('muted field hint', color('.field-hint'), paper);
    add('filename extension', color('.filename-control b'), paper);
    add('preview format label', color('.format-label'), previewBackground);
    add('large launch heading', color('.launch-copy h1'), canvas, 3);
    add('large launch accent heading', color('.launch-copy h1 em'), canvas, 3);
    const darkButton = document.querySelector('.button-dark');
    const darkButtonStyle = getComputedStyle(darkButton);
    add('dark button text', darkButtonStyle.color, darkButtonStyle.backgroundColor);
    add('dark button border', darkButtonStyle.borderTopColor, darkButtonStyle.backgroundColor, 3);
    for (const selector of ['.paper-size-control', '.filename-control']) {
      const control = document.querySelector(selector);
      const style = getComputedStyle(control);
      add(`${selector.slice(1)} border`, style.borderTopColor, composite(style.backgroundColor, topbar), 3);
    }
    const launchCard = document.querySelector('.launch-card');
    add('launch action border', getComputedStyle(launchCard).borderTopColor, composite(getComputedStyle(launchCard).backgroundColor, canvas), 3);
    const quickAction = document.querySelector('.quick-action');
    const quickActionStyle = getComputedStyle(quickAction);
    const gradientColors = quickActionStyle.backgroundImage.match(/rgba?\([^)]+\)/g);
    if (!gradientColors?.length) throw new Error('PDF import action gradient colors could not be measured.');
    gradientColors.forEach((background, index) =>
      add(`PDF import action border (gradient stop ${index + 1})`, quickActionStyle.borderTopColor, background, 3));
    add('accent button text', color('.button-accent'), getComputedStyle(document.querySelector('.button-accent')).backgroundColor);
    add('caution button text', color('.button-caution'), getComputedStyle(document.querySelector('.button-caution')).backgroundColor);
    add('brand link', color('.brand'), topbar);
    add('field placeholder', color('.field input', '::placeholder'), composite(getComputedStyle(document.querySelector('.field input')).backgroundColor, paper));
    const field = document.querySelector('.field input');
    const fieldBackground = composite(getComputedStyle(field).backgroundColor, paper);
    add('field border', getComputedStyle(field).borderTopColor, fieldBackground, 3);
    const repeatItem = document.querySelector('.repeat-item');
    add('repeat-entry border', getComputedStyle(repeatItem).borderTopColor, composite(getComputedStyle(repeatItem).backgroundColor, paper), 3);
    const summaryCard = document.querySelector('.data-summary > div');
    add('data-summary border', getComputedStyle(summaryCard).borderTopColor, composite(getComputedStyle(summaryCard).backgroundColor, paper), 3);
    add('form section divider', getComputedStyle(document.querySelector('.form-section')).borderTopColor, paper, 3);
    add('snapshot separator', getComputedStyle(document.querySelector('.snapshot-item') || document.querySelector('.data-snapshots')).borderTopColor, paper, 3);
    field.focus({ focusVisible: true });
    add('focus ring', getComputedStyle(field).outlineColor, paper, 3);
    const notice = document.querySelector('#storageNotice');
    notice.hidden = false;
    notice.inert = false;
    notice.querySelector('p').textContent = 'Storage status notice';
    const noticeStyle = getComputedStyle(notice);
    const noticeBackground = composite(noticeStyle.backgroundColor, canvas);
    add('storage notice text', getComputedStyle(notice.querySelector('p')).color, noticeBackground);
    add('storage notice border', noticeStyle.borderBottomColor, noticeBackground, 3);
    const update = document.querySelector('#updateNotice');
    update.hidden = false;
    update.inert = false;
    const updateStyle = getComputedStyle(update);
    const updateBackground = composite(updateStyle.backgroundColor, canvas);
    add('update notice text', getComputedStyle(update.querySelector('p')).color, updateBackground);
    add('update notice border', updateStyle.borderBottomColor, updateBackground, 3);
    const nav = document.querySelector('.mobile-view-nav');
    if (getComputedStyle(nav).display !== 'none') {
      const navButton = nav.querySelector('button[aria-pressed="false"]');
      const navBackground = composite(getComputedStyle(nav).backgroundColor, canvas);
      add('inactive mobile navigation', getComputedStyle(navButton).color, navBackground);
    }
    return results;
  });
  console.log(`WCAG contrast measurements for ${page.context().browser()?.browserType().name() || 'browser'}: ${JSON.stringify(measurements)}`);
  expect(measurements.filter(({ ratio, threshold }) => ratio < threshold)).toEqual([]);
});

test('PDF export fires a download containing a PDF file', async ({ page }) => {
  await openApp(page);
  await enterEditor(page);
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export PDF' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/\.pdf$/i);
  const downloadPath = await download.path();
  expect(downloadPath).not.toBeNull();
  const bytes = await fs.readFile(downloadPath);
  expect(bytes.subarray(0, 4).toString('ascii')).toBe('%PDF');
  await expect(page.locator('#saveStatus')).toContainText(/PDF exported.*(Download started|Save to Files)/);
});

test('service worker controls the app and supports an offline reload', async ({ page }) => {
  await openApp(page);
  await page.evaluate(() => navigator.serviceWorker.ready);
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller)), { timeout: 15000 }).toBe(true);
  await page.context().setOffline(true);
  try {
    await page.reload();
    await expect(page.getByRole('button', { name: /Continue/ })).toBeVisible();
  } finally {
    await page.context().setOffline(false);
  }
  await expect.poll(() => page.evaluate(() => navigator.onLine)).toBe(true);
});
