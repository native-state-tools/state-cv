const { test: base, expect } = require('@playwright/test');
const fs = require('node:fs/promises');
const path = require('node:path');

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

const { resolveManualScreenshotDir } = require('../screenshot-dir');

const longName = 'North Region Campus Hiring Panel Leadership Track 2026 Final Round';

const storedCv = {
  schemaVersion: 2,
  savedAt: '2026-11-07T12:00:00.000Z',
  master: {
    basics: {
      name: 'Alex Morgan',
      title: 'Product Designer',
      location: 'Austin, TX',
      email: 'alex@example.com',
      phone: '555-0100',
      website: ''
    },
    exportName: '',
    summary: 'Builds clear tools for hiring teams.',
    experience: [{ id: 'exp_1', role: 'Designer', company: 'Northstar', dates: '2020 - 2024', highlights: 'Shipped onboarding.' }],
    education: [{ id: 'edu_1', degree: 'BFA', school: 'State University', dates: '2014 - 2018' }],
    skills: 'Research, Writing'
  },
  versions: [{
    id: 'ver_longname',
    name: longName,
    hiddenEntries: [],
    hiddenBullets: {},
    hiddenSkills: [],
    title: '',
    summary: '',
    exportName: ''
  }]
};

function overlaps(first, second) {
  if (!first || !second || first.width <= 0 || second.width <= 0) return false;
  const x = Math.min(first.right, second.right) - Math.max(first.left, second.left);
  const y = Math.min(first.bottom, second.bottom) - Math.max(first.top, second.top);
  return x > 1 && y > 1;
}

function sweepFor(projectName) {
  if (projectName === 'phone-360') return [{ width: 360, height: 640, label: '360' }];
  if (projectName === 'phone-390') {
    return [
      { width: 320, height: 640, label: '320' },
      { width: 390, height: 844, label: '390' },
      { width: 430, height: 844, label: '430' },
      { width: 844, height: 390, label: '844x390' }
    ];
  }
  if (projectName === 'desktop-1440') {
    return [
      { width: 768, height: 1024, label: '768' },
      { width: 1023, height: 768, label: '1023' },
      { width: 1024, height: 768, label: '1024' },
      { width: 1280, height: 800, label: '1280' },
      { width: 1440, height: 900, label: '1440' }
    ];
  }
  return null;
}

async function openEditor(page) {
  await page.addInitScript((payload) => {
    localStorage.setItem('state-cv-data-v1', JSON.stringify(payload));
  }, storedCv);
  await page.goto('/app/');
  await page.getByRole('button', { name: /Continue/ }).click();
  const launchScreen = page.locator('#launchScreen');
  await expect(launchScreen).toHaveClass(/is-hidden/);
  await expect.poll(() => launchScreen.evaluate((screen) => {
    const style = getComputedStyle(screen);
    return Number(style.opacity) < 0.01 && style.pointerEvents === 'none'
      && !document.querySelector('#appShell').hasAttribute('inert');
  })).toBe(true);
  await expect(page.getByLabel('Full name')).toBeVisible();
}

async function settle(page, size) {
  if (size) await page.setViewportSize({ width: size.width, height: size.height });
  await page.evaluate(() => new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  }));
  await page.evaluate(() => {
    if (typeof updateStickyOffsets === 'function') updateStickyOffsets();
  });
}

async function headerLayout(page) {
  return page.evaluate(() => {
    const read = (selector) => {
      const element = document.querySelector(selector);
      const box = element.getBoundingClientRect();
      return {
        left: box.left,
        right: box.right,
        top: box.top,
        bottom: box.bottom,
        width: box.width,
        height: box.height
      };
    };
    const label = document.querySelector('#versionPillLabel');
    const pill = document.querySelector('#versionPill');
    const status = document.querySelector('#saveStatus');
    return {
      pill: read('#versionPill'),
      status: read('#saveStatus'),
      menu: read('.more-menu > summary'),
      brand: read('.brand'),
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      labelText: label.textContent,
      labelOverflow: label.scrollWidth > label.clientWidth + 1,
      labelEllipsis: getComputedStyle(label).textOverflow,
      pillName: pill.getAttribute('aria-label'),
      statusText: status.textContent.replace(/\s+/g, ' ').trim(),
      statusLive: status.getAttribute('aria-live'),
      statusHidden: status.getAttribute('aria-hidden'),
      statusClipped: status.scrollWidth > status.clientWidth + 2 || status.scrollHeight > status.clientHeight + 2
    };
  });
}

