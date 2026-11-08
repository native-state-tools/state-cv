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
  await page.goto('/app/');
  await expect(page.getByRole('button', { name: /Continue/ })).toBeVisible();
}

// Tap targets must be at least 44px. Round first so sub-pixel layout (e.g. 43.99997) doesn't fail.
function expectTapSize(value) {
  expect(Math.round(value)).toBeGreaterThanOrEqual(44);
}

async function enterEditor(page) {
  await page.getByRole('button', { name: /Continue/ }).click();
  const launchScreen = page.locator('#launchScreen');
  await expect(launchScreen).toHaveClass(/is-hidden/);
  await expect.poll(() => launchScreen.evaluate((screen) => {
    const style = getComputedStyle(screen);
    const more = document.querySelector('.more-menu > summary');
    const box = more.getBoundingClientRect();
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    const coversMore = Boolean(hit && (hit === screen || screen.contains(hit)));
    return Number(style.opacity) < 0.01 && style.pointerEvents === 'none' && !coversMore
      && !document.querySelector('#appShell').hasAttribute('inert');
  })).toBe(true);
  await expect(page.getByLabel('Full name')).toBeVisible();
}

async function activateLink(locator) {
  await locator.evaluate((element) => element.scrollIntoView({ block: 'center', behavior: 'instant' }));
  await expect(locator).toBeInViewport();
  await locator.click();
}

const sectionHeadings = {
  Contact: 'Contact details',
  Summary: 'Professional summary',
  Experience: 'Experience',
  Education: 'Education',
  Skills: 'Skills'
};

async function openSection(page, name) {
  const button = page.locator('.section-nav').getByRole('button', { name: new RegExp(`(^|\\s)${name}(, complete)?$`) });
  const heading = page.getByRole('heading', { level: 2, name: sectionHeadings[name], exact: true });
  await expect(button).toBeVisible();
  await expect(async () => {
    await button.evaluate((element) => {
      element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      const rect = element.getBoundingClientRect();
      const x = Math.min(window.innerWidth - 1, Math.max(0, rect.left + rect.width / 2));
      const y = Math.min(window.innerHeight - 1, Math.max(0, rect.top + rect.height / 2));
      const hit = document.elementFromPoint(x, y);
      if (!hit || (hit !== element && !element.contains(hit))) {
        window.scrollTo({ top: Math.max(0, window.scrollY + rect.top - 96), behavior: 'instant' });
      }
    });
    await button.click({ timeout: 1000 });
    await expect(heading).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 8000 });
}

async function openMenu(page) {
  const summary = page.locator('.more-menu > summary');
  const menu = page.locator('.more-menu');
  if (!(await menu.evaluate((element) => element.open))) await summary.click();
  await expect(page.locator('#moreMenuContent')).toBeVisible();
}

async function openDataDialog(page) {
  await openMenu(page);
  await page.getByRole('button', { name: 'Your data' }).click();
  await expect(page.getByRole('dialog', { name: 'Your data' })).toBeVisible();
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

async function exportPdfFromUi(page) {
  await openExport(page);
  const downloadPromise = page.waitForEvent('download');
  await page.locator('#downloadPdfButton').click();
  return downloadPromise;
}

async function savedName(page) {
  return page.evaluate(() => {
    const raw = localStorage.getItem('state-cv-data-v1');
    if (!raw) return null;
    const data = JSON.parse(raw);
    const master = data.master && typeof data.master === 'object' ? data.master : data;
    return master.basics ? master.basics.name : null;
  });
}

async function visibleLevelOneHeadings(page) {
  const headings = page.getByRole('heading', { level: 1 });
  const count = await headings.count();
  let visible = 0;
  for (let index = 0; index < count; index += 1) {
    const heading = headings.nth(index);
    if (!(await heading.isVisible())) continue;
    const shown = await heading.evaluate((element) => {
      if (element.closest('[inert]')) return false;
      let node = element;
      while (node) {
        const style = getComputedStyle(node);
        if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
        node = node.parentElement;
      }
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    });
    if (shown) visible += 1;
  }
  return visible;
}

const filledCv = {
  schemaVersion: 1,
  basics: {
    name: 'Alex Morgan',
    title: 'Product Designer',
    location: 'Austin, TX',
    email: 'alex@example.com',
    phone: '(555) 123-4567',
    website: 'linkedin.com/in/alexmorgan'
  },
  exportName: 'Alex Morgan CV',
  summary: 'Product designer with six years turning complex workflows into clear, useful experiences for operations teams. Partners with research and engineering to ship tools people can learn quickly. Recent work focused on onboarding, design systems, and accessibility reviews.',
  experience: [
    {
      role: 'Senior Product Designer',
      company: 'Northstar Labs',
      dates: '2020 - 2024',
      highlights: 'Redesigned onboarding and raised activation.\nShipped a design system used by four product teams.\nLed research that cut support contacts.'
    },
    {
      role: 'Product Designer',
      company: 'Harbor Studio',
      dates: '2018 - 2020',
      highlights: 'Built the client portal used by regional offices.\nPaired with engineers on weekly releases.\nDocumented patterns for new hires.'
    },
    {
      role: 'Design Intern',
      company: 'Fieldwork',
      dates: '2017 - 2018',
      highlights: 'Prototyped the scheduling flow.\nOrganized research notes for the team.\nPresented findings each Friday.'
    },
    { role: '', company: 'Placeholder Check Co', dates: '', highlights: '' }
  ],
  education: [
    {
      degree: 'Bachelor of Fine Arts in Interaction Design, Visual Communication, and Human-Computer Interaction',
      school: 'State University',
      dates: '2014 - 2018'
    },
    { degree: '', school: 'City College', dates: '2019' }
  ],
  skills: 'Figma, user research, prototyping, design systems, accessibility, workshop facilitation'
};

async function openStoredCv(page, data) {
  await page.addInitScript((stored) => {
    localStorage.setItem('state-cv-data-v1', stored);
  }, JSON.stringify(data));
  await openApp(page);
  await enterEditor(page);
}

async function readPdfDocument(page, download) {
  const downloadPath = await download.path();
  expect(downloadPath).not.toBeNull();
  const bytes = await fs.readFile(downloadPath);
  const parsed = await page.evaluate(async (pdfBytes) => {
    const loadingTask = window.pdfjsLib.getDocument({
      data: new Uint8Array(pdfBytes),
      isEvalSupported: false,
      enableXfa: false,
      disableFontFace: true,
      useWorkerFetch: false,
      verbosity: 0
    });
    try {
      const pdf = await loadingTask.promise;
      const items = [];
      for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
        const pdfPage = await pdf.getPage(pageNumber);
        const content = await pdfPage.getTextContent();
        content.items.forEach((item) => {
          if (item.str) items.push(item.str);
        });
      }
      return { pageCount: pdf.numPages, items };
    } finally {
      await loadingTask.destroy().catch(() => {});
    }
  }, Array.from(bytes));
  return { bytes, ...parsed };
}

async function exportPdfDownload(page) {
  return readPdfDocument(page, await exportPdfFromUi(page));
}

test('start screen shows the expected local CV options', async ({ page }) => {
  await openApp(page);
  await expect(page.getByRole('button', { name: 'Start a new CV' })).toBeVisible();
  await expect(page.locator('#newCvButton')).toHaveClass(/launch-card-primary/);
  await expect(page.locator('#continueButton')).not.toHaveClass(/launch-card-primary/);
  await expect(page.locator('#continueButton')).toContainText('No saved draft yet');
  await expect(page.getByRole('button', { name: 'Import a PDF' })).toBeVisible();
  await expect(page.getByText('Your data stays in this browser')).toBeVisible();
});

test('launch screen highlights Continue when a draft is saved', async ({ page }) => {
  await openApp(page);
  await enterEditor(page);
  await page.getByLabel('Full name').fill('Alex Morgan');
  await expect(page.locator('#saveStatus')).toContainText('Saved locally');
  await page.locator('#brandHome').click();
  await expect(page.locator('#continueButton')).toBeVisible();
  await expect(page.locator('#continueButton')).toHaveClass(/launch-card-primary/);
  await expect(page.locator('#continueButton')).toContainText('Continue Alex Morgan');
  await expect(page.locator('#newCvButton')).not.toHaveClass(/launch-card-primary/);
  await expect(page.locator('#newCvButton')).toBeVisible();
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

test('only one editor section is visible and hidden sections are inert', async ({ page }) => {
  await openApp(page);
  await enterEditor(page);
  const readSections = () => page.locator('.form-section').evaluateAll((sections) => sections.map((section) => ({
    id: section.dataset.editorSection,
    hidden: section.hidden,
    inert: section.inert
  })));
  const expectOnly = async (activeId) => {
    const sections = await readSections();
    expect(sections.map((section) => section.id)).toEqual(['contact', 'summary', 'experience', 'education', 'skills']);
    expect(sections.filter((section) => !section.hidden && !section.inert).map((section) => section.id)).toEqual([activeId]);
    expect(sections.filter((section) => section.hidden && section.inert)).toHaveLength(4);
  };
  await expectOnly('contact');
  await openSection(page, 'Education');
  await expectOnly('education');
  await expect(page.getByLabel('Full name')).toBeHidden();

  await openSection(page, 'Skills');
  await page.locator('#importInput').setInputFiles({
    name: 'section-return.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(validBackup))
  });
  await expect(page.getByLabel('Full name')).toBeVisible();
  await expect(page.getByLabel('Full name')).toHaveValue('Recovered CV');
  await expectOnly('contact');

  page.once('dialog', (dialog) => dialog.accept());
  await page.locator('.more-menu > summary').click();
  await page.getByRole('button', { name: 'Start new CV', exact: true }).click();
  await expect(page.getByLabel('Full name')).toHaveValue('');
  await expectOnly('contact');
});

test('Next and Back move through every editor section and focus the heading', async ({ page, isMobile }) => {
  await openApp(page);
  await enterEditor(page);
  await expect(page.locator('[data-editor-section="contact"] [data-section-back]')).toBeHidden();
  for (const name of ['Professional summary', 'Experience', 'Education', 'Skills']) {
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await expect(page.getByRole('heading', { level: 2, name, exact: true })).toBeFocused();
  }
  const skillsNext = page.locator('[data-editor-section="skills"] [data-section-next]');
  if (isMobile) {
    const label = await skillsNext.evaluate((node) => node.innerText.replace(/\s+/g, ' ').trim());
    expect(label).toBe('Preview');
  } else {
    await expect(skillsNext).toBeHidden();
  }
  for (const name of ['Education', 'Experience', 'Professional summary', 'Contact details']) {
    await page.getByRole('button', { name: 'Back', exact: true }).click();
    await expect(page.getByRole('heading', { level: 2, name, exact: true })).toBeFocused();
  }
  await expect(page.locator('[data-editor-section="contact"] [data-section-back]')).toBeHidden();
  if (isMobile) {
    for (let step = 0; step < 4; step += 1) {
      await page.getByRole('button', { name: 'Next', exact: true }).click();
    }
    await skillsNext.click();
    await expect(page.locator('#appShell')).toHaveAttribute('data-mobile-view', 'preview');
    await expect(page.locator('#previewPanel')).toBeVisible();
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    await expect(page.getByRole('heading', { level: 2, name: 'Skills', exact: true })).toBeVisible();
  }
});

test('a section check mark appears after the section is filled', async ({ page }) => {
  await openApp(page);
  await enterEditor(page);
  const contactCheck = page.locator('[data-section-check="contact"]');
  await expect(contactCheck).toBeHidden();
  await page.getByLabel('Full name').fill('Alex Morgan');
  await page.getByLabel('Professional title').fill('Designer');
  await expect(contactCheck).toBeHidden();
  await page.getByLabel('Email').fill('alex@example.com');
  await expect(contactCheck).toBeVisible();
  await expect(page.locator('.section-nav').getByRole('button', { name: /Contact, complete$/ })).toBeVisible();
  await openSection(page, 'Experience');
  const experienceCheck = page.locator('[data-section-check="experience"]');
  await expect(experienceCheck).toBeHidden();
  await page.getByLabel('Company').fill('Northstar Labs');
  await expect(experienceCheck).toBeVisible();
});

test('desktop section sidebar collapse toggle works', async ({ page, isMobile }) => {
  await openApp(page);
  await enterEditor(page);
  const toggle = page.locator('#sectionNavToggle');
  if (isMobile) {
    await expect(toggle).toBeHidden();
    return;
  }
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('.section-nav-name', { hasText: 'Experience' })).toBeVisible();
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(toggle).toHaveAttribute('aria-label', 'Expand sections');
  await expect(page.locator('.section-nav-name', { hasText: 'Experience' })).toBeHidden();
  await expect(page.locator('.section-nav-number', { hasText: '03' })).toBeVisible();
  await page.locator('.section-nav').getByRole('button', { name: /Summary$/ }).click();
  await expect(page.getByRole('heading', { level: 2, name: 'Professional summary', exact: true })).toBeFocused();
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('.section-nav-name', { hasText: 'Summary' })).toBeVisible();
  await page.reload();
  await enterEditor(page);
  await expect(page.locator('#sectionNavToggle')).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('.section-nav-name', { hasText: 'Contact' })).toBeVisible();
});

