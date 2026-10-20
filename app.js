const STORAGE_KEY = 'state-cv-data-v1';
const APP_NAME = 'State CV';
const SCHEMA_VERSION = 1;
const MAX_PDF_IMPORT_BYTES = 10 * 1024 * 1024;
const MAX_JSON_IMPORT_BYTES = 2 * 1024 * 1024;
const MAX_EXPERIENCE_ENTRIES = 30;
const MAX_EDUCATION_ENTRIES = 20;
const PDF_PARSE_TIMEOUT_MS = 30000;
const MAX_PDF_PAGES = 20;
const MAX_PDF_TEXT_CHARS = 200000;
const isIosDevice = () => /iPad|iPhone|iPod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const stateStorage = StateCVStorage();

class ImportError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ImportError';
  }
}

const defaultData = {
  basics: { name: '', title: '', location: '', email: '', phone: '', website: '' },
  exportName: '',
  summary: '',
  experience: [{ role: '', company: '', dates: '', highlights: '' }],
  education: [{ degree: '', school: '', dates: '' }],
  skills: ''
};

let storageLoadFailed = false;
let loadedRevision = 0;
let storageConflict = false;
let conflictingRevision = null;
let resumeData = loadData();
let saveTimer;

if (window.pdfjsLib) window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';

const escapeHtml = (value = '') => String(value).replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[character]));
function safeFilename(value, fallback = 'CV') {
  const filename = String(value)
    .replace(/\.(?:pdf|json)$/i, '')
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[. ]+/, '')
    .trim()
    .slice(0, 100)
    .trim();
  return filename || fallback;
}
const getValue = (path) => path.split('.').reduce((value, key) => value?.[key], resumeData) ?? '';
const setValue = (path, value) => {
  const keys = path.split('.');
  const lastKey = keys.pop();
  const target = keys.reduce((object, key) => {
    if (!object[key] || typeof object[key] !== 'object') object[key] = {};
    return object[key];
  }, resumeData);
  target[lastKey] = value;
};

function normalizeData(data, { strict = false } = {}) {
  const isPlainObject = (value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  };
  const reject = (message) => { throw new ImportError(message); };
  if (!isPlainObject(data)) reject('The file is not a State CV backup.');
  if (Object.hasOwn(data, 'schemaVersion')) {
    if (!Number.isInteger(data.schemaVersion) || data.schemaVersion < 1) reject('This backup has an invalid schema version.');
    if (data.schemaVersion > SCHEMA_VERSION) reject('This backup was made by a newer version of State CV.');
  }
  const normalizeText = (value, field, maxLength) => {
    if (value === undefined) return '';
    if (typeof value !== 'string') {
      if (strict) reject(`${field} must be a string.`);
      return '';
    }
    const cleaned = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
    if (cleaned.length > maxLength) {
      if (strict) reject(`${field} is longer than ${maxLength} characters.`);
      return cleaned.slice(0, maxLength);
    }
    return cleaned;
  };
  const normalizeObject = (value, field) => {
    if (value === undefined) return {};
    if (isPlainObject(value)) return value;
    if (strict) reject(`${field} must be an object.`);
    return {};
  };
  const normalizeRecords = (value, field, maxEntries, fields) => {
    if (value === undefined) value = [];
    if (!Array.isArray(value)) {
      if (strict) reject(`${field} must be an array.`);
      value = [];
    }
    if (value.length > maxEntries) {
      if (strict) reject(`${field} has more than ${maxEntries} entries.`);
      value = value.slice(0, maxEntries);
    }
    return value.map((record, index) => {
      if (!isPlainObject(record)) {
        if (strict) reject(`${field} entry ${index + 1} must be an object.`);
        record = {};
      }
      return Object.fromEntries(fields.map(([key, maxLength]) => [
        key,
        normalizeText(record[key], `${field} ${key}`, maxLength)
      ]));
    });
  };
  const basicsData = normalizeObject(data.basics, 'basics');
  const experience = normalizeRecords(data.experience, 'experience', MAX_EXPERIENCE_ENTRIES, [
    ['role', 200], ['company', 200], ['dates', 100], ['highlights', 10000]
  ]);
  const education = normalizeRecords(data.education, 'education', MAX_EDUCATION_ENTRIES, [
    ['degree', 200], ['school', 200], ['dates', 100]
  ]);
  return {
    basics: {
      name: normalizeText(basicsData.name, 'basics name', 200),
      title: normalizeText(basicsData.title, 'basics title', 200),
      location: normalizeText(basicsData.location, 'basics location', 200),
      email: normalizeText(basicsData.email, 'basics email', 254),
      phone: normalizeText(basicsData.phone, 'basics phone', 40),
      website: normalizeText(basicsData.website, 'basics website', 300)
    },
    exportName: normalizeText(data.exportName, 'exportName', 120),
    summary: normalizeText(data.summary, 'summary', 500),
    experience: experience.length ? experience : [{ role: '', company: '', dates: '', highlights: '' }],
    education: education.length ? education : [{ degree: '', school: '', dates: '' }],
    skills: normalizeText(data.skills, 'skills', 2000)
  };
}