function expectHeaderClear(layout, { phone, longVersion }) {
  expect(layout.scrollWidth).toBeLessThanOrEqual(layout.innerWidth);
  expect(overlaps(layout.pill, layout.status), 'version pill overlaps save status').toBe(false);
  expect(overlaps(layout.pill, layout.menu), 'version pill overlaps Menu').toBe(false);
  expect(overlaps(layout.brand, layout.pill), 'brand overlaps version pill').toBe(false);
  expect(overlaps(layout.status, layout.menu), 'save status overlaps Menu').toBe(false);
  expect(layout.menu.left).toBeGreaterThanOrEqual(-1);
  expect(layout.menu.right).toBeLessThanOrEqual(layout.innerWidth + 1);
  expect(layout.menu.width).toBeGreaterThan(40);
  expect(layout.pill.right).toBeLessThanOrEqual(layout.innerWidth + 1);
  expect(layout.pill.left).toBeGreaterThanOrEqual(-1);
  if (phone) expect(layout.status.top).toBeGreaterThanOrEqual(layout.pill.bottom - 1);
  if (longVersion) {
    expect(layout.labelText).toBe(longName);
    expect(layout.pillName).toBe(longName);
    if (layout.innerWidth <= 430 || layout.innerWidth >= 1024) {
      expect(layout.labelOverflow, `version name was not shortened at ${layout.innerWidth}px`).toBe(true);
      expect(layout.labelEllipsis).toBe('ellipsis');
    } else if (layout.labelOverflow) {
      expect(layout.labelEllipsis).toBe('ellipsis');
    }
  }
}

async function expectHit(page, selector) {
  const hit = await page.locator(selector).evaluate((element) => {
    const box = element.getBoundingClientRect();
    const x = Math.min(window.innerWidth - 1, Math.max(0, box.left + box.width / 2));
    const y = Math.min(window.innerHeight - 1, Math.max(0, box.top + box.height / 2));
    const target = document.elementFromPoint(x, y);
    return Boolean(target && (target === element || element.contains(target)));
  });
  expect(hit, `${selector} is covered`).toBe(true);
}

async function expectTabsReadable(page, width) {
  const phone = width < 1024;
  const tabs = await page.locator('.section-nav-name').evaluateAll((nodes) => nodes.map((element) => {
    const style = getComputedStyle(element);
    const box = element.getBoundingClientRect();
    const lineHeight = Number.parseFloat(style.lineHeight) || box.height || 1;
    return {
      text: element.textContent.trim(),
      whiteSpace: style.whiteSpace,
      fontSize: Number.parseFloat(style.fontSize),
      lines: box.height / lineHeight,
      clipped: element.scrollWidth > element.clientWidth + 1
    };
  }));
  expect(tabs.map((tab) => tab.text)).toEqual(['Contact', 'Summary', 'Experience', 'Education', 'Skills']);
  for (const tab of tabs) {
    expect(tab.clipped, `${tab.text} is clipped`).toBe(false);
    expect(tab.lines, `${tab.text} wraps`).toBeLessThan(1.45);
    if (phone) {
      expect(tab.whiteSpace).toBe('nowrap');
      expect(tab.fontSize).toBeGreaterThanOrEqual(12);
    }
  }
  await page.evaluate(() => {
    const list = document.querySelector('.section-nav-list');
    if (list) list.scrollLeft = list.scrollWidth;
  });
  await page.evaluate(() => showEditorSection('skills'));
  const skillsVisible = await page.locator('[data-section-target="skills"]').evaluate((element) => {
    const list = element.closest('.section-nav-list');
    const listBox = list.getBoundingClientRect();
    const box = element.getBoundingClientRect();
    const x = Math.min(listBox.right - 2, Math.max(listBox.left + 2, box.left + box.width / 2));
    const y = Math.min(listBox.bottom - 2, Math.max(listBox.top + 2, box.top + box.height / 2));
    const hit = document.elementFromPoint(x, y);
    return box.left >= listBox.left - 1 && box.right <= listBox.right + 1
      && Boolean(hit && (hit === element || element.contains(hit)));
  });
  expect(skillsVisible).toBe(true);
  await page.locator('[data-section-target="contact"]').click();
  await expect(page.getByRole('heading', { level: 2, name: 'Contact details', exact: true })).toBeVisible();
}

async function expectKeyboardTabs(page) {
  await page.locator('[data-section-target="contact"]').focus();
  for (const id of ['summary', 'experience', 'education', 'skills']) {
    await page.keyboard.press('Tab');
    const tab = page.locator(`[data-section-target="${id}"]`);
    await expect(tab).toBeFocused();
    const focus = await tab.evaluate((element) => {
      const list = element.closest('.section-nav-list');
      const listBox = list.getBoundingClientRect();
      const box = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return {
        inStrip: box.left >= listBox.left - 1 && box.right <= listBox.right + 1,
        outlineStyle: style.outlineStyle,
        outlineWidth: Number.parseFloat(style.outlineWidth) || 0
      };
    });
    expect(focus.inStrip, `${id} is outside the tab strip`).toBe(true);
    expect(focus.outlineStyle).not.toBe('none');
    expect(focus.outlineWidth).toBeGreaterThanOrEqual(2);
  }
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-section-target="skills"]')).toHaveAttribute('aria-current', 'step');
}