test('phone preview layout keeps Full name within 260px on an empty CV', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'phone-390', 'This check is the 390px phone layout');
  await openApp(page);
  await enterEditor(page);
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect(page.locator('#importPdfButton')).toBeVisible();
  const emptyTop = await page.getByLabel('Full name').evaluate((field) => field.getBoundingClientRect().top);
  expect(emptyTop).toBeLessThanOrEqual(260);
  await page.getByLabel('Full name').fill('Alex Morgan');
  await expect(page.locator('#importPdfButton')).toBeHidden();
  const filledTop = await page.getByLabel('Full name').evaluate((field) => field.getBoundingClientRect().top);
  expect(filledTop).toBeLessThan(emptyTop);
});

test('desktop preview layout keeps the editor column at least 480px at 1440', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-1440', 'This check is the 1440 desktop layout');
  await openApp(page);
  await enterEditor(page);
  const width = await page.locator('.editor-main').evaluate((column) => column.getBoundingClientRect().width);
  expect(width).toBeGreaterThanOrEqual(480);
});

test('desktop preview layout keeps the editor column at least 480px at 1280', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-1440', 'Resized from the desktop project');
  await openApp(page);
  await enterEditor(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  const width = await page.locator('.editor-main').evaluate((column) => column.getBoundingClientRect().width);
  expect(width).toBeGreaterThanOrEqual(480);
});

test('preview strips a leading dash from a typed bullet', async ({ page, isMobile }) => {
  await openApp(page);
  await enterEditor(page);
  await openSection(page, 'Experience');
  await page.getByLabel(/^Highlights/).fill('- Led a team');
  if (isMobile) await page.getByRole('button', { name: 'Preview', exact: true }).click();
  await expect(page.locator('#resumePreview .entry-bullets li')).toHaveText('Led a team');
});

test('phone-360 section tab row is visible and the bottom bar keeps Edit, Preview, and Export', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'phone-360', 'This check is the 360px phone layout');
  await openApp(page);
  await enterEditor(page);
  const tabs = page.locator('.section-nav');
  await expect(tabs).toBeVisible();
  for (const name of ['Contact', 'Summary', 'Experience', 'Education', 'Skills']) {
    await expect(tabs.getByRole('button', { name: new RegExp(`(^|\\s)${name}$`) })).toBeVisible();
  }
  const bar = page.locator('nav[aria-label="Editor navigation"]');
  await expect(bar.getByRole('button', { name: 'Edit', exact: true })).toBeVisible();
  await expect(bar.getByRole('button', { name: 'Preview', exact: true })).toBeVisible();
  await expect(bar.locator('#mobileExportButton')).toHaveText('Export');
  await expect(bar.locator('#mobileExportButton')).toBeVisible();
  await bar.locator('#mobileExportButton').click();
  await expect(page.locator('#appShell')).toHaveAttribute('data-mobile-view', 'export');
  await expect(bar.locator('#mobileExportButton')).toHaveAttribute('aria-pressed', 'true');
  await expect(bar.getByRole('button', { name: 'Edit', exact: true })).toHaveAttribute('aria-pressed', 'false');
  await expect(bar.getByRole('button', { name: 'Preview', exact: true })).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('#exportPanel')).toBeVisible();
  await expect(page.locator('#downloadPdfButton')).toBeVisible();
  await expect(page.locator('.editor-panel')).toBeHidden();
  await expect(page.locator('#previewPanel')).toBeHidden();
  await bar.getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(page.locator('#appShell')).toHaveAttribute('data-mobile-view', 'edit');
  await expect(bar.locator('#mobileExportButton')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('#exportPanel')).toBeHidden();
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

  page.once('dialog', (dialog) => dialog.accept());
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

  await page.locator('.more-menu > summary').click();
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
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('state-cv-snapshots-v1')).map((snapshot) => {
    const data = snapshot.data || {};
    const master = data.master && typeof data.master === 'object' ? data.master : data;
    return master.basics ? master.basics.name : null;
  })))
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

test('v1 saved data migrates to schemaVersion 2 and keeps one premigration copy', async ({ page }) => {
  const v1 = {
    schemaVersion: 1,
    basics: {
      name: 'Migrated Person',
      title: 'Analyst',
      location: 'Denver, CO',
      email: 'mig@example.com',
      phone: '555-0100',
      website: ''
    },
    exportName: 'Migrated Person CV',
    summary: 'Keeps the old CV.',
    experience: [{ role: 'Analyst', company: 'North Co', dates: '2021 - 2024', highlights: 'Did the work' }],
    education: [{ degree: 'B.A.', school: 'State University', dates: '2017 - 2021' }],
    skills: 'Analysis'
  };
  const raw = JSON.stringify(v1);
  await openApp(page);
  await page.evaluate((stored) => localStorage.setItem('state-cv-data-v1', stored), raw);
  await page.reload();
  await enterEditor(page);
  await expect(page.getByLabel('Full name')).toHaveValue('Migrated Person');
  await expect(page.getByLabel('Email')).toHaveValue('mig@example.com');
  await openSection(page, 'Experience');
  await expect(page.getByLabel('Job title')).toHaveValue('Analyst');
  await expect(page.getByLabel('Company')).toHaveValue('North Co');

  const stored = await page.evaluate(() => ({
    data: localStorage.getItem('state-cv-data-v1'),
    premigration: localStorage.getItem('state-cv-premigration-v1'),
    snapshots: localStorage.getItem('state-cv-snapshots-v1')
  }));
  expect(stored.premigration).toBe(raw);
  const saved = JSON.parse(stored.data);
  expect(saved.schemaVersion).toBe(2);
  expect(saved.versions).toEqual([]);
  expect(saved.master.basics.name).toBe('Migrated Person');
  expect(saved.master.experience[0].role).toBe('Analyst');
  expect(saved.master.experience[0].id).toMatch(/^exp_/);
  expect(saved.master.education[0].id).toMatch(/^edu_/);
  expect(saved.master.experience[0].id).not.toBe(saved.master.education[0].id);
  const snapshots = JSON.parse(stored.snapshots);
  expect(snapshots.some((snapshot) => snapshot.data && snapshot.data.basics && snapshot.data.basics.name === 'Migrated Person')).toBe(true);

  await page.reload();
  await enterEditor(page);
  const after = await page.evaluate(() => ({
    data: localStorage.getItem('state-cv-data-v1'),
    premigration: localStorage.getItem('state-cv-premigration-v1')
  }));
  expect(after.premigration).toBe(stored.premigration);
  expect(after.data).toBe(stored.data);
});

test('importing a v1 JSON backup saves and downloads schemaVersion 2', async ({ page }) => {
  await openApp(page);
  await page.locator('#importInput').setInputFiles({
    name: 'v1-backup.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(validBackup))
  });
  await expect(page.getByLabel('Full name')).toHaveValue('Recovered CV');
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('state-cv-data-v1')));
  expect(saved.schemaVersion).toBe(2);
  expect(saved.versions).toEqual([]);
  expect(saved.master.basics.name).toBe('Recovered CV');
  expect(saved.master.experience[0].id).toMatch(/^exp_/);

  const downloadPromise = page.waitForEvent('download');
  await page.locator('.more-menu > summary').click();
  await page.getByRole('button', { name: 'Backup (JSON)' }).click();
  const download = await downloadPromise;
  const backup = JSON.parse(await fs.readFile(await download.path(), 'utf8'));
  expect(backup.schemaVersion).toBe(2);
  expect(backup.versions).toEqual([]);
  expect(backup.master.basics.name).toBe('Recovered CV');
  expect(backup.master.experience[0].id).toMatch(/^exp_/);
  expect(JSON.stringify(backup)).not.toMatch(/"revision"/);
});

test('Clear all data removes the premigration copy', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('state-cv-premigration-v1', '{"schemaVersion":1,"basics":{"name":"Old"}}');
    localStorage.setItem('state-cv-data-v1', JSON.stringify({
      schemaVersion: 2,
      master: {
        basics: { name: 'Clear Me', title: '', location: '', email: '', phone: '', website: '' },
        exportName: '',
        summary: '',
        experience: [{ id: 'exp_1', role: '', company: '', dates: '', highlights: '' }],
        education: [{ id: 'edu_1', degree: '', school: '', dates: '' }],
        skills: ''
      },
      versions: []
    }));
  });
  await openApp(page);
  await enterEditor(page);
  await expect(page.getByLabel('Full name')).toHaveValue('Clear Me');
  await openDataDialog(page);
  await page.getByRole('button', { name: 'Clear all data' }).click();
  await page.getByRole('button', { name: /Click again to clear/ }).click();
  await expect(page.locator('#dataDialogStatus')).toContainText('All State CV data was cleared');
  await expect.poll(() => page.evaluate(() => localStorage.getItem('state-cv-premigration-v1'))).toBeNull();
  await expect.poll(() => page.evaluate(() => localStorage.getItem('state-cv-data-v1'))).toBeNull();
});

test('file:// load starts and supports editing without service-worker registration', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-1440', 'Direct-file support is checked on the desktop project only.');
  const indexPath = path.resolve(__dirname, '../../app/index.html');
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

  await openSection(page, 'Experience');
  await page.getByRole('button', { name: 'Add experience' }).click();
  await expect(page.getByRole('button', { name: 'Remove experience entry 2' })).toBeVisible();
  await openSection(page, 'Education');
  await page.getByRole('button', { name: 'Add education' }).click();
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
  await openSection(page, 'Experience');
  await page.getByRole('button', { name: 'Add experience' }).click();
  const repeatPaddingTop = await page.locator('.repeat-item').first().evaluate((element) => getComputedStyle(element).paddingTop);
  console.log(`Repeat-entry top padding at ${isMobile ? 'phone' : 'desktop'} viewport: ${repeatPaddingTop}`);
  const experienceRemove = page.getByRole('button', { name: 'Remove experience entry 2' });
  await expect(experienceRemove).toBeVisible();
  if (isMobile) {
    const experienceBox = await experienceRemove.boundingBox();
    expectTapSize(experienceBox.width);
    expectTapSize(experienceBox.height);
  }
  await openSection(page, 'Education');
  await page.getByRole('button', { name: 'Add education' }).click();
  const educationRemove = page.getByRole('button', { name: 'Remove education entry 2' });
  await expect(educationRemove).toBeVisible();
  if (isMobile) {
    const educationBox = await educationRemove.boundingBox();
    expectTapSize(educationBox.width);
    expectTapSize(educationBox.height);
  }
});