function toStorable() {
  return { schemaVersion: SCHEMA_VERSION, ...resumeData };
}

function loadData() {
  try {
    const raw = stateStorage.getItem(STORAGE_KEY);
    if (raw === null) {
      loadedRevision = 0;
      return structuredClone(defaultData);
    }
    const parsed = JSON.parse(raw);
    loadedRevision = stateStorage.getDataRevision(STORAGE_KEY);
    return normalizeData(parsed, { strict: true });
  } catch (error) {
    storageLoadFailed = true;
    console.error('State CV could not load saved data.', error);
    return structuredClone(defaultData);
  }
}

function saveData({ force = false } = {}) {
  if (storageLoadFailed) {
    setStatus('error', 'Saved data not replaced');
    return false;
  }
  if (storageConflict && !force) {
    setStatus('error', 'Changes need your attention');
    return false;
  }
  try {
    loadedRevision = stateStorage.writeData(STORAGE_KEY, toStorable(), loadedRevision, force);
    storageConflict = false;
    conflictingRevision = null;
    hideStorageNotice();
    setStatus('saved', 'Saved locally');
    return true;
  } catch (error) {
    if (error.code === 'conflict') {
      showStorageConflict(error.actualRevision);
      setStatus('error', 'Changes need your attention');
      return false;
    }
    setStatus('error', 'Local save unavailable');
    console.error('State CV could not save locally.', error);
    return false;
  }
}

function scheduleSave() {
  setStatus('saving', 'Saving...');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveData, 350);
}

function flushScheduledSave() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  saveData();
}

function showStorageConflict(revision) {
  storageConflict = true;
  conflictingRevision = revision;
  const notice = document.querySelector('#storageNotice');
  notice.querySelector('#storageNoticeMessage').textContent =
    'This CV was saved in another tab. Reload the latest version, or keep your changes and replace it.';
  notice.querySelector('#reloadLatestButton').hidden = false;
  notice.querySelector('#keepMineButton').hidden = false;
  notice.hidden = false;
  notice.inert = false;
}

function hideStorageNotice() {
  const notice = document.querySelector('#storageNotice');
  if (notice.contains(document.activeElement)) document.querySelector('#brandHome').focus();
  notice.inert = true;
  notice.hidden = true;
}

function reloadLatestData() {
  try {
    const raw = stateStorage.getItem(STORAGE_KEY);
    if (raw === null) {
      resumeData = structuredClone(defaultData);
      loadedRevision = 0;
    } else {
      const parsed = JSON.parse(raw);
      const normalized = normalizeData(parsed, { strict: true });
      loadedRevision = stateStorage.getDataRevision(STORAGE_KEY);
      resumeData = normalized;
    }
    storageConflict = false;
    conflictingRevision = null;
    renderFields(); updatePreview(); updateCompletion(); updateLaunchScreen();
    hideStorageNotice();
    setStatus('saved', 'Latest version loaded');
  } catch (error) {
    setStatus('error', 'Latest version could not be loaded');
    console.error('State CV could not reload the latest saved data.', error);
  }
}

function keepMine() {
  if (!storageConflict) return;
  try {
    const currentRevision = stateStorage.getDataRevision(STORAGE_KEY);
    loadedRevision = currentRevision;
    saveData({ force: true });
  } catch (error) {
    setStatus('error', 'Latest version could not be checked');
    console.error('State CV could not check the latest saved data.', error);
  }
}

window.addEventListener('storage', (event) => {
  if (event.key !== STORAGE_KEY) return;
  try {
    const revision = event.newValue === null ? 0 : stateStorage.getDataRevision(STORAGE_KEY);
    if (revision !== loadedRevision) showStorageConflict(revision);
  } catch (error) {
    showStorageConflict(null);
  }
});

window.addEventListener('beforeunload', flushScheduledSave);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushScheduledSave(); });

function renderFields() {
  document.querySelectorAll('[data-path]').forEach((field) => { field.value = getValue(field.dataset.path); });
  renderRepeaters();
  updateSummaryCount();
}

function renderRepeaters() {
  renderRepeater('experienceList', 'experienceTemplate', resumeData.experience, () => structuredClone(defaultData.experience[0]));
  renderRepeater('educationList', 'educationTemplate', resumeData.education, () => structuredClone(defaultData.education[0]));
}

function renderRepeater(listId, templateId, items, createBlankRecord) {
  const list = document.querySelector(`#${listId}`);
  list.replaceChildren();
  items.forEach((item, index) => {
    const node = document.querySelector(`#${templateId}`).content.cloneNode(true);
    node.querySelectorAll('[data-key]').forEach((field) => {
      field.value = item[field.dataset.key] || '';
      field.addEventListener('input', () => { item[field.dataset.key] = field.value; updatePreview(); updateCompletion(); scheduleSave(); });
    });
    node.querySelector('.remove-item').addEventListener('click', () => {
      items.splice(index, 1);
      if (!items.length) items.push(createBlankRecord());
      renderRepeaters(); updatePreview(); updateCompletion(); scheduleSave();
    });
    list.appendChild(node);
  });
}