async function chooseLongVersion(page) {
  const sheet = page.locator('#versionSheet');
  if (!(await sheet.isVisible())) await page.locator('#versionPill').click();
  await expect(sheet).toBeVisible();
  const choice = page.locator('#versionRadioList .version-choice span', { hasText: longName });
  await expect(choice).toHaveText(longName);
  const choiceClipped = await choice.evaluate((element) => element.scrollWidth > element.clientWidth + 1);
  expect(choiceClipped).toBe(false);
  await page.getByRole('radio', { name: longName, exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(sheet).toBeHidden();
  await expect(page.locator('#versionPill')).toHaveAttribute('aria-label', longName);
  await expect(page.locator('#versionBanner')).toContainText(longName);
}

async function shot(page, testInfo, name) {
  const manualDir = resolveManualScreenshotDir(process.env.STATE_CV_SCREENSHOT_DIR);
  const destination = manualDir ? path.join(manualDir, name) : testInfo.outputPath(name);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await page.screenshot({ path: destination });
}

async function expectClearOfNavigation(page, selector) {
  const result = await page.locator(selector).evaluate((element) => {
    element.scrollIntoView({ block: 'end', inline: 'nearest', behavior: 'instant' });
    const nav = document.querySelector('.mobile-view-nav');
    const navBox = nav.getBoundingClientRect();
    const navShown = getComputedStyle(nav).display !== 'none';
    const topbar = document.querySelector('.topbar').getBoundingClientRect();
    const box = element.getBoundingClientRect();
    const limitBottom = navShown ? navBox.top : window.innerHeight;
    const x = Math.min(window.innerWidth - 2, Math.max(2, box.left + Math.min(box.width / 2, 36)));
    const y = Math.min(limitBottom - 2, Math.max(topbar.bottom + 2, Math.min(box.bottom - 8, box.top + 12)));
    const hit = document.elementFromPoint(x, y);
    return {
      covered: navShown && box.bottom > navBox.top + 1,
      clickable: Boolean(hit && (hit === element || element.contains(hit))),
      bottom: box.bottom,
      navTop: navBox.top
    };
  });
  expect(result.covered, `${selector} stays under the bottom navigation`).toBe(false);
  expect(result.clickable, `${selector} cannot be activated`).toBe(true);
}

test('header, section tabs, and page width stay usable', async ({ page }, testInfo) => {
  const sweep = sweepFor(testInfo.project.name);
  test.skip(!sweep, 'This layout sweep runs on the phone and desktop projects.');
  test.setTimeout(120000);
  await openEditor(page);
  const initial = sweep[0];
  await settle(page, initial);
  expectHeaderClear(await headerLayout(page), { phone: initial.width < 1024, longVersion: false });
  await expect(page.locator('#versionPill')).toHaveAttribute('aria-label', 'Master CV');
  await expectHit(page, '.more-menu > summary');
  await expectTabsReadable(page, initial.width);

  await chooseLongVersion(page);
  for (const size of sweep) {
    await settle(page, size);
    const phone = size.width < 1024;
    expectHeaderClear(await headerLayout(page), { phone, longVersion: true });
    await expectHit(page, '.more-menu > summary');
    if (size.label === '320') await shot(page, testInfo, 'v2.0f7a-320-header.png');
    await expectTabsReadable(page, size.width);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  }

  const keyboardSize = sweep.find((size) => size.width === 320 || size.width === 360 || size.width === 1024);
  await settle(page, keyboardSize);
  await expectKeyboardTabs(page);
  await page.locator('.more-menu > summary').click();
  await expect(page.getByRole('button', { name: 'Import', exact: true })).toBeVisible();
  await expectHit(page, '#importButton');
  await page.keyboard.press('Escape');
  await expect(page.locator('#moreMenuContent')).toBeHidden();

  if (testInfo.project.name === 'phone-390') {
    await settle(page, { width: 320, height: 640 });
    await shot(page, testInfo, 'v2.0f7a-320-tabs.png');
  }
  if (testInfo.project.name === 'desktop-1440') {
    await settle(page, { width: 1440, height: 900 });
    await shot(page, testInfo, 'v2.0f7a-1440-header.png');
  }
});

test('Tailor heading stays compact and the last controls clear the bottom bar', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'phone-390', 'Short-height Tailor checks use the 390 phone project.');
  test.setTimeout(90000);
  await openEditor(page);
  await chooseLongVersion(page);

  for (const size of [{ width: 390, height: 844, file: 'v2.0f7a-390-tailor.png' }, { width: 844, height: 390, file: 'v2.0f7a-844x390-tailor.png' }]) {
    await settle(page, size);
    if (await page.locator('#tailorPanel').isHidden()) await page.locator('#versionBannerTailor').click();
    await expect(page.locator('#tailorHeading')).toHaveText(`Tailoring: ${longName}`);
    await expect(page.locator('#versionBanner')).toContainText(`Viewing ${longName}`);
    const heading = await page.locator('#tailorHeading').evaluate((element) => {
      const style = getComputedStyle(element);
      const box = element.getBoundingClientRect();
      const lineHeight = Number.parseFloat(style.lineHeight) || box.height || 1;
      return { lines: box.height / lineHeight, fontSize: Number.parseFloat(style.fontSize) };
    });
    expect(heading.lines).toBeLessThan(1.45);
    expect(heading.fontSize).toBeLessThanOrEqual(16);
    const doneBox = await page.locator('#tailorDoneButton').boundingBox();
    const headingBox = await page.locator('#tailorHeading').boundingBox();
    expect(overlaps(doneBox, headingBox)).toBe(false);
    const versionCopy = page.locator('#versionCopy');
    if (!(await versionCopy.evaluate((element) => element.open))) await versionCopy.locator('summary').click();
    await expectClearOfNavigation(page, '#versionSummary');
    await expectClearOfNavigation(page, '#versionTitle');
    await expectClearOfNavigation(page, '#tailorDoneButton');
    await page.locator('#versionSummary').fill('Layout check summary.');
    await expect(page.locator('#versionSummary')).toHaveValue('Layout check summary.');
    await shot(page, testInfo, size.file);
    await page.locator('#tailorDoneButton').click();
    await expect(page.locator('#tailorPanel')).toBeHidden();
  }
});

