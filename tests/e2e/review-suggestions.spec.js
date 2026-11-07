const { test: base, expect } = require('@playwright/test');

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

const longBullet = `${'Reviewed the weekly hiring packet and shared the result. '.repeat(4)}done`;

function storedRecord({ summary = 'Builds clear tools for hiring teams.', versions = [] } = {}) {
  return {
    schemaVersion: 2,
    savedAt: '2026-11-07T18:00:00.000Z',
    master: {
      basics: {
        name: 'Alex Morgan',
        title: 'Product Designer',
        location: 'Austin, TX',
        email: 'alex@example.com',
        phone: '',
        website: ''
      },
      exportName: '',
      summary,
      experience: [
        { id: 'exp_dated', role: 'Designer', company: 'Northstar', dates: '2020 - 2024', highlights: longBullet },
        { id: 'exp_open', role: 'Analyst', company: 'Field Lab', dates: '', highlights: 'Reviewed applications.' }
      ],
      education: [{ id: 'edu_main', degree: 'BFA', school: 'State University', dates: '2014 - 2018' }],
      skills: 'Research'
    },
    versions
  };
}

const sectionHeadings = {
  Contact: 'Contact details',
  Summary: 'Professional summary',
  Experience: 'Experience',
  Education: 'Education',
  Skills: 'Skills'
};

async function openStored(page, data) {
  await page.addInitScript((stored) => {
    localStorage.setItem('state-cv-data-v1', stored);
  }, JSON.stringify(data));
  await page.goto('/app/');
  await page.getByRole('button', { name: /Continue/ }).click();
  const launchScreen = page.locator('#launchScreen');
  await expect(launchScreen).toHaveClass(/is-hidden/);
  await expect.poll(() => launchScreen.evaluate((screen) => {
    const style = getComputedStyle(screen);
    return Number(style.opacity) < 0.01 && style.pointerEvents === 'none'
      && !document.querySelector('#appShell').hasAttribute('inert');
  })).toBe(true);
}

async function openSection(page, name) {
  const button = page.locator('.section-nav').getByRole('button', { name: new RegExp(`(^|\\s)${name}(, complete)?$`) });
  const heading = page.getByRole('heading', { level: 2, name: sectionHeadings[name], exact: true });
  await expect(button).toBeVisible();
  await expect(async () => {
    await button.evaluate((element) => {
      element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    });
    await button.click({ timeout: 1000 });
    await expect(heading).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 8000 });
}

async function tipTexts(page, selector) {
  return page.locator(selector).evaluate((list) => [...list.querySelectorAll('li')].map((item) => item.textContent));
}

async function openExport(page) {
  const menu = page.locator('.more-menu');
  if (await menu.evaluate((element) => element.open)) await page.locator('.more-menu > summary').click();
  const phoneExport = page.locator('#mobileExportButton');
  if (await phoneExport.isVisible()) {
    if ((await page.locator('#appShell').getAttribute('data-mobile-view')) !== 'export') await phoneExport.click();
  } else if ((await page.locator('#printButton').getAttribute('aria-expanded')) !== 'true') {
    await page.locator('#printButton').click();
  }
  await expect(page.locator('#exportPanel')).toBeVisible();
}

async function closeExport(page) {
  const phoneExport = page.locator('#mobileExportButton');
  if (await phoneExport.isVisible()) await page.getByRole('button', { name: 'Edit', exact: true }).click();
  else if ((await page.locator('#printButton').getAttribute('aria-expanded')) === 'true') await page.locator('#printButton').click();
  await expect(page.locator('#exportPanel')).toBeHidden();
}