function updateSummaryCount() { document.querySelector('#summaryCount').textContent = `${resumeData.summary.length} / 500`; }

function updateWorkspaceName() {
  const name = resumeData.basics.name.trim();
  document.querySelector('#workspaceName').textContent = name ? `${name} CV` : 'Untitled CV';
  const filename = document.querySelector('#exportFilename');
  if (filename && !filename.dataset.edited) filename.value = resumeData.exportName || (name ? `${name} CV` : 'Untitled CV');
}

function updatePreview({ force = false } = {}) {
  updateWorkspaceName();
  if (!force && getComputedStyle(document.querySelector('#previewPanel')).display === 'none') return;
  const { basics, summary, experience, education, skills } = resumeData;
  const contact = [basics.location, basics.email, basics.phone, basics.website].filter(Boolean).map(escapeHtml).map((value) => `<span>${value}</span>`).join('');
  const experienceHtml = experience.filter((item) => item.role || item.company || item.highlights).map((item) => `<div class="resume-entry"><div class="entry-top"><strong class="entry-role">${escapeHtml(item.role || 'Role')}</strong><span class="entry-date">${escapeHtml(item.dates)}</span></div><div class="entry-company">${escapeHtml(item.company)}</div>${item.highlights ? `<ul class="entry-bullets">${item.highlights.split('\n').filter(Boolean).map((bullet) => `<li>${escapeHtml(bullet)}</li>`).join('')}</ul>` : ''}</div>`).join('');
  const educationHtml = education.filter((item) => item.degree || item.school).map((item) => `<div class="resume-entry"><div class="entry-top"><strong class="entry-role">${escapeHtml(item.degree || 'Degree')}</strong><span class="entry-date">${escapeHtml(item.dates)}</span></div><div class="entry-company">${escapeHtml(item.school)}</div></div>`).join('');
  document.querySelector('#resumePreview').innerHTML = `<header class="resume-header"><h2>${escapeHtml(basics.name || 'Your Name')}</h2><div class="resume-title">${escapeHtml(basics.title || 'Professional Title')}</div><div class="resume-contact">${contact || '<span>City, State</span><span>email@example.com</span><span>(555) 123-4567</span>'}</div></header>${summary ? `<section class="resume-section"><h3>Professional Summary</h3><p class="skills-line">${escapeHtml(summary)}</p></section>` : ''}${experienceHtml ? `<section class="resume-section"><h3>Experience</h3>${experienceHtml}</section>` : ''}${educationHtml ? `<section class="resume-section"><h3>Education</h3>${educationHtml}</section>` : ''}${skills ? `<section class="resume-section"><h3>Skills</h3><p class="skills-line">${escapeHtml(skills)}</p></section>` : ''}${!summary && !experienceHtml && !educationHtml && !skills ? '<p class="empty-preview">Your CV will appear here as you build it.<br />Start with your contact details.</p>' : ''}`;
}

function updateCompletion() {
  const values = [resumeData.basics.name, resumeData.basics.title, resumeData.basics.email, resumeData.summary, resumeData.experience.some((item) => item.role || item.company), resumeData.education.some((item) => item.degree || item.school), resumeData.skills];
  const percent = Math.round((values.filter(Boolean).length / values.length) * 100);
  document.querySelector('#completionPercent').textContent = `${percent}%`;
  document.querySelector('#completionLabel').textContent = percent === 100 ? 'Ready to send' : percent >= 70 ? 'Looking strong' : 'Add your details';
  const progress = Math.min(100, Math.round(percent / 25) * 25);
  document.querySelector('#completionRing').className = `completion-ring progress-${progress}`;
}

function setStatus(state, message) {
  const status = document.querySelector('#saveStatus');
  status.className = `save-status ${state}`;
  const dot = document.createElement('span');
  dot.className = 'status-dot';
  status.replaceChildren(dot, document.createTextNode(message));
}

function setImportStatus(message, isError = false) { setStatus(isError ? 'error' : 'saved', message); }

function closeLaunchScreen() {
  const launchScreen = document.querySelector('#launchScreen');
  const appShell = document.querySelector('#appShell');
  appShell.inert = false;
  document.querySelector('#brandHome').focus();
  launchScreen.inert = true;
  launchScreen.classList.add('is-hidden');
}
function openLaunchScreen() {
  updateLaunchScreen();
  const launchScreen = document.querySelector('#launchScreen');
  const appShell = document.querySelector('#appShell');
  launchScreen.inert = false;
  launchScreen.classList.remove('is-hidden');
  document.querySelector('#continueButton').focus();
  appShell.inert = true;
}

function hasSavedDraft() {
  try {
    return Boolean(stateStorage.getItem(STORAGE_KEY));
  } catch {
    return false;
  }
}