test('saving, saved, error, and conflict status stay readable', async ({ page }, testInfo) => {
  const sizes = testInfo.project.name === 'phone-390'
    ? [{ width: 320, height: 640, label: '320' }]
    : testInfo.project.name === 'phone-360'
      ? [{ width: 360, height: 640, label: '360' }]
      : testInfo.project.name === 'desktop-1440'
        ? [{ width: 1024, height: 768, label: '1024' }, { width: 1440, height: 900, label: '1440' }]
        : null;
  test.skip(!sizes, 'Status geometry runs on the phone and desktop projects.');
  await openEditor(page);
  await page.getByLabel('Location').fill('Denver, CO');
  await expect(page.locator('#saveStatus')).toContainText('Saved locally');

  for (const size of sizes) {
    await settle(page, size);
    const phone = size.width < 1024;
    await page.evaluate(() => setStatus('saving', 'Saving...'));
    await expect(page.locator('#saveStatus')).toContainText('Saving...');
    await expect(page.locator('#saveStatus')).toHaveAttribute('aria-live', 'polite');
    let layout = await headerLayout(page);
    expectHeaderClear(layout, { phone, longVersion: false });
    expect(layout.statusText).toContain('Saving...');
    expect(layout.statusClipped).toBe(false);

    await page.evaluate(() => setStatus('saved', 'Saved locally'));
    layout = await headerLayout(page);
    expectHeaderClear(layout, { phone, longVersion: false });
    expect(layout.statusText).toContain('Saved locally');
    expect(layout.statusClipped).toBe(false);
    expect(layout.statusHidden).toBeNull();

    await page.evaluate(() => setStatus('error', 'PDF imported in this tab, but it could not be saved locally'));
    layout = await headerLayout(page);
    expectHeaderClear(layout, { phone, longVersion: false });
    expect(layout.statusText).toContain('could not be saved locally');
    expect(layout.statusClipped).toBe(false);
    await expectHit(page, '.more-menu > summary');
    if (size.label === '320') await shot(page, testInfo, 'v2.0f7a-320-error-status.png');

    await page.evaluate(() => showStorageConflict(4));
    await expect(page.locator('#storageNotice')).toContainText('saved in another tab');
    await expect(page.locator('#saveStatus')).toBeVisible();
    await expectHit(page, '#reloadLatestButton');
    await expectHit(page, '#keepMineButton');
    const noticeOverflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(noticeOverflow).toBeLessThanOrEqual(0);
    if (size.label === '320') await shot(page, testInfo, 'v2.0f7a-320-conflict.png');
    if (size.label === '1024') await shot(page, testInfo, 'v2.0f7a-1024-header.png');
    await page.evaluate(() => {
      const notice = document.querySelector('#storageNotice');
      notice.hidden = true;
      notice.inert = true;
      storageConflict = false;
      storageNoticeKind = null;
      setStatus('saved', 'Saved locally');
      if (typeof updateStickyOffsets === 'function') updateStickyOffsets();
    });
  }
});