async function selectVersion(page, name) {
  const sheet = page.locator('#versionSheet');
  if (!(await sheet.isVisible())) await page.locator('#versionPill').click();
  await expect(sheet).toBeVisible();
  await page.getByRole('radio', { name, exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(sheet).toBeHidden();
}

async function openReview(page) {
  const chip = page.getByRole('button', { name: /CV completeness/ });
  if ((await chip.getAttribute('aria-expanded')) !== 'true') await chip.click();
  await expect(page.locator('#reviewPanel')).toBeVisible();
  await expect(chip).toHaveAttribute('aria-expanded', 'true');
  return chip;
}

test('clearing and restoring the summary updates the live score and suggestion', async ({ page }) => {
  test.setTimeout(90000);
  await openStored(page, storedRecord());
  const chip = await openReview(page);
  await expect(page.locator('#completionPercent')).toHaveText('100%');
  await expect(page.locator('#completionLabel')).toHaveText('Looking strong');
  await expect(page.locator('#reviewCompletenessScore')).toHaveText('100% of the seven counted master CV checks are filled.');
  await expect(page.locator('#reviewPanel')).toContainText('Completeness is not ATS approval');
  await expect(page.locator('#reviewPanel')).toContainText('does not mean the CV is ready to send');
  await expect(page.locator('#reviewPanel')).toContainText('100% can still have an ATS suggestion');
  await expect(page.locator('#reviewPanel')).not.toContainText('Main sections filled');
  await expect(chip).not.toContainText('Ready to send');
  await expect(chip).not.toContainText('CV strength');
  expect(await tipTexts(page, '#reviewAtsList')).toEqual([
    'Add your phone number.',
    '1 experience entry has no dates.',
    '1 bullet is longer than 200 characters.'
  ]);

  await openSection(page, 'Summary');
  const summary = page.getByRole('textbox', { name: /^Summary \d/ });
  await summary.fill('');
  await expect(summary).toBeFocused();
  await expect(chip).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('#completionPercent')).toHaveText('86%');
  await expect(page.locator('#completionLabel')).toHaveText('Looking strong');
  await expect(page.locator('#reviewCompletenessScore')).toHaveText('86% of the seven counted master CV checks are filled.');
  expect(await tipTexts(page, '#reviewAtsList')).toEqual([
    'Add your phone number.',
    'Add a professional summary.',
    '1 experience entry has no dates.',
    '1 bullet is longer than 200 characters.'
  ]);

  await summary.focus();
  const restored = 'Builds clear tools.';
  for (const character of restored) {
    await page.keyboard.type(character);
    await expect(summary).toBeFocused();
  }
  await expect(page.locator('#completionPercent')).toHaveText('100%');
  expect(await tipTexts(page, '#reviewAtsList')).toEqual([
    'Add your phone number.',
    '1 experience entry has no dates.',
    '1 bullet is longer than 200 characters.'
  ]);
  await expect(page.locator('#reviewAtsList')).not.toHaveAttribute('aria-live', /.+/);
  await expect(page.locator('#reviewCompletenessScore')).not.toHaveAttribute('aria-live', /.+/);
  await expect(page.locator('#atsTipsCount')).toHaveAttribute('aria-live', 'polite');
});

test('version hiding and title or summary overrides match Export', async ({ page }) => {
  test.setTimeout(120000);
  await openStored(page, storedRecord({
    versions: [{
      id: 'ver_role',
      name: 'Campus role',
      hiddenEntries: [],
      hiddenBullets: {},
      hiddenSkills: [],
      title: '',
      summary: '',
      exportName: ''
    }]
  }));
  const chip = await openReview(page);
  await expect(page.locator('#reviewAtsBasis')).toHaveText('These checks match Export for the master CV.');
  expect(await tipTexts(page, '#reviewAtsList')).toEqual(await tipTexts(page, '#atsTipsList'));

  await selectVersion(page, 'Campus role');
  await expect(chip).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('#completionPercent')).toHaveText('100%');
  await expect(page.locator('#reviewAtsBasis')).toContainText('Campus role');
  if (await page.locator('#tailorPanel').isHidden()) await page.locator('#versionBannerTailor').click();
  await expect(page.locator('#tailorPanel')).toBeVisible();
  await expect(page.locator('#reviewPanel')).toBeVisible();

  const dated = page.locator('#versionEntryList .version-entry-block').filter({ hasText: 'Designer, Northstar' });
  const bullets = dated.locator('details.version-bullets');
  if (!(await bullets.evaluate((element) => element.open))) await bullets.locator('summary').click();
  await bullets.locator('input').uncheck();
  const undated = page.locator('#versionEntryList .version-entry-block').filter({ hasText: 'Analyst, Field Lab' });
  await undated.locator('label').first().locator('input').uncheck();
  const skills = page.locator('#versionSkills');
  if (!(await skills.evaluate((element) => element.open))) await skills.locator('summary').click();
  await page.locator('#versionSkillList label').filter({ hasText: 'Research' }).locator('input').uncheck();
  const copy = page.locator('#versionCopy');
  if (!(await copy.evaluate((element) => element.open))) await copy.locator('summary').click();
  const title = page.locator('#versionTitle');
  await title.focus();
  await page.keyboard.type('Guide ');
  await expect(title).toBeFocused();
  await title.fill('Guide Ł');
  await expect(title).toBeFocused();
  await page.locator('#versionSummary').fill('Version only summary.');

  const versionTips = [
    'Add your phone number.',
    'Add your skills.',
    'Unsupported characters: Ł.'
  ];
  expect(await tipTexts(page, '#reviewAtsList')).toEqual(versionTips);
  await expect(page.locator('#completionPercent')).toHaveText('100%');

  await page.locator('#tailorDoneButton').click();
  await openSection(page, 'Summary');
  const summary = page.getByRole('textbox', { name: /^Summary \d/ });
  await summary.fill('');
  await expect(summary).toBeFocused();
  await expect(page.locator('#completionPercent')).toHaveText('86%');
  expect(await tipTexts(page, '#reviewAtsList')).toEqual(versionTips);

  await openExport(page);
  expect(await tipTexts(page, '#atsTipsList')).toEqual(versionTips);
  await expect(page.locator('#atsTipsCount')).toHaveText('(3)');
  await closeExport(page);
  await expect(page.locator('#reviewPanel')).toBeVisible();

  await selectVersion(page, 'Master CV');
  await expect(page.locator('#completionPercent')).toHaveText('86%');
  await expect(page.locator('#reviewAtsBasis')).toHaveText('These checks match Export for the master CV.');
  const masterTips = [
    'Add your phone number.',
    'Add a professional summary.',
    '1 experience entry has no dates.',
    '1 bullet is longer than 200 characters.'
  ];
  expect(await tipTexts(page, '#reviewAtsList')).toEqual(masterTips);
  await openExport(page);
  expect(await tipTexts(page, '#atsTipsList')).toEqual(masterTips);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test('the review panel opens and closes from the keyboard without trapping focus', async ({ page }) => {
  test.setTimeout(90000);
  await page.goto('/app/');
  await page.getByRole('button', { name: /Continue/ }).click();
  const launchScreen = page.locator('#launchScreen');
  await expect(launchScreen).toHaveClass(/is-hidden/);
  await expect.poll(() => launchScreen.evaluate((screen) => {
    const style = getComputedStyle(screen);
    return Number(style.opacity) < 0.01 && style.pointerEvents === 'none'
      && !document.querySelector('#appShell').hasAttribute('inert');
  })).toBe(true);
  const chip = page.getByRole('button', { name: /CV completeness/ });
  await expect(chip).toHaveAttribute('aria-expanded', 'false');
  await expect(chip).toHaveAttribute('aria-controls', 'reviewPanel');
  await expect(page.locator('#completionPercent')).toHaveText('0%');
  await expect(page.locator('#completionLabel')).toHaveText('Add your details');
  await expect(chip).toContainText('Review suggestions');
  await expect(chip).not.toContainText('Ready to send');
  await expect(chip).not.toContainText('CV strength');

  const collapsed = await page.locator('#reviewPanel').evaluate((panel) => {
    const style = getComputedStyle(panel);
    const box = panel.getBoundingClientRect();
    return { display: style.display, height: box.height, hidden: panel.hidden, inert: panel.inert };
  });
  expect(collapsed.display).toBe('none');
  expect(collapsed.height).toBe(0);
  expect(collapsed.hidden).toBe(true);
  expect(collapsed.inert).toBe(true);

  await chip.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#reviewPanel')).toBeVisible();
  await expect(chip).toHaveAttribute('aria-expanded', 'true');
  await expect(chip).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.locator('#reviewPanelClose')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#reviewPanel')).toBeHidden();
  await expect(chip).toBeFocused();
  await expect(chip).toHaveAttribute('aria-expanded', 'false');

  await page.keyboard.press('Space');
  await expect(page.locator('#reviewPanel')).toBeVisible();
  await page.locator('#reviewPanelClose').click();
  await expect(chip).toBeFocused();
  await expect(page.locator('#reviewPanel')).toBeHidden();

  const focusableCollapsed = await page.evaluate(() => {
    const panel = document.querySelector('#reviewPanel');
    const button = document.querySelector('#reviewPanelClose');
    button.focus();
    return panel.contains(document.activeElement);
  });
  expect(focusableCollapsed).toBe(false);
  await chip.focus();
  await page.keyboard.press('Tab');
  const tabbedInside = await page.evaluate(() => document.querySelector('#reviewPanel').contains(document.activeElement));
  expect(tabbedInside).toBe(false);

  await chip.click();
  await openSection(page, 'Summary');
  const summary = page.getByRole('textbox', { name: /^Summary \d/ });
  await summary.focus();
  for (const character of 'Local note') {
    await page.keyboard.type(character);
    await expect(summary).toBeFocused();
  }
  await expect(page.locator('#completionPercent')).toHaveText('14%');
  await expect(chip).toHaveAttribute('aria-expanded', 'true');
  expect(await tipTexts(page, '#reviewAtsList')).not.toContain('Add a professional summary.');
});

function reviewSizes(projectName) {
  if (projectName === 'phone-390') {
    return [
      { width: 320, height: 640, label: '320' },
      { width: 390, height: 844, label: '390' },
      { width: 844, height: 390, label: '844x390' }
    ];
  }
  if (projectName === 'desktop-1440') {
    return [
      { width: 1024, height: 768, label: '1024' },
      { width: 1440, height: 900, label: '1440' }
    ];
  }
  return null;
}

async function expectReachable(page, selector) {
  const result = await page.locator(selector).evaluate((element) => {
    element.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
    const box = element.getBoundingClientRect();
    const nav = document.querySelector('.mobile-view-nav');
    const navBox = nav.getBoundingClientRect();
    const navShown = getComputedStyle(nav).display !== 'none';
    const topbar = document.querySelector('.topbar').getBoundingClientRect();
    const x = Math.min(window.innerWidth - 2, Math.max(2, box.left + Math.min(box.width / 2, 24)));
    const y = Math.min(window.innerHeight - 2, Math.max(2, box.top + Math.min(box.height / 2, 16)));
    const hit = document.elementFromPoint(x, y);
    return {
      inView: box.width > 0 && box.height > 0 && box.bottom > 0 && box.top < window.innerHeight && box.left < window.innerWidth && box.right > 0,
      underNav: navShown && box.top < navBox.bottom - 1 && box.bottom > navBox.top + 1,
      underTop: box.top < topbar.bottom - 1 && box.bottom > topbar.top + 1,
      clickable: Boolean(hit && (hit === element || element.contains(hit)))
    };
  });
  expect(result.inView, `${selector} is outside the viewport`).toBe(true);
  expect(result.underNav, `${selector} sits under the bottom navigation`).toBe(false);
  expect(result.underTop, `${selector} sits under the top bar`).toBe(false);
  expect(result.clickable, `${selector} cannot be activated`).toBe(true);
}

test('the review panel fits and its controls stay reachable', async ({ page }, testInfo) => {
  const sizes = reviewSizes(testInfo.project.name);
  test.skip(!sizes, 'Review panel geometry runs on the 390 and 1440 projects.');
  test.setTimeout(90000);
  await openStored(page, storedRecord());
  for (const size of sizes) {
    await page.setViewportSize({ width: size.width, height: size.height });
    await page.evaluate(() => {
      if (typeof updateStickyOffsets === 'function') updateStickyOffsets();
    });
    const chip = page.getByRole('button', { name: /CV completeness/ });
    if ((await chip.getAttribute('aria-expanded')) === 'true') await chip.click();
    await expect(page.locator('#reviewPanel')).toBeHidden();
    const collapsed = await page.locator('#reviewPanel').evaluate((panel) => getComputedStyle(panel).display);
    expect(collapsed).toBe('none');
    await expectReachable(page, '#completionToggle');
    const headingClear = await page.evaluate(() => {
      const title = document.querySelector('.panel-heading h1').getBoundingClientRect();
      const button = document.querySelector('#completionToggle').getBoundingClientRect();
      const overlaps = title.right > button.left + 1 && title.left < button.right - 1 && title.bottom > button.top + 1 && title.top < button.bottom - 1;
      return { overlaps, overflow: document.documentElement.scrollWidth - window.innerWidth };
    });
    expect(headingClear.overlaps, `${size.label} completeness chip covers the heading`).toBe(false);
    expect(headingClear.overflow, `${size.label} page overflows`).toBeLessThanOrEqual(0);

    await chip.click();
    await expect(page.locator('#reviewPanel')).toBeVisible();
    const placed = await page.evaluate(() => {
      const panel = document.querySelector('#reviewPanel').getBoundingClientRect();
      const editor = document.querySelector('.editor-main').getBoundingClientRect();
      const preview = document.querySelector('#previewPanel');
      const previewBox = preview.getBoundingClientRect();
      const previewShown = getComputedStyle(preview).display !== 'none' && previewBox.width > 0;
      const overlapsPreview = previewShown && panel.right > previewBox.left + 1 && panel.left < previewBox.right - 1
        && panel.bottom > previewBox.top + 1 && panel.top < previewBox.bottom - 1;
      const pill = document.querySelector('#versionPill').getBoundingClientRect();
      const menu = document.querySelector('.more-menu > summary').getBoundingClientRect();
      const status = document.querySelector('#saveStatus').getBoundingClientRect();
      const headerOverlap = (first, second) => first.right > second.left + 1 && first.left < second.right - 1
        && first.bottom > second.top + 1 && first.top < second.bottom - 1;
      return {
        insideEditor: panel.left >= editor.left - 1 && panel.right <= editor.right + 1 && panel.width > 0,
        overlapsPreview,
        headerClear: !headerOverlap(pill, menu) && !headerOverlap(pill, status) && !headerOverlap(menu, status),
        overflow: document.documentElement.scrollWidth - window.innerWidth
      };
    });
    expect(placed.insideEditor, `${size.label} panel leaves the editor column`).toBe(true);
    expect(placed.overlapsPreview, `${size.label} panel covers the preview`).toBe(false);
    expect(placed.headerClear, `${size.label} header controls overlap`).toBe(true);
    expect(placed.overflow, `${size.label} page overflows with the panel open`).toBeLessThanOrEqual(0);
    await expectReachable(page, '#completionToggle');
    await expectReachable(page, '#reviewPanelClose');
    await expectReachable(page, '#reviewAtsList li:nth-child(1)');
    await expectReachable(page, '#reviewAtsList li:last-child');
    await expect(page.locator('#versionPill')).toBeVisible();
    await expect(page.locator('.more-menu > summary')).toBeVisible();
  }
});