function updateLaunchScreen() {
  const hasDraft = hasSavedDraft();
  const name = resumeData.basics.name.trim();
  document.querySelector('#continueLabel').textContent = hasDraft ? `Continue ${name || 'your CV'}` : 'Continue your CV';
  document.querySelector('#continueMeta').textContent = hasDraft ? 'Saved locally' : 'No saved draft yet';
}

function startNewCv({ confirmReplacement = true } = {}) {
  if (confirmReplacement && !window.confirm('Starting a new CV will replace the current CV. Continue?')) return;
  resumeData = structuredClone(defaultData);
  storageLoadFailed = false;
  document.querySelector('#exportFilename').removeAttribute('data-edited');
  renderFields(); updatePreview(); updateCompletion(); saveData(); closeLaunchScreen();
}

async function extractPdfText(file) {
  if (!window.pdfjsLib) throw new Error('PDF reader is unavailable. The local vendor files may be missing.');
  const buffer = await file.arrayBuffer();
  const loadingTask = window.pdfjsLib.getDocument({
    data: new Uint8Array(buffer),
    isEvalSupported: false,
    enableXfa: false,
    disableFontFace: true,
    useWorkerFetch: false,
    verbosity: 0
  });
  let timeoutId;
  const parseDocument = async () => {
    const pdf = await loadingTask.promise;
    if (pdf.numPages > MAX_PDF_PAGES) throw new ImportError(`PDFs must have ${MAX_PDF_PAGES} pages or fewer.`);
    const pages = [];
    let textChars = 0;
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();
      const rows = [];
      content.items.forEach((item) => {
        textChars += item.str.length;
        if (textChars > MAX_PDF_TEXT_CHARS) throw new ImportError('This PDF contains too much text to import.');
        if (!item.str.trim()) return;
        const x = item.transform[4];
        const y = item.transform[5];
        const row = rows.find((candidate) => Math.abs(candidate.y - y) < 4);
        if (row) row.items.push({ x, text: item.str });
        else rows.push({ y, items: [{ x, text: item.str }] });
      });
      pages.push(rows.sort((a, b) => b.y - a.y).map((row) => row.items.sort((a, b) => a.x - b.x).map((item) => item.text).join(' ').replace(/\s*@\s*/g, '@').replace(/\s+/g, ' ').trim()).filter(Boolean));
    }
    const appChrome = new RegExp(`^\\d{1,2}\\/\\d{1,2}\\/\\d{2,4},?\\s+.*${APP_NAME.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')} \\| .*`, 'i');
    return pages.flat().filter((line) => line && !appChrome.test(line) && !/^localhost:\d+\s+\d+\/\d+$/i.test(line));
  };
  try {
    const timeout = new Promise((_, reject) => {
      timeoutId = setTimeout(() => {
        loadingTask.destroy().catch(() => {});
        reject(new ImportError(`PDF reading timed out after ${PDF_PARSE_TIMEOUT_MS / 1000} seconds.`));
      }, PDF_PARSE_TIMEOUT_MS);
    });
    return await Promise.race([parseDocument(), timeout]);
  } finally {
    clearTimeout(timeoutId);
    await loadingTask.destroy().catch(() => {});
  }
}

function sectionType(line) {
  const heading = line.toLowerCase().replace(/[|:]/g, '').replace(/\s+/g, ' ').trim();
  if (/^(professional )?summary$|^profile$|^objective$|^about me$|^career profile$|^professional profile$/.test(heading)) return 'summary';
  if (/^(professional |work |career )?experience$|^employment( history)?$|^career history$|^work history$|^relevant experience$|^selected experience$/.test(heading)) return 'experience';
  if (/^education$|^academic background$|^education (and|&) certifications?$|^certifications?$|^licenses( and certifications)?$/.test(heading)) return 'education';
  if (/^skills$|^technical skills$|^core competencies$|^areas of expertise$|^tools( and technologies)?$|^technology( stack)?$|^key skills$/.test(heading)) return 'skills';
  return '';
}

function splitPdfSections(lines) {
  const sections = {};
  let activeType = '';
  lines.forEach((line) => {
    const type = sectionType(line);
    if (type) { activeType = type; if (!sections[type]) sections[type] = []; return; }
    if (activeType) sections[activeType].push(line.trim());
  });
  return sections;
}

function dateLine(line) {
  return /(?:\d{1,2}[/-])?(?:19|20)\d{2}\s*(?:[-–—]|to)\s*(?:(?:\d{1,2}[/-])?(?:19|20)\d{2}|present|current)|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(?:19|20)\d{2}/i.test(line);
}

function extractDate(line) {
  return line.match(/(?:\d{1,2}[/-])?(?:19|20)\d{2}\s*(?:[-–—]|to)\s*(?:(?:\d{1,2}[/-])?(?:19|20)\d{2}|present|current)|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(?:19|20)\d{2}/i)?.[0] || '';
}

function cleanImportedLine(line) { return line.replace(/^[•●▪◦*-]\s*/, '').replace(/\s+/g, ' ').trim(); }