test('200 percent root text setting keeps phone layout and controls in bounds', async ({ page, isMobile }) => {
  await openApp(page);
  await enterEditor(page);
  const dimensions = await page.evaluate(() => {
    document.documentElement.style.fontSize = '200%';
    if (typeof updateStickyOffsets === 'function') updateStickyOffsets();
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
    const sectionNav = document.querySelector('.section-nav');
    const obscuredFields = [];
    const overlaps = (first, second) =>
      Math.min(first.right, second.right) > Math.max(first.left, second.left) &&
      Math.min(first.bottom, second.bottom) > Math.max(first.top, second.top);
    [...document.querySelectorAll('#resumeForm input, #resumeForm textarea')].forEach((field) => {
      field.scrollIntoView({ behavior: 'instant', block: 'nearest' });
      const box = field.getBoundingClientRect();
      const navBox = nav.getBoundingClientRect();
      const topbarBox = topbar.getBoundingClientRect();
      if (getComputedStyle(nav).display !== 'none' && overlaps(box, navBox)) {
        obscuredFields.push(field.dataset.path || field.dataset.key);
      }
      if (getComputedStyle(topbar).display !== 'none' && overlaps(box, topbarBox)) {
        obscuredFields.push(field.dataset.path || field.dataset.key);
      }
      if (sectionNav && getComputedStyle(sectionNav).position === 'sticky' && overlaps(box, sectionNav.getBoundingClientRect())) {
        obscuredFields.push(field.dataset.path || field.dataset.key);
      }
    });
    const overlappingRemoveTargets = [...document.querySelectorAll('.repeat-item')].filter((item) => {
      const remove = item.querySelector('.remove-item');
      const grid = item.querySelector('.form-grid');
      return Boolean(remove && grid && overlaps(remove.getBoundingClientRect(), grid.getBoundingClientRect()));
    }).length;
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

test('active view exposes one h1 and Menu opens and closes by keyboard', async ({ page }) => {
  await openApp(page);
  expect(await visibleLevelOneHeadings(page)).toBe(1);
  await enterEditor(page);
  expect(await visibleLevelOneHeadings(page)).toBe(1);
  const more = page.locator('.more-menu > summary');
  await expect(page.locator('#moreMenuContent')).toBeHidden();
  await more.focus();
  await page.keyboard.press('Space');
  await expect(page.locator('#moreMenuContent')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#moreMenuContent')).toBeHidden();
  await expect(more).toBeFocused();
  await page.goto('/about.html');
  await expect(page.getByRole('heading', { level: 1, name: 'About and privacy' })).toBeVisible();
  expect(await visibleLevelOneHeadings(page)).toBe(1);
});

test('Your data dialog traps focus, closes with Escape, and restores its opener', async ({ page }) => {
  await openApp(page);
  await enterEditor(page);
  const more = page.locator('.more-menu > summary');
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
  const shellTargets = new Set();
  if (isMobile) {
    shellTargets.add('mobileExportButton');
    shellTargets.add('edit');
    shellTargets.add('preview');
  } else {
    shellTargets.add('printButton');
  }
  const tabUntil = async (targets) => {
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
  };
  await tabUntil(shellTargets);
  await openSection(page, 'Experience');
  await page.locator('#brandHome').focus();
  await tabUntil(new Set(['addExperience']));
  await openSection(page, 'Education');
  await page.locator('#brandHome').focus();
  await tabUntil(new Set(['addEducation']));
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
    const exportPanel = document.querySelector('#exportPanel');
    exportPanel.hidden = false;
    exportPanel.inert = false;
    document.querySelector('.more-menu').open = true;
    const dataDialog = document.querySelector('#yourDataDialog');
    if (!dataDialog.open) dataDialog.show();
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
    const track = document.querySelector('.segmented-track');
    const trackStyle = getComputedStyle(track);
    add('segmented track border', trackStyle.borderTopColor, composite(trackStyle.backgroundColor, paper), 3);
    const filenameBox = document.querySelector('.filename-box');
    const filenameStyle = getComputedStyle(filenameBox);
    add('filename box border', filenameStyle.borderTopColor, composite(filenameStyle.backgroundColor, paper), 3);
    const launchCard = document.querySelector('.launch-card');
    add('launch action border', getComputedStyle(launchCard).borderTopColor, composite(getComputedStyle(launchCard).backgroundColor, canvas), 3);
    const quickAction = document.querySelector('.quick-action');
    const quickActionStyle = getComputedStyle(quickAction);
    const gradientColors = quickActionStyle.backgroundImage.match(/rgba?\([^)]+\)/g);
    if (!gradientColors?.length) throw new Error('PDF import action gradient colors could not be measured.');
    gradientColors.forEach((background, index) =>
      add(`PDF import action border (gradient stop ${index + 1})`, quickActionStyle.borderTopColor, background, 3));
    add('accent button text', color('.button-accent'), getComputedStyle(document.querySelector('.button-accent')).backgroundColor);
    const danger = document.querySelector('#clearDataButton');
    const dangerStyle = getComputedStyle(danger);
    const dangerBackground = composite(dangerStyle.backgroundColor, paper);
    add('danger button text', dangerStyle.color, dangerBackground);
    add('danger button border', dangerStyle.borderTopColor, dangerBackground, 3);
    const selected = document.querySelector('.segmented-option input:checked');
    add('selected segment text', getComputedStyle(selected.nextElementSibling).color, getComputedStyle(selected).backgroundColor);
    add('brand link', color('.brand'), topbar);
    const versionPill = document.querySelector('#versionPill');
    const versionPillStyle = getComputedStyle(versionPill);
    add('version pill text', versionPillStyle.color, topbar);
    add('version pill border', versionPillStyle.borderTopColor, topbar, 3);
    const versionBanner = document.querySelector('#versionBanner');
    const versionBannerStyle = getComputedStyle(versionBanner);
    add('version banner text', getComputedStyle(versionBanner.querySelector('p')).color, versionBannerStyle.backgroundColor);
    add('version banner border', versionBannerStyle.borderTopColor, versionBannerStyle.backgroundColor, 3);
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
  const download = await exportPdfFromUi(page);
  expect(download.suggestedFilename()).toMatch(/\.pdf$/i);
  const downloadPath = await download.path();
  expect(downloadPath).not.toBeNull();
  const bytes = await fs.readFile(downloadPath);
  expect(bytes.subarray(0, 4).toString('ascii')).toBe('%PDF');
  await expect(page.locator('#saveStatus')).toContainText(/PDF exported.*(Download started|Save to Files)/);
});

test('PDF export of a filled CV keeps reading order and omits placeholders', async ({ page }) => {
  await openStoredCv(page, filledCv);
  const exported = await exportPdfDownload(page);
  const text = exported.items.join('');
  const pieces = exported.items.map((item) => item.trim());
  expect(exported.bytes.subarray(0, 4).toString('ascii')).toBe('%PDF');
  expect(exported.pageCount).toBe(1);
  const role = text.indexOf('Senior Product Designer');
  const company = text.indexOf('Northstar Labs');
  const dates = text.indexOf('2020 - 2024');
  expect(role).toBeGreaterThanOrEqual(0);
  expect(company).toBeGreaterThan(role);
  expect(dates).toBeGreaterThan(company);
  expect(text.indexOf('Redesigned onboarding')).toBeGreaterThan(dates);
  const degree = text.indexOf('Interaction Design');
  const school = text.indexOf('State University');
  const eduDates = text.indexOf('2014 - 2018');
  expect(degree).toBeGreaterThanOrEqual(0);
  expect(school).toBeGreaterThan(degree);
  expect(eduDates).toBeGreaterThan(school);
  expect(text.indexOf('Austin, TX')).toBeGreaterThanOrEqual(0);
  expect(text.indexOf('alex@example.com')).toBeGreaterThan(text.indexOf('Austin, TX'));
  expect(text.indexOf('(555) 123-4567')).toBeGreaterThan(text.indexOf('alex@example.com'));
  expect(text.indexOf('linkedin.com/in/alexmorgan')).toBeGreaterThan(text.indexOf('(555) 123-4567'));
  expect(text).toContain('|');
  expect(text).not.toContain('\u00B7');
  expect(pieces).not.toContain('Role');
  expect(pieces).not.toContain('Degree');
  const raw = exported.bytes.toString('latin1');
  expect(raw).toContain('mailto:alex@example.com');
  expect(raw).toContain('https://linkedin.com/in/alexmorgan');
  expect(raw).toContain('/Lang (en)');
  expect(raw).toContain('Alex Morgan');

  if (await page.locator('#mobileExportButton').isVisible()) await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.getByLabel('Full name').fill('');
  await page.getByLabel('Professional title').fill('');
  await expect(page.locator('#saveStatus')).toContainText('Saved locally');
  const withoutHeader = await exportPdfDownload(page);
  const headerPieces = withoutHeader.items.map((item) => item.trim());
  expect(headerPieces).not.toContain('Your Name');
  expect(headerPieces).not.toContain('Professional Title');
  expect(headerPieces).not.toContain('PROFESSIONAL TITLE');
  expect(withoutHeader.items.join('')).toContain('Northstar Labs');
  await expect(page.locator('#saveStatus')).toContainText(/PDF exported.*(Download started|Save to Files)/);
});

test('plain text download contains the CV in reading order', async ({ page }) => {
  await openStoredCv(page, filledCv);
  await openExport(page);
  await expect(page.locator('input[name="textSize"]:checked')).toHaveValue('standard');
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download .txt' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('Alex Morgan CV.txt');
  const downloadPath = await download.path();
  expect(downloadPath).not.toBeNull();
  const content = await fs.readFile(downloadPath, 'utf8');
  const role = content.indexOf('Senior Product Designer');
  const company = content.indexOf('Northstar Labs');
  const dates = content.indexOf('2020 - 2024');
  expect(content.indexOf('Experience')).toBeGreaterThanOrEqual(0);
  expect(content.indexOf('Experience')).toBeLessThan(role);
  expect(role).toBeLessThan(company);
  expect(company).toBeLessThan(dates);
  expect(content.indexOf('- Redesigned onboarding')).toBeGreaterThan(dates);
  const degree = content.indexOf('Interaction Design');
  const school = content.indexOf('State University');
  expect(content.indexOf('Education')).toBeLessThan(degree);
  expect(degree).toBeLessThan(school);
  expect(school).toBeLessThan(content.indexOf('2014 - 2018'));
  expect(content).toContain('Professional Summary');
  expect(content).toContain('Skills');
  expect(content).toContain('Austin, TX | alex@example.com | (555) 123-4567 | linkedin.com/in/alexmorgan');
  expect(content).not.toContain('Your Name');
  expect(content).not.toContain('Professional Title');
  expect(content).not.toContain('Role');
  expect(content).not.toContain('Degree');
  await expect(page.locator('#saveStatus')).toContainText('Plain text downloaded');
});

test('Text size Large increases the preview bullet size', async ({ page, isMobile }) => {
  await openStoredCv(page, filledCv);
  const preview = page.locator('#resumePreview');
  await expect(preview).toHaveClass(/preview-text-standard/);
  const summary = preview.locator('p').first();
  if (isMobile) await page.getByRole('button', { name: 'Preview', exact: true }).click();
  const bullet = preview.locator('.entry-bullets li').first();
  const standardSize = await bullet.evaluate((node) => Number.parseFloat(getComputedStyle(node).fontSize));
  if (isMobile) await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await openExport(page);
  await expect(page.locator('.text-size-hint')).toContainText('Compact 9 pt');
  await expect(page.locator('.text-size-hint')).toContainText('Standard 10.5 pt');
  await expect(page.locator('.text-size-hint')).toContainText('Large 12 pt');
  await page.locator('input[name="paperSize"][value="letter"]').focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('input[name="paperSize"]:checked')).toHaveValue('a4');
  await expect(page.locator('#exportPanel')).toBeVisible();
  await page.keyboard.press('ArrowLeft');
  await expect(page.locator('input[name="paperSize"]:checked')).toHaveValue('letter');
  expect(await page.locator('#formatLabel').textContent()).toContain('Letter');
  await page.locator('input[name="textSize"][value="compact"]').check();
  await expect(page.locator('#exportPanel')).toBeVisible();
  await expect(preview).toHaveClass(/preview-text-compact/);
  await page.keyboard.press('Escape');
  if (isMobile) await page.getByRole('button', { name: 'Preview', exact: true }).click();
  const compactSummary = await summary.evaluate((node) => Number.parseFloat(getComputedStyle(node).fontSize));
  if (isMobile) await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await openExport(page);
  await page.locator('input[name="textSize"][value="large"]').check();
  await expect(page.locator('#exportPanel')).toBeVisible();
  await expect(preview).toHaveClass(/preview-text-large/);
  await expect(preview).not.toHaveClass(/preview-text-standard/);
  await page.keyboard.press('Escape');
  if (isMobile) await page.getByRole('button', { name: 'Preview', exact: true }).click();
  const largeSize = await bullet.evaluate((node) => Number.parseFloat(getComputedStyle(node).fontSize));
  const largeSummary = await summary.evaluate((node) => Number.parseFloat(getComputedStyle(node).fontSize));
  expect(largeSize).toBeGreaterThan(standardSize);
  expect(largeSummary).toBeGreaterThan(compactSummary);
});

test('Copy as plain text shows a local status', async ({ page, context }) => {
  let permissionsGranted = true;
  try {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'http://127.0.0.1:3000' });
  } catch (error) {
    permissionsGranted = false;
  }
  await openStoredCv(page, filledCv);
  await openExport(page);
  await page.getByRole('button', { name: 'Copy as plain text' }).click();
  await expect(page.locator('#saveStatus')).toContainText(
    permissionsGranted ? 'Plain text copied' : /Plain text copied|Clipboard blocked\. Plain text downloaded/
  );
});

test('unsupported characters are named when a PDF is exported', async ({ page }) => {
  await openStoredCv(page, {
    schemaVersion: 1,
    basics: {
      name: 'Łukasz Đặng',
      title: '',
      location: '',
      email: 'lukasz@example.com',
      phone: '',
      website: ''
    },
    exportName: 'Lukasz CV',
    summary: '',
    experience: [{ role: 'Designer', company: 'Studio', dates: '2021 - 2024', highlights: '' }],
    education: [{ degree: '', school: '', dates: '' }],
    skills: ''
  });
  const download = await exportPdfFromUi(page);
  const downloadPath = await download.path();
  expect(downloadPath).not.toBeNull();
  expect((await fs.readFile(downloadPath)).subarray(0, 4).toString('ascii')).toBe('%PDF');
  const status = await page.locator('#saveStatus').textContent();
  expect(status).toContain('PDF exported');
  expect(status).toContain('Ł');
  expect(status).toContain('Đ');
  expect(status).toContain('ặ');
});

test('ATS tips on a fresh CV include the missing email', async ({ page }) => {
  await openApp(page);
  await enterEditor(page);
  await openExport(page);
  const tips = page.locator('#atsTips');
  await expect(tips).toBeVisible();
  await expect(tips.locator('#atsTipsSummary')).toHaveText('ATS tips');
  await expect(tips.locator('#atsTipsList')).toContainText('Add your email.');
  await expect(tips.locator('#atsTipsCount')).toHaveText('(5)');
  const dimensions = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth
  }));
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.innerWidth);
});