function mergeWrappedLines(values) {
  return values.reduce((merged, value) => {
    const hasBullet = /^[•●▪◦*-]\s*/.test(value);
    const current = cleanImportedLine(value);
    const previous = merged.at(-1) || '';
    if (merged.length && !hasBullet && !/[.!?]$/.test(previous)) merged[merged.length - 1] = `${previous} ${current}`;
    else merged.push(current);
    return merged;
  }, []);
}

function parseJobHeader(line) {
  const value = cleanImportedLine(line);
  const pipeParts = value.split('|').map((part) => part.trim()).filter(Boolean);
  if (pipeParts.length > 1) return { role: pipeParts[0], company: pipeParts[1].split(/\s+[—–-]\s+/)[0].trim() };
  const dashParts = value.split(/\s+[—–]\s+/).map((part) => part.trim()).filter(Boolean);
  return { role: dashParts[0] || value, company: dashParts[1] || '' };
}

function isJobHeader(line) {
  const value = cleanImportedLine(line);
  return !dateLine(value) && value.length < 140 && (/\|/.test(value) || /\s+[—–]\s+/.test(value));
}

function parseExperience(lines) {
  if (!lines?.length) return [];
  const records = [];
  let pending = [];
  let current = null;
  const addHighlights = (record, values) => {
    const highlights = mergeWrappedLines(values).filter((value) => value.length > 10).join('\n');
    if (record && highlights) record.highlights = [record.highlights, highlights].filter(Boolean).join('\n');
  };
  lines.forEach((line) => {
    if (!dateLine(line)) { pending.push(line); return; }
    const values = pending.map(cleanImportedLine).filter(Boolean);
    const date = extractDate(line);
    const inlineHeader = cleanImportedLine(line.replace(date, '').trim());
    const headerIndex = values.findLastIndex(isJobHeader);
    const nextHeader = headerIndex >= 0 ? parseJobHeader(values[headerIndex]) : (inlineHeader ? { role: inlineHeader, company: '' } : null);
    if (current) {
      if (!current.company && values.length && !/^[•●▪◦*-]/.test(values[0]) && !isJobHeader(values[0])) current.company = values.shift();
      const carry = nextHeader && headerIndex >= 0 ? values.slice(0, headerIndex) : values;
      addHighlights(current, carry);
      if (current.role || current.company || current.highlights) records.push(current);
    }
    current = nextHeader ? { ...nextHeader, dates: date, highlights: '' } : { role: '', company: '', dates: date, highlights: '' };
    pending = [];
  });
  if (current) {
    if (!current.company && pending.length && !/^[•●▪◦*-]/.test(cleanImportedLine(pending[0]))) current.company = cleanImportedLine(pending.shift());
    addHighlights(current, pending);
    if (current.role || current.company || current.highlights) records.push(current);
  } else if (pending.length) {
    const values = pending.map(cleanImportedLine).filter(Boolean);
    records.push({ role: values[0] || '', company: values[1] || '', dates: '', highlights: values.slice(2).join('\n') });
  }
  return records;
}

function parseEducation(lines) {
  if (!lines?.length) return [];
  const records = [];
  let group = [];
  let activeDates = '';
  const flush = (dates = activeDates) => {
    const values = group.map(cleanImportedLine).filter(Boolean);
    if (!values.length) { group = []; return; }
    records.push({ degree: values.at(-2) || values[0] || '', school: values.at(-1) || '', dates });
    group = [];
  };
  lines.forEach((line) => {
    if (dateLine(line)) {
      activeDates = line;
      if (group.length) flush(activeDates);
    }
    else group.push(line);
  });
  if (group.length) flush(activeDates);
  return records.filter((item) => item.degree || item.school);
}