test('ATS tips drop the missing email after the fields are filled and the count updates', async ({ page }) => {
  await openApp(page);
  await enterEditor(page);
  await openExport(page);
  const count = page.locator('#atsTipsCount');
  await expect(count).toHaveText('(5)');
  await expect(page.locator('#atsTipsList')).toContainText('Add your email.');
  if (await page.locator('#mobileExportButton').isVisible()) await page.getByRole('button', { name: 'Edit', exact: true }).click();
  else await page.keyboard.press('Escape');
  await page.getByLabel('Full name').fill('Alex Morgan');
  await page.getByLabel('Email').fill('alex@example.com');
  await page.getByLabel('Phone').fill('(555) 123-4567');
  await openSection(page, 'Summary');
  await page.getByRole('textbox', { name: /^Summary \d/ }).fill('Builds clear tools for operations teams.');
  await openSection(page, 'Skills');
  await page.getByLabel(/^Skills/).fill('Figma, research');
  await openExport(page);
  await expect(page.locator('#atsTipsSummary')).toHaveText('ATS tips: all good');
  await expect(page.locator('#atsTipsList')).not.toContainText('Add your email.');
  await expect(count).toBeHidden();
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

test('Undo restores a removed experience entry and keeps it after reload', async ({ page, isMobile }) => {
  await openApp(page);
  await enterEditor(page);
  await openSection(page, 'Experience');
  await page.getByLabel('Job title').fill('Kept this role');
  await page.getByRole('button', { name: 'Remove experience entry 1' }).click();
  const toast = page.locator('#undoToast');
  await expect(toast).toBeVisible();
  await expect(toast).toContainText('Experience entry removed');
  if (isMobile) {
    await page.evaluate(() => new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    }));
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    const clearance = await page.evaluate(() => {
      const toastBox = document.querySelector('#undoToast').getBoundingClientRect();
      const pager = document.querySelector('[data-editor-section="experience"] .section-pager').getBoundingClientRect();
      const bar = document.querySelector('.mobile-view-nav').getBoundingClientRect();
      return {
        pagerBottom: pager.bottom,
        toastTop: toastBox.top,
        toastBottom: toastBox.bottom,
        barTop: bar.top
      };
    });
    expect(clearance.pagerBottom).toBeLessThanOrEqual(clearance.toastTop + 1);
    expect(clearance.toastBottom).toBeLessThanOrEqual(clearance.barTop + 1);
  }
  await expect(page.getByLabel('Job title')).toHaveValue('');
  const undo = page.getByRole('button', { name: 'Undo' });
  await undo.focus();
  await expect(undo).toBeFocused();
  const box = await undo.boundingBox();
  expectTapSize(box.height);
  await undo.click();
  const title = page.getByLabel('Job title');
  await expect(title).toHaveValue('Kept this role');
  await expect(page.getByRole('button', { name: /^Collapse experience entry 1/ })).toBeFocused();
  await expect.poll(() => page.evaluate(() => {
    const raw = localStorage.getItem('state-cv-data-v1');
    if (!raw) return '';
    const data = JSON.parse(raw);
    const master = data.master && typeof data.master === 'object' ? data.master : data;
    return master.experience && master.experience[0] ? master.experience[0].role : '';
  })).toBe('Kept this role');
  await page.reload();
  await enterEditor(page);
  await openSection(page, 'Experience');
  await expect(page.getByLabel('Job title')).toHaveValue('Kept this role');
});

test('Undo toast disappears when a second removal replaces it and restores that entry', async ({ page }) => {
  await openApp(page);
  await enterEditor(page);
  await openSection(page, 'Experience');
  await page.getByLabel('Job title').fill('Alpha Role');
  await openSection(page, 'Education');
  await page.getByLabel('Degree or credential').fill('Beta Degree');
  await openSection(page, 'Experience');
  await page.getByRole('button', { name: 'Remove experience entry 1' }).click();
  const toast = page.locator('#undoToast');
  await expect(toast).toBeVisible();
  await expect(toast).toContainText('Experience entry removed');
  await openSection(page, 'Education');
  await page.getByRole('button', { name: 'Remove education entry 1' }).click();
  await expect(toast).toBeVisible();
  await expect(toast).toContainText('Education entry removed');
  await expect(toast).not.toContainText('Experience entry removed');
  await expect(page.getByRole('button', { name: 'Undo' })).toHaveCount(1);
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(page.getByLabel('Degree or credential')).toHaveValue('Beta Degree');
  await expect(page.getByRole('button', { name: /^Collapse education entry 1/ })).toBeFocused();
  await openSection(page, 'Experience');
  await expect(page.getByLabel('Job title')).toHaveValue('');
  await expect(toast).toBeHidden();
});

test('Backup reminder shows after many edits and stays hidden after Remind me in 7 days', async ({ page }) => {
  await page.goto('/app/');
  await page.evaluate(() => {
    localStorage.setItem('state-cv-backup-reminder-v1', JSON.stringify({
      lastBackupAt: 0,
      editsSinceBackup: 50,
      snoozeUntil: 0
    }));
  });
  await page.reload();
  const notice = page.locator('#backupReminder');
  await expect(notice).toBeVisible();
  await expect(notice).toContainText('Good time to download a backup?');
  const dimensions = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth
  }));
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.innerWidth);
  for (const name of ['Download backup', 'Not now', 'Remind me in 7 days']) {
    const button = notice.getByRole('button', { name });
    await button.focus();
    await expect(button).toBeFocused();
    const box = await button.boundingBox();
    expectTapSize(box.height);
  }
  await notice.getByRole('button', { name: 'Remind me in 7 days' }).click();
  await expect(notice).toBeHidden();
  const snoozeUntil = await page.evaluate(() => JSON.parse(localStorage.getItem('state-cv-backup-reminder-v1')).snoozeUntil);
  expect(snoozeUntil).toBeGreaterThan(Date.now() + 6 * 24 * 60 * 60 * 1000);
  await page.reload();
  await expect(page.getByRole('button', { name: /Continue/ })).toBeVisible();
  await expect(notice).toBeHidden();
});

async function controllingCacheName(page) {
  return page.evaluate(() => new Promise((resolve) => {
    const worker = navigator.serviceWorker.controller;
    if (!worker || typeof MessageChannel !== 'function') {
      resolve(null);
      return;
    }
    const channel = new MessageChannel();
    const timeout = setTimeout(() => resolve('timeout'), 2000);
    channel.port1.onmessage = (event) => {
      clearTimeout(timeout);
      resolve(event.data);
    };
    try {
      worker.postMessage({ type: 'GET_VERSION' }, [channel.port2]);
    } catch (error) {
      clearTimeout(timeout);
      resolve(String(error));
    }
  }));
}

test('Update now flow reloads onto the new cache name', async ({ page }) => {
  const swSource = await fs.readFile(path.join(__dirname, '../../sw.js'), 'utf8');
  const currentCache = swSource.match(/const CACHE_NAME = '([^']+)';/)?.[1];
  expect(currentCache).toMatch(/^state-cv-cache-v/);
  const previousCache = `${currentCache}-previous`;
  const previousSource = swSource.replace(
    /const CACHE_NAME = '[^']+';/,
    `const CACHE_NAME = '${previousCache}';`
  );
  expect(previousSource).not.toBe(swSource);

  // The update check refetches sw.js outside Playwright's router, so the first
  // install is a different cache name and that refetch is the new version.
  let routedInstall = false;
  await page.context().route(/sw\.js(?:\?.*)?$/, async (route) => {
    if (!routedInstall) {
      routedInstall = true;
      await route.fulfill({
        status: 200,
        contentType: 'application/javascript; charset=utf-8',
        body: previousSource,
        headers: {
          'cache-control': 'no-store',
          'service-worker-allowed': '/'
        }
      });
      return;
    }
    await route.continue();
  });

  await openApp(page);
  await page.evaluate(() => navigator.serviceWorker.ready);
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller)), { timeout: 15000 }).toBe(true);
  await expect.poll(() => controllingCacheName(page), { timeout: 15000 }).toBe(previousCache);

  await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration();
    if (!registration) throw new Error('No service worker registration');
    await registration.update();
  });

  const notice = page.locator('#updateNotice');
  await expect(notice).toBeVisible({ timeout: 15000 });
  await expect(notice).toContainText('A new version of State CV is ready.');
  const updateButton = page.getByRole('button', { name: 'Update now' });
  await expect(updateButton).toBeEnabled();
  await updateButton.click();
  await expect.poll(async () => {
    try {
      return await page.evaluate(() => performance.getEntriesByType('navigation')[0]?.type);
    } catch (error) {
      if (!/destroyed|navigation/i.test(String(error))) throw error;
      return null;
    }
  }, { timeout: 15000 }).toBe('reload');
  await expect(page.getByRole('button', { name: /Continue/ })).toBeVisible();
  await expect.poll(() => controllingCacheName(page), { timeout: 15000 }).toBe(currentCache);
});

test('damaged data blocks normal save', async ({ page }) => {
  const raw = '{"broken":';
  await page.addInitScript((damaged) => localStorage.setItem('state-cv-data-v1', damaged), raw);
  await openApp(page);
  await expect(page.locator('#saveStatus')).toContainText('Not saving: damaged data');
  await enterEditor(page);
  await page.getByLabel('Full name').fill('Should not persist');
  await page.waitForTimeout(800);
  expect(await page.evaluate(() => localStorage.getItem('state-cv-data-v1'))).toBe(raw);
  const status = page.locator('#saveStatus');
  await expect(status).toContainText(/Not saving|Saved data not replaced/);
  await expect(status).not.toContainText('Saved locally');
});

test('About and privacy page loads, links back, and does not overflow', async ({ page }) => {
  await openApp(page);
  await page.evaluate(() => navigator.serviceWorker.ready);
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller)), { timeout: 15000 }).toBe(true);
  const launchDimensions = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth
  }));
  expect(launchDimensions.scrollWidth).toBeLessThanOrEqual(launchDimensions.innerWidth);

  await activateLink(page.getByRole('link', { name: 'About and privacy' }));
  await expect(page).toHaveURL(/\/about\.html$/);
  await expect(page.locator('link[rel="icon"]')).toHaveAttribute('href', /^data:image\/svg\+xml/);
  await expect(page.getByRole('heading', { level: 1, name: 'About and privacy' })).toBeVisible();
  expect(await visibleLevelOneHeadings(page)).toBe(1);
  for (const name of ['What is stored', 'Where it is stored', 'What is never sent', 'How to remove it', 'Backups']) {
    await expect(page.getByRole('heading', { level: 2, name })).toBeVisible();
  }
  for (const key of [
    'state-cv-data-v1',
    'state-cv-snapshots-v1',
    'state-cv-damaged-v1',
    'state-cv-persistence-v1',
    'state-cv-backup-reminder-v1'
  ]) {
    await expect(page.getByText(key, { exact: true })).toBeVisible();
  }
  await expect(page.getByText('Only in this browser on this device.')).toBeVisible();
  const dimensions = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth
  }));
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.innerWidth);

  await page.context().setOffline(true);
  try {
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { level: 1, name: 'About and privacy' })).toBeVisible();
  } finally {
    await page.context().setOffline(false);
  }
  await expect.poll(() => page.evaluate(() => navigator.onLine)).toBe(true);

  await activateLink(page.getByRole('link', { name: 'Back to State CV' }));
  await expect(page).toHaveURL(/\/app\/$/);
  await expect(page.getByRole('button', { name: /Continue/ })).toBeVisible();
  await enterEditor(page);
  await openDataDialog(page);
  await activateLink(page.getByRole('dialog', { name: 'Your data' }).getByRole('link', { name: 'About and privacy' }));
  await expect(page).toHaveURL(/\/about\.html$/);
  await expect(page.getByRole('heading', { level: 1, name: 'About and privacy' })).toBeVisible();
});

test('Backup reminder Download backup starts a JSON download and resets the counter', async ({ page }) => {
  await page.goto('/app/');
  await page.evaluate(() => {
    localStorage.setItem('state-cv-backup-reminder-v1', JSON.stringify({
      lastBackupAt: 0,
      editsSinceBackup: 50,
      snoozeUntil: 0
    }));
  });
  await page.reload();
  const notice = page.locator('#backupReminder');
  await expect(notice).toBeVisible();
  const downloadPromise = page.waitForEvent('download');
  await notice.getByRole('button', { name: 'Download backup' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/\.json$/i);
  await expect.poll(() => page.evaluate(() => {
    const raw = localStorage.getItem('state-cv-backup-reminder-v1');
    return raw ? JSON.parse(raw).editsSinceBackup : null;
  })).toBe(0);
  const lastBackupAt = await page.evaluate(() => JSON.parse(localStorage.getItem('state-cv-backup-reminder-v1')).lastBackupAt);
  expect(lastBackupAt).toBeGreaterThan(Date.now() - 60_000);
  await expect(notice).toBeHidden();
});

test('Backup reminder Not now snoozes for about 30 days and stays hidden after reload', async ({ page }) => {
  await page.goto('/app/');
  await page.evaluate(() => {
    localStorage.setItem('state-cv-backup-reminder-v1', JSON.stringify({
      lastBackupAt: 0,
      editsSinceBackup: 50,
      snoozeUntil: 0
    }));
  });
  await page.reload();
  const notice = page.locator('#backupReminder');
  await expect(notice).toBeVisible();
  await expect(notice).toContainText('Good time to download a backup?');
  await notice.getByRole('button', { name: 'Not now' }).click();
  await expect(notice).toBeHidden();
  const snoozeUntil = await page.evaluate(() => JSON.parse(localStorage.getItem('state-cv-backup-reminder-v1')).snoozeUntil);
  const month = 30 * 24 * 60 * 60 * 1000;
  expect(snoozeUntil).toBeGreaterThan(Date.now() + month - 60_000);
  expect(snoozeUntil).toBeLessThan(Date.now() + month + 60_000);
  await page.reload();
  await expect(page.getByRole('button', { name: /Continue/ })).toBeVisible();
  await expect(notice).toBeHidden();
});

const fixtureJobs = [
  ['Senior Operations Analyst', 'Mar 2021 \u2013 Present', 3],
  ['Operations Analyst', 'Jun 2018 \u2013 Feb 2021', 3],
  ['Logistics Coordinator', 'Aug 2016 \u2013 May 2018', 2]
];

const commaSkills = [
  'SQL',
  'Excel (pivot tables)',
  'Tableau',
  'Python (pandas)',
  'Process improvement',
  'Forecasting',
  'Vendor negotiation',
  'Stakeholder reporting'
];

const cityCompanies = [
  'Harbor Logistics Group, Austin, TX',
  'Brightline Retail, Dallas, TX',
  'Lone Star Freight, Houston, TX'
];

const importFixtures = [
  {
    file: 'cv1-classic-single-column.pdf',
    title: 'Import fixture cv1 classic single column',
    companies: cityCompanies,
    skills: commaSkills
  },
  {
    file: 'cv2-two-column-sidebar.pdf',
    title: 'Import fixture cv2 two column sidebar',
    companies: ['Harbor Logistics Group', 'Brightline Retail', 'Lone Star Freight'],
    skills: commaSkills
  },
  {
    file: 'cv3-word-style-tables.pdf',
    title: 'Import fixture cv3 word style tables',
    companies: cityCompanies,
    skills: [
      'SQL',
      'Process improvement',
      'Excel',
      'Forecasting',
      'Tableau',
      'Vendor negotiation',
      'Python (pandas)',
      'Stakeholder reporting'
    ]
  },
  {
    file: 'cv4-google-docs-style.pdf',
    title: 'Import fixture cv4 google docs style',
    companies: cityCompanies,
    skills: commaSkills
  }
];

async function importPdfFixture(page, filename) {
  await page.locator('#pdfInput').setInputFiles(path.join(__dirname, '../fixtures', filename));
  await expect(page.getByLabel('Full name')).toHaveValue('Jordan Ellis');
}

async function expectImportedFixture(page, { companies, skills }) {
  await expect(page.getByLabel('Email')).toHaveValue('jordan.ellis@example.com');
  await expect(page.getByLabel('Phone')).toHaveValue('(512) 555-0147');
  await expect(page.getByLabel('Location')).toHaveValue('Austin, TX');

  await openSection(page, 'Experience');
  const experience = page.locator('#experienceList article');
  await expect(experience).toHaveCount(3);
  for (let index = 0; index < fixtureJobs.length; index += 1) {
    const entry = experience.nth(index);
    const expand = entry.getByRole('button', { name: /^Expand / });
    if (await expand.count()) await expand.click();
    await expect(entry.getByLabel('Job title')).toHaveValue(fixtureJobs[index][0]);
    await expect(entry.getByLabel('Company')).toHaveValue(companies[index]);
    await expect(entry.getByLabel('Dates')).toHaveValue(fixtureJobs[index][1]);
    const highlights = await entry.getByLabel(/^Highlights/).inputValue();
    expect(highlights.split(/\n/).filter((line) => line.trim())).toHaveLength(fixtureJobs[index][2]);
  }

  await openSection(page, 'Education');
  const education = page.locator('#educationList article');
  await expect(education).toHaveCount(1);
  await expect(education.getByLabel('Degree or credential')).toHaveValue('B.S., Supply Chain Management');
  await expect(education.getByLabel('School')).toHaveValue('University of Texas at Austin');
  await expect(education.getByLabel('Dates')).toHaveValue('2012 \u2013 2016');

  await openSection(page, 'Skills');
  const importedSkills = (await page.getByLabel(/^Skills/).inputValue()).split(',').map((skill) => skill.trim()).filter(Boolean);
  expect(importedSkills).toEqual(skills);
  expect(importedSkills).toHaveLength(8);
}

for (const fixture of importFixtures) {
  test(fixture.title, async ({ page }) => {
    await openApp(page);
    await importPdfFixture(page, fixture.file);
    await expectImportedFixture(page, fixture);
  });
}

test('Import fixture replaces old values', async ({ page }) => {
  await openApp(page);
  await enterEditor(page);
  await page.getByLabel('Professional title').fill('5151');
  await page.getByLabel('Location').fill('566');
  await expect(page.getByLabel('Professional title')).toHaveValue('5151');
  await expect(page.getByLabel('Location')).toHaveValue('566');
  page.once('dialog', (dialog) => dialog.accept());
  await importPdfFixture(page, 'cv1-classic-single-column.pdf');
  await expect(page.getByLabel('Professional title')).toHaveValue('');
  await expect(page.getByLabel('Location')).toHaveValue('Austin, TX');
});

test('Import confirm cancel keeps current CV', async ({ page }) => {
  await openApp(page);
  await enterEditor(page);
  await page.getByLabel('Full name').fill('Keep Me');
  await expect.poll(() => savedName(page)).toBe('Keep Me');
  page.once('dialog', (dialog) => dialog.dismiss());
  await page.locator('#pdfInput').setInputFiles(path.join(__dirname, '../fixtures', 'cv1-classic-single-column.pdf'));
  await expect(page.locator('#saveStatus')).toContainText('Import cancelled');
  await expect(page.getByLabel('Full name')).toHaveValue('Keep Me');
});

test('Import confirm accept replaces CV', async ({ page }) => {
  await openApp(page);
  await enterEditor(page);
  await page.getByLabel('Full name').fill('Keep Me');
  await expect.poll(() => savedName(page)).toBe('Keep Me');
  page.once('dialog', (dialog) => dialog.accept());
  await page.locator('#pdfInput').setInputFiles(path.join(__dirname, '../fixtures', 'cv1-classic-single-column.pdf'));
  await expect(page.getByLabel('Full name')).toHaveValue('Jordan Ellis');
});

test('Import confirm not shown without a draft', async ({ page }) => {
  await openApp(page);
  let sawDialog = false;
  page.on('dialog', (dialog) => {
    sawDialog = true;
    dialog.dismiss();
  });
  await page.locator('#pdfInput').setInputFiles(path.join(__dirname, '../fixtures', 'cv1-classic-single-column.pdf'));
  await expect(page.getByLabel('Full name')).toHaveValue('Jordan Ellis');
  expect(sawDialog).toBe(false);
});

const savedCvMessage = 'Importing will replace your current CV. A copy is kept in Your data > Recent snapshots. Continue?';
const unreadableCvMessage = 'Importing will replace the saved CV data on this device. It could not be read, so no snapshot copy is available. Continue?';

async function expectBlankSavedCv(page) {
  await expect.poll(() => page.evaluate(() => {
    const raw = localStorage.getItem('state-cv-data-v1');
    if (!raw) return 'missing';
    try {
      const stored = JSON.parse(raw);
      const data = stored.master && typeof stored.master === 'object' ? stored.master : stored;
      const basics = data.basics || {};
      const texts = [basics.name, basics.title, basics.location, basics.email, basics.phone, basics.website, data.summary, data.skills, data.exportName];
      const lists = [...(data.experience || []), ...(data.education || [])];
      const filled = texts.some((value) => String(value || '').trim()) || lists.some((record) =>
        Object.entries(record || {}).some(([key, value]) => key !== 'id' && String(value || '').trim()));
      return filled ? 'filled' : 'blank';
    } catch (error) {
      return 'unreadable';
    }
  })).toBe('blank');
}

async function importWithoutDialog(page, action) {
  const dialogs = [];
  const onDialog = (dialog) => {
    dialogs.push(dialog.message());
    dialog.dismiss();
  };
  page.on('dialog', onDialog);
  let actionError = null;
  try {
    await action();
  } catch (error) {
    actionError = error;
  } finally {
    page.off('dialog', onDialog);
  }
  expect(dialogs).toEqual([]);
  if (actionError) throw actionError;
}

test('Import confirm is skipped when the saved CV is blank', async ({ page }) => {
  await openApp(page);
  await page.getByRole('button', { name: /Start a new CV/ }).click();
  await expect(page.getByLabel('Full name')).toBeVisible();
  await expectBlankSavedCv(page);
  await importWithoutDialog(page, async () => {
    await page.locator('#importInput').setInputFiles({
      name: 'blank-replace.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(validBackup))
    });
    await expect(page.getByLabel('Full name')).toHaveValue('Recovered CV');
  });

  await page.locator('.more-menu > summary').click();
  let startNewMessage = '';
  page.once('dialog', (dialog) => {
    startNewMessage = dialog.message();
    dialog.accept();
  });
  await page.getByRole('button', { name: 'Start new CV', exact: true }).click();
  expect(startNewMessage).toBe('Starting a new CV will replace the current CV. Continue?');
  await expect(page.getByLabel('Full name')).toHaveValue('');
  await expectBlankSavedCv(page);
  await importWithoutDialog(page, async () => {
    await page.locator('#pdfInput').setInputFiles(path.join(__dirname, '../fixtures', 'cv1-classic-single-column.pdf'));
    await expect(page.getByLabel('Full name')).toHaveValue('Jordan Ellis');
  });
});

test('Import confirm for unreadable saved data does not mention a snapshot', async ({ page }) => {
  const raw = '{"broken":';
  await page.addInitScript((damaged) => localStorage.setItem('state-cv-data-v1', damaged), raw);
  await openApp(page);
  await expect(page.locator('#storageNotice')).toContainText('Saved data could not be validated');
  let message = '';
  page.once('dialog', (dialog) => {
    message = dialog.message();
    dialog.accept();
  });
  await page.locator('#importInput').setInputFiles({
    name: 'recovery.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(validBackup))
  });
  await expect(page.getByLabel('Full name')).toHaveValue('Recovered CV');
  expect(message).toBe(unreadableCvMessage);
});

test('Import confirm for a saved CV keeps the snapshot wording', async ({ page }) => {
  await openApp(page);
  await enterEditor(page);
  await page.getByLabel('Full name').fill('Keep Me');
  await expect.poll(() => savedName(page)).toBe('Keep Me');
  let pdfMessage = '';
  page.once('dialog', (dialog) => {
    pdfMessage = dialog.message();
    dialog.dismiss();
  });
  await page.locator('#pdfInput').setInputFiles(path.join(__dirname, '../fixtures', 'cv1-classic-single-column.pdf'));
  await expect(page.locator('#saveStatus')).toContainText('Import cancelled');
  expect(pdfMessage).toBe(savedCvMessage);
  await expect(page.getByLabel('Full name')).toHaveValue('Keep Me');
  let jsonMessage = '';
  page.once('dialog', (dialog) => {
    jsonMessage = dialog.message();
    dialog.dismiss();
  });
  await page.locator('#importInput').setInputFiles({
    name: 'keep.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(validBackup))
  });
  await expect.poll(() => jsonMessage).toBe(savedCvMessage);
  await expect(page.getByLabel('Full name')).toHaveValue('Keep Me');
});

const allowedOutsideLinks = [
  'https://nativestatetools.com/',
  'https://github.com/native-state-tools/state-cv',
  'https://ko-fi.com/nativestatetools'
];

test('Landing page shows the promises and opens the app', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
  await expect(page.getByRole('heading', { level: 1, name: 'Build your CV. Keep it yours.' })).toBeVisible();
  await expect(page).toHaveTitle('State CV | Local-first CV builder');
  await expect(page.locator('.landing-lead')).toContainText('State CV is a local-first CV builder. Create, tailor and export your CV without an account. All features available today remain free; future optional additions may be paid.');
  await expect(page.locator('.landing-lead')).toContainText('That is not a guarantee that every system will parse it the same way.');
  await expect(page.locator('.eyebrow')).toContainText('Current features stay free');
  for (const name of ['Stays on your device', 'Current features stay free', 'ATS-friendly']) {
    await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
  }
  for (const name of ['Where is my data?', 'How do I back up?', 'Do current features stay free?', 'Does it work offline?']) {
    await expect(page.locator('summary').filter({ hasText: name })).toBeVisible();
  }
  await expect(page.locator('.landing-faq')).toContainText('All features available today remain free, with no account. Future optional additions may be paid.');
  await expect(page.locator('.landing-faq')).toContainText('After the first visit, yes, in supported browsers.');
  await expect(page.locator('.landing-card').filter({ hasText: 'Stays on your device' })).toContainText('No account, and your CV is not uploaded.');
  const dimensions = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth
  }));
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.innerWidth);
  await page.getByRole('link', { name: 'Open State CV' }).click();
  await expect(page).toHaveURL(/\/app\/$/);
  await expect(page.getByRole('button', { name: /Continue/ })).toBeVisible();
});