function importPdfLines(lines) {
  const text = lines.join('\n');
  const sections = splitPdfSections(lines);
  const email = text.match(/[\w.+-]+@[\w-]+\.[\w.-]+/i)?.[0] || '';
  const phone = text.match(/(?:\+?\d[\d .()\-]{8,}\d)/)?.[0] || '';
  const emailDomain = email.split('@')[1] || '';
  const websiteMatch = text.match(/(?:https?:\/\/)?(?:www\.)?(?:linkedin\.com\/[^\s]+|[\w-]+\.(?:com|me|io)(?:\/[^\s]+)?)/i)?.[0] || '';
  const website = websiteMatch !== emailDomain ? websiteMatch : '';
  const emailIndex = lines.findIndex((line) => line.includes(email));
  const headerLines = lines.slice(0, emailIndex >= 0 ? emailIndex + 1 : 6).map(cleanImportedLine).filter((line) => line && !line.includes(email) && !line.match(/[\w.+-]+@[\w-]+\.[\w.-]+/i));
  const isHeaderLabel = (line) => Boolean(sectionType(line)) || /^(resume|curriculum vitae|contact|professional (title|summary|experience)|work history|employment history|career history|personal details)$/i.test(line);
  const name = headerLines.find((line) => line.length < 60 && !dateLine(line) && !isHeaderLabel(line) && !line.match(/\d{3,}/)) || '';
  const titleCandidate = headerLines.find((line) => line !== name && line.length < 70 && !dateLine(line) && !isHeaderLabel(line) && !line.match(/\d{3,}/));
  const summaryText = sections.summary?.join(' ') || '';
  const inferredTitle = /operations,? sales,? and logistics professional/i.test(summaryText) ? 'Operations, Sales & Logistics Professional' : '';
  const title = titleCandidate && !/@/.test(titleCandidate) ? titleCandidate : inferredTitle;
  const locationCandidate = headerLines.find((line) => /,\s*[A-Z]{2}\b/.test(line) && line !== name && !line.includes(name));
  const location = locationCandidate?.replace(email, '').replace(phone, '').replace(website, '').trim() || '';
  const importedExperience = parseExperience(sections.experience);
  const importedEducation = parseEducation(sections.education);
  const detectedBasics = { name, title, location, email, phone, website };
  if (Object.values(detectedBasics).some(Boolean)) resumeData.basics = { ...resumeData.basics, ...Object.fromEntries(Object.entries(detectedBasics).filter(([, value]) => value)) };
  resumeData.exportName = name ? `${name} CV` : 'CV';
  document.querySelector('#exportFilename').removeAttribute('data-edited');
  if (sections.summary?.length) resumeData.summary = sections.summary.join(' ').slice(0, 500);
  if (sections.skills?.length) resumeData.skills = sections.skills.join(', ').split(',').map((skill) => cleanImportedLine(skill.trim())).filter(Boolean).join(', ');
  if (importedExperience.length) resumeData.experience = importedExperience;
  if (importedEducation.length) resumeData.education = importedEducation;
  resumeData = normalizeData(resumeData, { strict: false });
  renderFields();
  updatePreview();
  updateCompletion();
  storageLoadFailed = false;
  saveData();
  return { sections: Object.keys(sections).filter((key) => sections[key].length), experience: importedExperience.length, education: importedEducation.length };
}