test('Landing page has no scripts and only the allowed outside links', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('script')).toHaveCount(0);
  const httpsLinks = await page.evaluate(() => [...document.querySelectorAll('[href]')]
    .map((element) => element.getAttribute('href'))
    .filter((href) => /^https?:\/\//i.test(href || '')));
  expect(httpsLinks.length).toBeGreaterThan(0);
  for (const href of httpsLinks) expect(allowedOutsideLinks).toContain(href);
});

async function expectSupportLinks(page) {
  const links = page.locator('a[href="https://ko-fi.com/nativestatetools"]');
  expect(await links.count()).toBeGreaterThan(0);
  const count = await links.count();
  for (let index = 0; index < count; index += 1) {
    const link = links.nth(index);
    await expect(link).toHaveText('Support State CV');
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(link).toHaveAttribute('rel', /noopener/);
  }
}

test('Support State CV and contact email are plain links, with no Ko-fi request on load', async ({ page }) => {
  const kofiRequests = [];
  page.on('request', (request) => {
    if (request.url().includes('ko-fi.com')) kofiRequests.push(request.url());
  });

  await page.goto('/');
  await expectSupportLinks(page);
  await expect(page.locator('a[href="mailto:hello@nativestatetools.com"]')).toHaveCount(1);

  await page.goto('/about.html');
  await expectSupportLinks(page);
  await expect(page.locator('a[href="mailto:hello@nativestatetools.com"]')).toHaveCount(1);
  await expect(page.getByText('All features available today remain free, with no account. Future optional additions may be paid. If State CV helped you, you can chip in on Ko-fi. That support is voluntary. It is not a purchase, and it is not required to use the features available today.')).toBeVisible();
  await expect(page.getByText("The Support link opens Ko-fi's website in a new tab. State CV itself sends nothing to Ko-fi, and your CV never leaves your device.")).toBeVisible();

  await page.goto('/app/');
  await expect(page.getByRole('button', { name: /Continue/ })).toBeVisible();
  await expectSupportLinks(page);

  expect(kofiRequests).toEqual([]);
});

test('Landing page and app both load offline from the service worker', async ({ page }) => {
  await page.goto('/app/');
  await page.evaluate(() => navigator.serviceWorker.ready);
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller)), { timeout: 15000 }).toBe(true);
  await page.context().setOffline(true);
  try {
    await page.reload();
    await expect(page.getByRole('button', { name: /Continue/ })).toBeVisible();
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1, name: 'Build your CV. Keep it yours.' })).toBeVisible();
  } finally {
    await page.context().setOffline(false);
  }
  await expect.poll(() => page.evaluate(() => navigator.onLine)).toBe(true);
});

test('Landing: /app without a slash redirects to /app/', async ({ page }) => {
  await page.goto('/app/');
  await page.evaluate(() => navigator.serviceWorker.ready);
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller)), { timeout: 15000 }).toBe(true);
  await page.context().setOffline(true);
  try {
    await page.goto('/app');
    await expect(page).toHaveURL(/\/app\/$/);
    await expect(page.getByRole('button', { name: /Continue/ })).toBeVisible();
    await page.goto('/app?x=1');
    await expect(page).toHaveURL(/\/app\/\?x=1$/);
    await expect(page.getByRole('button', { name: /Continue/ })).toBeVisible();
  } finally {
    await page.context().setOffline(false);
  }
  await expect.poll(() => page.evaluate(() => navigator.onLine)).toBe(true);
});

test('Landing: a deeper URL does not fall back to a cached page', async ({ page }) => {
  await page.goto('/app/');
  await page.evaluate(() => navigator.serviceWorker.ready);
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller)), { timeout: 15000 }).toBe(true);
  await page.context().setOffline(true);
  try {
    for (const deeperPath of ['/nope/deeper', '/app/nope']) {
      let navigationError = null;
      try {
        await page.goto(deeperPath);
      } catch (error) {
        navigationError = error;
      }
      expect(navigationError, deeperPath).toBeTruthy();
      expect(String(navigationError), deeperPath).toMatch(/ERR_INTERNET_DISCONNECTED|ERR_FAILED|net::/i);
      const showsLanding = await page.getByRole('heading', { name: 'Build your CV. Keep it yours.' }).count().catch(() => 0);
      const showsApp = await page.getByRole('button', { name: /Continue/ }).count().catch(() => 0);
      expect(showsLanding, deeperPath).toBe(0);
      expect(showsApp, deeperPath).toBe(0);
    }
  } finally {
    await page.context().setOffline(false);
  }
  await page.goto('/app/');
  await expect.poll(() => page.evaluate(() => navigator.onLine)).toBe(true);
});

test('Landing page opens from file://', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-1440', 'Direct-file support is checked on the desktop project only.');
  const indexPath = path.resolve(__dirname, '../../index.html');
  await page.goto(pathToFileURL(indexPath).href);
  await expect(page.getByRole('heading', { level: 1, name: 'Build your CV. Keep it yours.' })).toBeVisible();
});

async function openVersions(page) {
  const edit = page.getByRole('button', { name: 'Edit', exact: true });
  if (await edit.isVisible() && await edit.getAttribute('aria-pressed') !== 'true') await edit.click();
  const sheet = page.locator('#versionSheet');
  if (!(await sheet.isVisible())) await page.locator('#versionPill').click();
  await expect(sheet).toBeVisible();
  await expect(page.getByRole('radio', { name: 'Master CV', exact: true })).toBeVisible();
}

async function chooseVersion(page, name) {
  await openVersions(page);
  const radio = page.getByRole('radio', { name, exact: true });
  await radio.click();
  await expect(radio).toBeChecked();
  await page.keyboard.press('Escape');
  await expect(page.locator('#versionSheet')).toBeHidden();
}

async function openTailor(page) {
  const done = page.locator('#tailorDoneButton');
  if (await done.isVisible()) return;
  const fromSheet = page.locator('#tailorFromSheetButton');
  if (await fromSheet.isVisible()) await fromSheet.click();
  else await page.locator('#versionBannerTailor').click();
  await expect(done).toBeVisible();
}

async function expectVersionPreview(page, { present, absent } = {}) {
  const previewButton = page.locator('[data-mobile-view-button="preview"]');
  if (await previewButton.isVisible()) await previewButton.click();
  const preview = page.locator('#resumePreview');
  await expect(preview).toBeVisible();
  if (present) await expect(preview).toContainText(present);
  if (absent) await expect(preview).not.toContainText(absent);
}

test('versions hide one experience entry in preview and plain text, then survive reload, rename, duplicate, and delete with undo', async ({ page }) => {
  test.setTimeout(60000);
  await openApp(page);
  await enterEditor(page);
  await page.getByLabel('Full name').fill('Alex Morgan');
  await openSection(page, 'Experience');
  await page.getByLabel('Job title').fill('Visible Role');
  await page.getByLabel('Company').fill('Visible Co');
  await page.getByRole('button', { name: 'Add experience' }).click();
  await page.getByLabel('Job title').nth(1).fill('Hidden Role');
  await page.getByLabel('Company').nth(1).fill('Hidden Co');
  await expect(page.locator('#saveStatus')).toContainText('Saved locally');

  await openVersions(page);
  await expect(page.getByRole('button', { name: 'Rename', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Duplicate', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Delete', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'New version', exact: true }).click();
  await expect(page.getByRole('radio', { name: 'Untitled version', exact: true })).toBeChecked();
  await expect(page.locator('#versionBanner')).toContainText('Viewing Untitled version');
  await expect(page.locator('#versionBanner')).toContainText('Edits change your master CV');
  await expect(page.locator('#exportFilename')).toHaveValue('Alex Morgan CV - Untitled version');
  await expect(page.getByRole('radio', { name: 'Untitled version', exact: true })).toBeFocused();

  await openTailor(page);
  const hiddenBox = page.getByRole('checkbox', { name: 'Hidden Role, Hidden Co' });
  await expect(hiddenBox).toBeChecked();
  await expect(page.getByRole('checkbox', { name: 'Visible Role, Visible Co' })).toBeChecked();
  await hiddenBox.uncheck();
  await expect.poll(() => page.evaluate(() => {
    const data = JSON.parse(localStorage.getItem('state-cv-data-v1') || '{}');
    const version = data.versions && data.versions[0];
    const hiddenId = data.master && data.master.experience && data.master.experience[1] && data.master.experience[1].id;
    return Boolean(version && hiddenId && version.hiddenEntries.includes(hiddenId) && data.master.experience[1].role === 'Hidden Role');
  })).toBe(true);

  await expectVersionPreview(page, { present: 'Visible Role', absent: 'Hidden Role' });

  await openExport(page);
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download .txt' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('Alex Morgan CV - Untitled version.txt');
  const content = await fs.readFile(await download.path(), 'utf8');
  expect(content).toContain('Visible Role');
  expect(content).not.toContain('Hidden Role');

  await chooseVersion(page, 'Master CV');
  await expectVersionPreview(page, { present: 'Hidden Role' });

  await page.reload();
  await enterEditor(page);
  await chooseVersion(page, 'Untitled version');
  await openTailor(page);
  await expect(page.getByRole('checkbox', { name: 'Hidden Role, Hidden Co' })).not.toBeChecked();
  await expectVersionPreview(page, { present: 'Visible Role', absent: 'Hidden Role' });

  await openVersions(page);
  await page.getByRole('button', { name: 'Rename', exact: true }).click();
  await page.getByLabel('Version name').fill('Acme role');
  await page.getByRole('button', { name: 'Save name', exact: true }).click();
  await expect(page.getByRole('radio', { name: 'Acme role', exact: true })).toBeChecked();
  await page.getByRole('button', { name: 'Duplicate', exact: true }).click();
  await expect(page.getByRole('radio', { name: 'Acme role copy', exact: true })).toBeChecked();
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page.locator('#undoToast')).toContainText('Version removed');
  await expect(page.getByRole('radio', { name: 'Master CV', exact: true })).toBeChecked();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.getByRole('radio', { name: 'Acme role copy', exact: true })).toBeChecked();
  await expect(page.getByRole('radio', { name: 'Acme role copy', exact: true })).toBeFocused();
  await expect.poll(() => page.evaluate(() => {
    const data = JSON.parse(localStorage.getItem('state-cv-data-v1') || '{}');
    return (data.versions || []).map((version) => version.name).join('|');
  })).toBe('Acme role|Acme role copy');
  const roles = await page.evaluate(() => {
    const data = JSON.parse(localStorage.getItem('state-cv-data-v1') || '{}');
    return data.master.experience.map((item) => item.role);
  });
  expect(roles).toEqual(['Visible Role', 'Hidden Role']);
});

test('versions hide one bullet and one skill, override title and summary, and keep a filename per version', async ({ page }) => {
  test.setTimeout(60000);
  await openApp(page);
  await enterEditor(page);
  await page.getByLabel('Full name').fill('Alex Morgan');
  await page.getByLabel('Professional title').fill('Master Title');
  await openSection(page, 'Summary');
  await page.getByRole('textbox', { name: /^Summary \d/ }).fill('Master summary text');
  await openSection(page, 'Experience');
  await page.getByLabel('Job title').fill('Visible Role');
  await page.getByLabel('Company').fill('Visible Co');
  await page.getByLabel(/^Highlights/).fill('VisibleBulletLine\nHiddenBulletLine');
  await openSection(page, 'Skills');
  await page.getByLabel(/^Skills/).fill('KeptSkill, ZebraSkill');
  await expect(page.locator('#saveStatus')).toContainText('Saved locally');

  await openVersions(page);
  await page.getByRole('button', { name: 'New version', exact: true }).click();
  await expect(page.locator('#exportFilename')).toHaveValue('Alex Morgan CV - Untitled version');
  await openTailor(page);
  const block = page.locator('.version-entry-block', { has: page.getByRole('checkbox', { name: 'Visible Role, Visible Co' }) });
  await block.locator('summary').click();
  await block.getByRole('checkbox', { name: 'HiddenBulletLine', exact: true }).uncheck();
  await page.locator('#versionSkills summary').click();
  await page.getByRole('checkbox', { name: 'ZebraSkill', exact: true }).uncheck();
  await page.locator('#versionCopy summary').click();
  await page.getByLabel('Title for this version').fill('Version Title');
  await page.getByLabel('Summary for this version').fill('Version summary text');
  await expect(page.locator('#versionSummaryCount')).toHaveText('20 / 500');

  await expectVersionPreview(page, { present: 'Version Title', absent: 'HiddenBulletLine' });
  const preview = page.locator('#resumePreview');
  await expect(preview).toContainText('Version summary text');
  await expect(preview).toContainText('VisibleBulletLine');
  await expect(preview).toContainText('KeptSkill');
  await expect(preview).not.toContainText('ZebraSkill');
  await expect(preview).not.toContainText('Master Title');
  await expect(preview).not.toContainText('Master summary text');

  await openExport(page);
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download .txt' }).click();
  const download = await downloadPromise;
  const content = await fs.readFile(await download.path(), 'utf8');
  expect(content).toContain('Version Title');
  expect(content).toContain('Version summary text');
  expect(content).toContain('VisibleBulletLine');
  expect(content).not.toContain('HiddenBulletLine');
  expect(content).not.toContain('ZebraSkill');
  expect(content).toContain('KeptSkill');

  await openExport(page);
  await page.locator('#exportFilename').fill('Acme file');
  await expect.poll(() => page.evaluate(() => {
    const data = JSON.parse(localStorage.getItem('state-cv-data-v1') || '{}');
    const version = data.versions && data.versions[0];
    return version && version.exportName === 'Acme file' && data.master.exportName === '';
  })).toBe(true);
  await chooseVersion(page, 'Master CV');
  await expect(page.locator('#exportFilename')).toHaveValue('Alex Morgan CV');
  await expectVersionPreview(page, { present: 'HiddenBulletLine' });
  await expect(page.locator('#resumePreview')).toContainText('Master Title');
  await expect(page.locator('#resumePreview')).toContainText('ZebraSkill');
  await expect(page.locator('#resumePreview')).toContainText('Master summary text');
  await expect(page.locator('#resumePreview')).not.toContainText('Version Title');

  await chooseVersion(page, 'Untitled version');
  await expect(page.locator('#exportFilename')).toHaveValue('Acme file');
  await openTailor(page);
  await page.locator('#versionCopy summary').click();
  await expect(page.getByLabel('Title for this version')).toHaveValue('Version Title');

  await page.reload();
  await enterEditor(page);
  await chooseVersion(page, 'Untitled version');
  await expect(page.locator('#exportFilename')).toHaveValue('Acme file');
  await openTailor(page);
  await page.locator('#versionCopy summary').click();
  await expect(page.getByLabel('Title for this version')).toHaveValue('Version Title');
  await expect(page.getByLabel('Summary for this version')).toHaveValue('Version summary text');
  const blockAgain = page.locator('.version-entry-block', { has: page.getByRole('checkbox', { name: 'Visible Role, Visible Co' }) });
  await blockAgain.locator('summary').click();
  await expect(blockAgain.getByRole('checkbox', { name: 'HiddenBulletLine', exact: true })).not.toBeChecked();
  await page.locator('#versionSkills summary').click();
  await expect(page.getByRole('checkbox', { name: 'ZebraSkill', exact: true })).not.toBeChecked();
  await expectVersionPreview(page, { present: 'Version Title', absent: 'ZebraSkill' });
});

test('versions keep a deleted entry and its hidden bullet until undo', async ({ page }) => {
  test.setTimeout(60000);
  await openApp(page);
  await enterEditor(page);
  await openSection(page, 'Experience');
  await page.getByLabel('Job title').fill('Kept Role');
  await page.getByLabel('Company').fill('Kept Co');
  await page.getByLabel(/^Highlights/).fill('KeptBullet\nSecretBullet');
  await page.getByRole('button', { name: 'Add experience' }).click();
  await page.getByLabel('Job title').nth(1).fill('Hidden Role');
  await page.getByLabel('Company').nth(1).fill('Hidden Co');
  await expect(page.locator('#saveStatus')).toContainText('Saved locally');

  await openVersions(page);
  await page.getByRole('button', { name: 'New version', exact: true }).click();
  await openTailor(page);
  await page.getByRole('checkbox', { name: 'Hidden Role, Hidden Co' }).uncheck();
  const kept = page.locator('.version-entry-block', { has: page.getByRole('checkbox', { name: 'Kept Role, Kept Co' }) });
  await kept.locator('summary').click();
  await kept.getByRole('checkbox', { name: 'SecretBullet', exact: true }).uncheck();
  await page.locator('#tailorDoneButton').click();

  await openSection(page, 'Experience');
  await page.getByRole('button', { name: 'Remove experience entry 2' }).click();
  await expect.poll(() => page.evaluate(() => {
    const data = JSON.parse(localStorage.getItem('state-cv-data-v1') || '{}');
    const version = data.versions && data.versions[0];
    const ids = (data.master.experience || []).map((item) => item.id);
    return Boolean(version && version.hiddenEntries.some((id) => !ids.includes(id)) && ids.length === 1);
  })).toBe(true);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await openTailor(page);
  await expect(page.getByRole('checkbox', { name: 'Hidden Role, Hidden Co' })).not.toBeChecked();
  await page.locator('#tailorDoneButton').click();

  await openSection(page, 'Experience');
  await page.getByRole('button', { name: 'Remove experience entry 1' }).click();
  await expect.poll(() => page.evaluate(() => {
    const data = JSON.parse(localStorage.getItem('state-cv-data-v1') || '{}');
    const version = data.versions && data.versions[0];
    const ids = (data.master.experience || []).map((item) => item.id);
    const hidden = version && version.hiddenBullets;
    const keptId = Object.keys(hidden || {}).find((id) => !ids.includes(id));
    return Boolean(keptId && hidden[keptId].includes('SecretBullet'));
  })).toBe(true);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await openTailor(page);
  const keptAgain = page.locator('.version-entry-block', { has: page.getByRole('checkbox', { name: 'Kept Role, Kept Co' }) });
  await keptAgain.locator('summary').click();
  await expect(keptAgain.getByRole('checkbox', { name: 'SecretBullet', exact: true })).not.toBeChecked();
});

test('versions are named when PDF import replaces the CV', async ({ page }) => {
  await openApp(page);
  await enterEditor(page);
  await page.getByLabel('Full name').fill('Alex Morgan');
  await expect.poll(() => savedName(page)).toBe('Alex Morgan');
  await openVersions(page);
  await page.getByRole('button', { name: 'New version', exact: true }).click();
  await expect.poll(() => page.evaluate(() => {
    const data = JSON.parse(localStorage.getItem('state-cv-data-v1') || '{}');
    return Array.isArray(data.versions) && data.versions.length === 1;
  })).toBe(true);
  let message = '';
  page.once('dialog', (dialog) => {
    message = dialog.message();
    dialog.dismiss();
  });
  await page.locator('#pdfInput').setInputFiles(path.join(__dirname, '../fixtures', 'cv1-classic-single-column.pdf'));
  await expect.poll(() => message).toBe('Importing will replace your current CV. Your 1 version will be removed. A copy is kept in Your data > Recent snapshots. Continue?');
  await expect(page.getByLabel('Full name')).toHaveValue('Alex Morgan');
});