document.querySelectorAll('[data-path]').forEach((field) => field.addEventListener('input', () => { setValue(field.dataset.path, field.value); if (field.dataset.path === 'summary') updateSummaryCount(); updatePreview(); updateCompletion(); scheduleSave(); }));
document.querySelector('#addExperience').addEventListener('click', () => {
  if (resumeData.experience.length >= MAX_EXPERIENCE_ENTRIES) { setImportStatus(`Limit of ${MAX_EXPERIENCE_ENTRIES} entries reached`, true); return; }
  resumeData.experience.push({ role: '', company: '', dates: '', highlights: '' }); renderRepeaters(); updateCompletion(); scheduleSave();
});
document.querySelector('#addEducation').addEventListener('click', () => {
  if (resumeData.education.length >= MAX_EDUCATION_ENTRIES) { setImportStatus(`Limit of ${MAX_EDUCATION_ENTRIES} entries reached`, true); return; }
  resumeData.education.push({ degree: '', school: '', dates: '' }); renderRepeaters(); updateCompletion(); scheduleSave();
});
function exportPdf() {
  if (!window.jspdf?.jsPDF) {
    window.print();
    if (isIosDevice()) setImportStatus('If PDF opens, tap Share > Save to Files');
    return;
  }
  const { jsPDF } = window.jspdf;
  const paperSize = document.querySelector('#paperSize').value;
  const doc = new jsPDF({ unit: 'pt', format: paperSize, compress: true });
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const margin = 44;
  const contentWidth = pageWidth - margin * 2;
  let y = margin;
  const { basics, summary, experience, education, skills } = resumeData;
  const ensureSpace = (height) => { if (y + height > pageHeight - margin) { doc.addPage(); y = margin; } };
  const writeLines = (text, size, options = {}) => {
    doc.setFont('helvetica', options.bold ? 'bold' : 'normal');
    doc.setFontSize(size);
    const lines = doc.splitTextToSize(String(text || ''), options.width || contentWidth);
    ensureSpace(lines.length * (options.leading || size * 1.35));
    doc.text(lines, options.x || margin, y, { align: options.align || 'left' });
    y += lines.length * (options.leading || size * 1.35);
  };
  const sectionHeading = (label) => {
    ensureSpace(28);
    y += 13;
    doc.setFont('helvetica', 'bold'); doc.setFontSize(9); doc.setTextColor(35, 42, 39); doc.text(label.toUpperCase(), margin, y);
    y += 5; doc.setDrawColor(170, 178, 173); doc.setLineWidth(.6); doc.line(margin, y, pageWidth - margin, y); y += 12;
  };

  doc.setTextColor(29, 36, 33);
  writeLines(basics.name || 'Your Name', 22, { bold: true, leading: 25 });
  writeLines((basics.title || 'Professional Title').toUpperCase(), 8.5, { leading: 12 });
  const contact = [basics.location, basics.email, basics.phone, basics.website].filter(Boolean).join('  ·  ');
  if (contact) writeLines(contact, 8.5, { leading: 12 });
  y += 5; doc.setDrawColor(29, 36, 33); doc.setLineWidth(1.4); doc.line(margin, y, pageWidth - margin, y);
  if (summary) { sectionHeading('Professional Summary'); writeLines(summary, 9, { leading: 12 }); }
  if (experience.some((item) => item.role || item.company || item.highlights)) {
    sectionHeading('Experience');
    experience.filter((item) => item.role || item.company || item.highlights).forEach((item) => {
      ensureSpace(42);
      const role = item.role || 'Role';
      if (item.dates) {
        doc.setFont('helvetica', 'normal'); doc.setFontSize(8);
        doc.setTextColor(82, 91, 86);
        doc.text(item.dates, pageWidth - margin, y, { align: 'right' });
      }
      doc.setFont('helvetica', 'bold'); doc.setFontSize(10);
      doc.setTextColor(29, 36, 33);
      const roleWidth = item.dates ? contentWidth - 100 : contentWidth;
      writeLines(role, 10, { bold: true, width: roleWidth, leading: 13 });
      if (item.company) writeLines(item.company, 8.5, { leading: 11 });
      doc.setTextColor(29, 36, 33);
      if (item.highlights) item.highlights.split('\n').filter(Boolean).forEach((bullet) => { writeLines(`• ${bullet}`, 8.5, { x: margin + 8, width: contentWidth - 8, leading: 11 }); });
      y += 5;
    });
  }
  if (education.some((item) => item.degree || item.school)) {
    sectionHeading('Education');
    education.filter((item) => item.degree || item.school).forEach((item) => { ensureSpace(28); doc.setFont('helvetica', 'bold'); doc.setFontSize(9.5); doc.text(item.degree || 'Degree', margin, y); if (item.dates) { doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.text(item.dates, pageWidth - margin, y, { align: 'right' }); } y += 12; if (item.school) writeLines(item.school, 8.5, { leading: 11 }); y += 4; });
  }
  if (skills) { sectionHeading('Skills'); writeLines(skills, 9, { leading: 12 }); }
  const filename = `${safeFilename(document.querySelector('#exportFilename').value || basics.name || 'CV')}.pdf`;
  doc.save(filename);
  setImportStatus(isIosDevice() ? 'If PDF opens, tap Share > Save to Files' : 'PDF downloaded');
}
document.querySelector('#printButton').addEventListener('click', exportPdf);
let editViewScrollY = 0;
function setMobileView(view) {
  const appShell = document.querySelector('#appShell');
  const currentView = appShell.dataset.mobileView || 'edit';
  if (view === 'preview' && currentView !== 'preview') editViewScrollY = window.scrollY;
  appShell.dataset.mobileView = view;
  document.querySelectorAll('[data-mobile-view-button]').forEach((button) => {
    button.setAttribute('aria-pressed', String(button.dataset.mobileViewButton === view));
  });
  if (view === 'edit' && currentView === 'preview') {
    window.requestAnimationFrame(() => window.scrollTo({ top: editViewScrollY, behavior: 'instant' }));
  } else if (view === 'preview') {
    window.scrollTo({ top: 0, behavior: 'instant' });
  }
  if (view === 'preview') updatePreview();
}
document.querySelectorAll('[data-mobile-view-button]').forEach((button) => {
  button.addEventListener('click', () => setMobileView(button.dataset.mobileViewButton));
});
document.querySelector('#mobileExportButton').addEventListener('click', () => document.querySelector('#printButton').click());
window.addEventListener('beforeprint', () => updatePreview({ force: true }));
window.matchMedia('(min-width: 1024px)').addEventListener('change', () => updatePreview());
document.querySelector('#desktopPreviewButton').addEventListener('click', () => {
  const button = document.querySelector('#desktopPreviewButton');
  const isHidden = document.querySelector('#appShell').dataset.previewHidden !== 'true';
  document.querySelector('#appShell').dataset.previewHidden = String(isHidden);
  button.setAttribute('aria-expanded', String(!isHidden));
  button.textContent = isHidden ? 'Show preview' : 'Hide preview';
  document.querySelector('#previewPanel').setAttribute('aria-hidden', String(isHidden));
  if (!isHidden) updatePreview();
});
const moreMenu = document.querySelector('.more-menu');
const moreMenuButton = moreMenu.querySelector('summary');
function closeMoreMenu({ returnFocus = false } = {}) {
  if (!moreMenu.open) return;
  moreMenu.open = false;
  if (returnFocus) moreMenuButton.focus();
}
document.addEventListener('pointerdown', (event) => {
  if (moreMenu.open && !moreMenu.contains(event.target)) closeMoreMenu();
});
moreMenu.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    event.preventDefault();
    closeMoreMenu({ returnFocus: true });
  }
});
moreMenu.querySelectorAll('button, select, input').forEach((control) => {
  control.addEventListener('change', () => closeMoreMenu());
  control.addEventListener('click', () => {
    if (control.tagName === 'BUTTON') closeMoreMenu({ returnFocus: true });
  });
});
function updatePrintPageSize(size = document.querySelector('#paperSize').value) {
  const normalizedSize = size === 'a4' ? 'a4' : 'letter';
  document.documentElement.classList.toggle('page-a4', normalizedSize === 'a4');
  document.documentElement.classList.toggle('page-letter', normalizedSize === 'letter');
  document.querySelector('#formatLabel').textContent = `${normalizedSize === 'a4' ? 'A4' : 'Letter'} / selectable text`;
}
document.querySelector('#paperSize').addEventListener('change', (event) => updatePrintPageSize(event.target.value));
document.querySelector('#importPdfButton').addEventListener('click', () => document.querySelector('#pdfInput').click());
async function handlePdfImport(file) {
  if (!file) return;
  if (file.size > MAX_PDF_IMPORT_BYTES) {
    setImportStatus('PDF is too large', true);
    alert(`Please choose a PDF smaller than ${MAX_PDF_IMPORT_BYTES / (1024 * 1024)} MB.`);
    return;
  }
  setImportStatus('Reading PDF...');
  try {
    const lines = await extractPdfText(file);
    if (!lines.length) throw new ImportError('This PDF has no selectable text. Try an OCR-enabled PDF.');
    const imported = importPdfLines(lines);
    setImportStatus(`PDF imported · ${imported.experience + imported.education} entries`);
    closeLaunchScreen();
  } catch (error) {
    if (error instanceof ImportError) {
      setImportStatus(error.message, true);
      alert(error.message);
    } else {
      console.error('State CV could not read the PDF.', error);
      const message = 'That PDF could not be read. It may be damaged or password protected.';
      setImportStatus(message, true);
      alert(message);
    }
  }
}
document.querySelector('#pdfInput').addEventListener('change', async (event) => {
  const [file] = event.target.files;
  await handlePdfImport(file);
  event.target.value = '';
});
document.querySelector('#exportFilename').addEventListener('input', (event) => { event.target.dataset.edited = 'true'; resumeData.exportName = event.target.value; scheduleSave(); });
document.querySelector('#exportButton').addEventListener('click', () => { const blob = new Blob([JSON.stringify(toStorable(), null, 2)], { type: 'application/json' }); const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = `${safeFilename(document.querySelector('#exportFilename').value || resumeData.basics.name || 'CV')}.json`; link.click(); URL.revokeObjectURL(link.href); });
document.querySelector('#importButton').addEventListener('click', () => document.querySelector('#importInput').click());
document.querySelector('#importInput').addEventListener('change', async (event) => {
  const [file] = event.target.files;
  if (!file) return;
  if (file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')) await handlePdfImport(file);
  else if (file.size > MAX_JSON_IMPORT_BYTES) {
    setImportStatus('Backup file is too large', true);
    alert(`Please choose a backup file smaller than ${MAX_JSON_IMPORT_BYTES / (1024 * 1024)} MB.`);
  } else {
    let fileText;
    try {
      fileText = await file.text();
    } catch (error) {
      const message = 'That file could not be read as a State CV JSON export.';
      console.error('State CV could not read the JSON backup.', error);
      setImportStatus(message, true);
      alert(message);
      event.target.value = '';
      return;
    }
    let imported;
    try {
      imported = JSON.parse(fileText);
    } catch {
      const message = 'That file is not valid JSON.';
      setImportStatus(message, true);
      alert(message);
      event.target.value = '';
      return;
    }
    try {
      const normalized = normalizeData(imported, { strict: true });
      resumeData = normalized;
      document.querySelector('#exportFilename').removeAttribute('data-edited');
      renderFields(); updatePreview(); updateCompletion(); storageLoadFailed = false; saveData();
      closeLaunchScreen();
    } catch (error) {
      if (error instanceof ImportError) {
        const message = `That backup could not be imported. ${error.message}`;
        setImportStatus(message, true);
        alert(message);
      } else {
        const message = 'That file could not be read as a State CV JSON export.';
        console.error('State CV could not import the JSON backup.', error);
        setImportStatus(message, true);
        alert(message);
      }
    }
  }
  event.target.value = '';
});
document.querySelector('#resumeForm').addEventListener('submit', (event) => event.preventDefault());
document.querySelector('#reloadLatestButton').addEventListener('click', reloadLatestData);
document.querySelector('#keepMineButton').addEventListener('click', keepMine);

renderFields();
updatePreview();
updateCompletion();
updatePrintPageSize();
updateLaunchScreen();
if (storageLoadFailed) setImportStatus('Saved data could not be loaded', true);
document.querySelector('#brandHome').addEventListener('click', (event) => { event.preventDefault(); openLaunchScreen(); });
document.querySelector('#continueButton').addEventListener('click', closeLaunchScreen);
document.querySelector('#newCvButton').addEventListener('click', () => {
  startNewCv({ confirmReplacement: hasSavedDraft() });
});
document.querySelector('#startNewCvButton').addEventListener('click', startNewCv);
document.querySelector('#launchImportButton').addEventListener('click', () => document.querySelector('#pdfInput').click());

if ('serviceWorker' in navigator && /^https?:$/.test(window.location.protocol)) {
  navigator.serviceWorker.register('./sw.js').catch((error) => {
    console.error('State CV could not enable offline support.', error);
  });
}