function savedVersionRecord(name) {
  return {
    schemaVersion: 2,
    master: {
      basics: { name, title: name ? 'Keeper' : '', location: '', email: '', phone: '', website: '' },
      exportName: '',
      summary: name ? 'Keep this summary.' : '',
      experience: [{ id: 'exp_keep', role: name ? 'Keep Role' : '', company: name ? 'Keep Co' : '', dates: name ? '2019 - 2023' : '', highlights: name ? 'Kept the lights on' : '' }],
      education: [{ id: 'edu_keep', degree: name ? 'B.S.' : '', school: name ? 'Keep University' : '', dates: name ? '2011 - 2015' : '' }],
      skills: name ? 'Keeping' : ''
    },
    versions: [{
      id: 'ver_keep',
      name: 'Keep version',
      hiddenEntries: name ? ['exp_keep'] : [],
      hiddenBullets: {},
      hiddenSkills: [],
      title: name ? 'Keep title' : '',
      summary: '',
      exportName: ''
    }]
  };
}

const jsonVersionBackup = {
  schemaVersion: 2,
  master: {
    basics: { name: 'Backup Person', title: 'Analyst', location: '', email: '', phone: '', website: '' },
    exportName: '',
    summary: 'Backup summary.',
    experience: [{ id: 'exp_backup', role: 'Backup Role', company: 'Backup Co', dates: '2020 - 2024', highlights: 'Shipped the work' }],
    education: [{ id: 'edu_backup', degree: 'B.A.', school: 'Example University', dates: '2012 - 2016' }],
    skills: 'Writing'
  },
  versions: [{
    id: 'ver_backup',
    name: 'Backend role',
    hiddenEntries: ['exp_backup'],
    hiddenBullets: {},
    hiddenSkills: [],
    title: 'Tailored title',
    summary: '',
    exportName: 'Backend file'
  }]
};

test('JSON import confirm replaces the master and versions, and cancel keeps the current CV', async ({ page }) => {
  await page.addInitScript((stored) => localStorage.setItem('state-cv-data-v1', stored), JSON.stringify(savedVersionRecord('Keep Me')));
  await openApp(page);
  await enterEditor(page);
  await expect(page.getByLabel('Full name')).toHaveValue('Keep Me');
  const jsonMessage = 'Importing this backup replaces your current master CV and versions with the backup\'s master CV and its 1 version. A copy is kept in Your data > Recent snapshots. Continue?';
  let cancelMessage = '';
  page.once('dialog', (dialog) => {
    cancelMessage = dialog.message();
    dialog.dismiss();
  });
  await page.locator('#importInput').setInputFiles({
    name: 'versions.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(jsonVersionBackup))
  });
  await expect.poll(() => cancelMessage).toBe(jsonMessage);
  expect(cancelMessage).not.toContain('will be removed');
  await expect(page.locator('#saveStatus')).toContainText('Import cancelled');
  await expect(page.getByLabel('Full name')).toHaveValue('Keep Me');
  await expect.poll(() => page.evaluate(() => {
    const data = JSON.parse(localStorage.getItem('state-cv-data-v1'));
    return {
      name: data.master.basics.name,
      role: data.master.experience[0].role,
      version: data.versions[0] && data.versions[0].name,
      hidden: data.versions[0] && data.versions[0].hiddenEntries[0]
    };
  })).toEqual({ name: 'Keep Me', role: 'Keep Role', version: 'Keep version', hidden: 'exp_keep' });

  let acceptMessage = '';
  page.once('dialog', (dialog) => {
    acceptMessage = dialog.message();
    dialog.accept();
  });
  await page.locator('#importInput').setInputFiles({
    name: 'versions.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(jsonVersionBackup))
  });
  await expect(page.getByLabel('Full name')).toHaveValue('Backup Person');
  expect(acceptMessage).toBe(jsonMessage);
  await openSection(page, 'Experience');
  await expect(page.getByLabel('Job title')).toHaveValue('Backup Role');
  await expect.poll(() => page.evaluate(() => {
    const data = JSON.parse(localStorage.getItem('state-cv-data-v1'));
    const version = data.versions[0];
    return {
      count: data.versions.length,
      name: version && version.name,
      hidden: version && version.hiddenEntries.join(','),
      title: version && version.title,
      exportName: version && version.exportName,
      role: data.master.experience[0].role
    };
  })).toEqual({
    count: 1,
    name: 'Backend role',
    hidden: 'exp_backup',
    title: 'Tailored title',
    exportName: 'Backend file',
    role: 'Backup Role'
  });
});

test('an older JSON backup with no versions says so, and accepting it clears current versions', async ({ page }) => {
  await page.addInitScript((stored) => localStorage.setItem('state-cv-data-v1', stored), JSON.stringify(savedVersionRecord('Keep Me')));
  await openApp(page);
  await enterEditor(page);
  const olderMessage = 'Importing this backup replaces your current master CV and versions with the backup. This backup has no versions. A copy is kept in Your data > Recent snapshots. Continue?';
  let cancelMessage = '';
  page.once('dialog', (dialog) => {
    cancelMessage = dialog.message();
    dialog.dismiss();
  });
  await page.locator('#importInput').setInputFiles({
    name: 'v1-backup.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(validBackup))
  });
  await expect.poll(() => cancelMessage).toBe(olderMessage);
  expect(cancelMessage).not.toContain('will be removed');
  await expect(page.getByLabel('Full name')).toHaveValue('Keep Me');
  await expect.poll(() => page.evaluate(() => {
    const data = JSON.parse(localStorage.getItem('state-cv-data-v1'));
    return data.versions[0] && data.versions[0].name;
  })).toBe('Keep version');

  page.once('dialog', (dialog) => dialog.accept());
  await page.locator('#importInput').setInputFiles({
    name: 'v1-backup.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(validBackup))
  });
  await expect(page.getByLabel('Full name')).toHaveValue('Recovered CV');
  await expect.poll(() => page.evaluate(() => {
    const data = JSON.parse(localStorage.getItem('state-cv-data-v1'));
    return { schemaVersion: data.schemaVersion, versions: data.versions, name: data.master.basics.name };
  })).toEqual({ schemaVersion: 2, versions: [], name: 'Recovered CV' });
});

test('a blank master with a version does not promise a snapshot on import', async ({ page }) => {
  await page.addInitScript((stored) => localStorage.setItem('state-cv-data-v1', stored), JSON.stringify(savedVersionRecord('')));
  await openApp(page);
  await enterEditor(page);
  let pdfMessage = '';
  page.once('dialog', (dialog) => {
    pdfMessage = dialog.message();
    dialog.dismiss();
  });
  await page.locator('#pdfInput').setInputFiles(path.join(__dirname, '../fixtures', 'cv1-classic-single-column.pdf'));
  await expect.poll(() => pdfMessage).toBe('Importing will replace your current CV. Your 1 version will be removed. Continue?');
  expect(pdfMessage).not.toContain('Recent snapshots');
  await expect(page.getByLabel('Full name')).toHaveValue('');

  let jsonMessage = '';
  page.once('dialog', (dialog) => {
    jsonMessage = dialog.message();
    dialog.dismiss();
  });
  await page.locator('#importInput').setInputFiles({
    name: 'v1-backup.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(validBackup))
  });
  await expect.poll(() => jsonMessage).toBe('Importing this backup replaces your current master CV and versions with the backup. This backup has no versions. Continue?');
  expect(jsonMessage).not.toContain('Recent snapshots');
  await expect.poll(() => page.evaluate(() => {
    const data = JSON.parse(localStorage.getItem('state-cv-data-v1'));
    return data.master.basics.name === '' && data.versions[0] && data.versions[0].name === 'Keep version';
  })).toBe(true);
});

test('version pill, Viewing banner, and Tailor stay out of Menu', async ({ page }) => {
  await openApp(page);
  await enterEditor(page);
  await expect(page.locator('#versionPill')).toContainText('Master CV');
  await expect(page.locator('#versionBanner')).toBeHidden();
  await expect(page.locator('#formatLabel')).toHaveText('Letter / selectable text');
  await openMenu(page);
  const menuLabels = await page.locator('#moreMenuContent > button, #moreMenuContent > a').evaluateAll((elements) =>
    elements.map((element) => element.textContent.replace(/\s+/g, ' ').trim())
  );
  expect(menuLabels.some((label) => /version/i.test(label))).toBe(false);
  expect(menuLabels.at(-1)).toMatch(/Start new CV/);
  await expect(page.locator('#moreMenuContent')).not.toContainText('New version');
  await page.keyboard.press('Escape');
  await expect(page.locator('#moreMenuContent')).toBeHidden();

  await openVersions(page);
  await expect(page.locator('.more-menu')).not.toHaveAttribute('open', '');
  await expect(page.locator('#exportPanel')).toBeHidden();
  if (await page.locator('#mobileExportButton').isVisible()) {
    await expect(page.getByRole('radio', { name: 'Master CV', exact: true })).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(page.getByRole('button', { name: 'New version', exact: true })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('radio', { name: 'Master CV', exact: true })).toBeFocused();
  }
  await page.getByRole('button', { name: 'New version', exact: true }).click();
  await expect(page.locator('#actionToast')).toContainText('Version created');
  const toastClearsBanner = await page.evaluate(() => {
    const toast = document.querySelector('#actionToast').getBoundingClientRect();
    const targets = ['#versionBanner', '#versionBannerText', '#versionBannerTailor'].map((selector) =>
      document.querySelector(selector).getBoundingClientRect()
    );
    const hits = (target) =>
      target.width > 0 && target.height > 0 &&
      Math.min(toast.right, target.right) > Math.max(toast.left, target.left) &&
      Math.min(toast.bottom, target.bottom) > Math.max(toast.top, target.top);
    return targets.every((target) => !hits(target));
  });
  expect(toastClearsBanner).toBe(true);
  await expect(page.locator('#versionPill')).toContainText('Untitled version');
  await expect(page.locator('#versionBanner')).toContainText('Viewing Untitled version · Edits change your master CV');
  await expect(page.locator('#saveStatus')).toContainText('Saved locally');
  await expect(page.locator('#saveStatus')).not.toContainText('Version created');
  await expect(page.locator('#formatLabel')).toContainText('Untitled version · Letter / selectable text');
  await page.keyboard.press('Escape');
  await expect(page.locator('#versionSheet')).toBeHidden();
  await expect(page.locator('#versionPill')).toBeFocused();

  await page.locator('#versionBannerTailor').click();
  await expect(page.locator('#versionBannerTailor')).toBeHidden();
  await expect(page.getByRole('heading', { name: 'Tailoring: Untitled version' })).toBeVisible();
  await expect(page.getByRole('group', { name: 'Show in this version' })).toBeVisible();
  await expect(page.locator('#resumeForm')).toBeHidden();
  if (await page.locator('#previewPanel').isVisible()) await expect(page.locator('#resumePreview')).toBeVisible();
  await page.locator('#tailorDoneButton').click();
  await expect(page.locator('#tailorPanel')).toBeHidden();
  await expect(page.locator('#versionBannerTailor')).toBeVisible();
  await expect(page.locator('#resumeForm')).toBeVisible();
  await expect(page.getByRole('heading', { level: 2, name: 'Contact details' })).toBeVisible();

  const edit = page.getByRole('button', { name: 'Edit', exact: true });
  if (await edit.isVisible()) {
    await page.locator('#versionBannerTailor').click();
    await expect(page.locator('#tailorPanel')).toBeVisible();
    await page.locator('[data-mobile-view-button="preview"]').click();
    await expect(page.locator('#resumePreview')).toBeVisible();
    await expect(page.locator('#formatLabel')).toContainText('Untitled version');
    await edit.click();
    await expect(page.locator('#tailorPanel')).toBeHidden();
    await expect(page.locator('#resumeForm')).toBeVisible();
  }
});
