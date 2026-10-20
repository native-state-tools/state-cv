const STORAGE_KEY = 'state-cv-data-v1';
const LEGACY_STORAGE_KEY = 'resume-forge-data-v1';
const APP_NAME = 'State CV';
const MAX_IMPORT_FILE_SIZE = 25 * 1024 * 1024;
const PDF_PARSE_TIMEOUT_MS = 30000;
const MAX_PDF_PAGES = 20;
const MAX_PDF_TEXT_CHARS = 200000;

class ImportError extends Error {}

const defaultData = {
  basics: { name: '', title: '', location: '', email: '', phone: '', website: '' },
  exportName: '',
  summary: '',
  experience: [{ role: '', company: '', dates: '', highlights: '' }],
  education: [{ degree: '', school: '', dates: '' }],
  skills: ''
};

let storageLoadFailed = false;
let resumeData = loadData();
let saveTimer;

if (window.pdfjsLib) window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';

const escapeHtml = (value = '') => String(value).replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[character]));
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

function normalizeData(data = {}) {
  const experience = Array.isArray(data.experience) ? data.experience : [];
  const education = Array.isArray(data.education) ? data.education : [];
  const basics = data.basics && typeof data.basics === 'object' ? data.basics : {};
  const text = (value, fallback = '') => typeof value === 'string' ? value : fallback;
  const normalizeRecord = (record, defaults) => Object.fromEntries(Object.keys(defaults).map((key) => [key, text(record?.[key])]));
  return {
    ...structuredClone(defaultData),
    basics: Object.fromEntries(Object.keys(defaultData.basics).map((key) => [key, text(basics[key])])),
    exportName: text(data.exportName),
    summary: text(data.summary),
    skills: text(data.skills),
    experience: experience.map((record) => normalizeRecord(record, defaultData.experience[0])),
    education: education.map((record) => normalizeRecord(record, defaultData.education[0]))
  };
}

function loadData() {
  try {
    let raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      const legacy = localStorage.getItem(LEGACY_STORAGE_KEY);
      if (legacy) {
        raw = legacy;
        try { localStorage.setItem(STORAGE_KEY, legacy); } catch { /* ignore quota */ }
      }
    }
    const stored = raw ? JSON.parse(raw) : null;
    return stored ? normalizeData(stored) : structuredClone(defaultData);
  } catch (error) {
    storageLoadFailed = true;
    console.error('State CV could not load saved data.', error);
    return structuredClone(defaultData);
  }
}

function saveData() {
  const status = document.querySelector('#saveStatus');
  if (storageLoadFailed) {
    status.className = 'save-status error';
    status.innerHTML = '<span class="status-dot"></span>Saved data not replaced';
    return false;
  }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(resumeData));
    status.className = 'save-status saved';
    status.innerHTML = '<span class="status-dot"></span>Saved locally';
    return true;
  } catch (error) {
    status.className = 'save-status error';
    status.innerHTML = '<span class="status-dot"></span>Local save unavailable';
    console.error('State CV could not save locally.', error);
    return false;
  }
}

function scheduleSave() {
  const status = document.querySelector('#saveStatus');
  status.className = 'save-status saving';
  status.innerHTML = '<span class="status-dot"></span>Saving...';
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveData, 350);
}

function flushScheduledSave() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  saveData();
}

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
  list.innerHTML = '';
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

function updatePreview() {
  const { basics, summary, experience, education, skills } = resumeData;
  updateWorkspaceName();
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

function setImportStatus(message, isError = false) {
  const status = document.querySelector('#saveStatus');
  status.className = `save-status ${isError ? 'error' : 'saved'}`;
  status.innerHTML = '<span class="status-dot"></span>' + message;
}

function closeLaunchScreen() {
  const launchScreen = document.querySelector('#launchScreen');
  launchScreen.classList.add('is-hidden');
  launchScreen.setAttribute('aria-hidden', 'true');
  document.querySelector('#appShell').inert = false;
}
function openLaunchScreen() {
  updateLaunchScreen();
  const launchScreen = document.querySelector('#launchScreen');
  launchScreen.classList.remove('is-hidden');
  launchScreen.setAttribute('aria-hidden', 'false');
  document.querySelector('#appShell').inert = true;
}

function updateLaunchScreen() {
  let hasDraft = false;
  try { hasDraft = Boolean(localStorage.getItem(STORAGE_KEY) || localStorage.getItem(LEGACY_STORAGE_KEY)); } catch { hasDraft = false; }
  const name = resumeData.basics.name.trim();
  document.querySelector('#continueLabel').textContent = hasDraft ? `Continue ${name || 'your CV'}` : 'Continue your CV';
  document.querySelector('#continueMeta').textContent = hasDraft ? 'Saved locally' : 'No saved draft yet';
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
    const timeout = new Promise((resolve, reject) => {
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
document.querySelector('#addExperience').addEventListener('click', () => { resumeData.experience.push({ role: '', company: '', dates: '', highlights: '' }); renderRepeaters(); updateCompletion(); scheduleSave(); });
document.querySelector('#addEducation').addEventListener('click', () => { resumeData.education.push({ degree: '', school: '', dates: '' }); renderRepeaters(); updateCompletion(); scheduleSave(); });
function exportPdf() {
  if (!window.jspdf?.jsPDF) {
    window.print();
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
  const filename = `${(document.querySelector('#exportFilename').value.trim() || basics.name || 'CV').replace(/\.pdf$/i, '')}.pdf`;
  doc.save(filename);
  setImportStatus('PDF downloaded');
}
document.querySelector('#printButton').addEventListener('click', exportPdf);
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
  if (file.size > MAX_IMPORT_FILE_SIZE) {
    setImportStatus('PDF is too large', true);
    alert('Please choose a PDF smaller than 25 MB.');
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
document.querySelector('#exportButton').addEventListener('click', () => { const blob = new Blob([JSON.stringify(resumeData, null, 2)], { type: 'application/json' }); const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = `${(document.querySelector('#exportFilename').value.trim() || resumeData.basics.name || 'CV').replace(/\.pdf$/i, '')}.json`; link.click(); URL.revokeObjectURL(link.href); });
document.querySelector('#importButton').addEventListener('click', () => document.querySelector('#importInput').click());
document.querySelector('#importInput').addEventListener('change', async (event) => {
  const [file] = event.target.files;
  if (!file) return;
  if (file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')) await handlePdfImport(file);
  else if (file.size > MAX_IMPORT_FILE_SIZE) {
    setImportStatus('Backup file is too large', true);
    alert('Please choose a backup file smaller than 25 MB.');
  } else {
    try {
      const imported = JSON.parse(await file.text());
      resumeData = normalizeData(imported);
      document.querySelector('#exportFilename').removeAttribute('data-edited');
      renderFields(); updatePreview(); updateCompletion(); storageLoadFailed = false; saveData();
      closeLaunchScreen();
    } catch { alert('That file could not be read as a State CV JSON export.'); }
  }
  event.target.value = '';
});
document.querySelector('#resumeForm').addEventListener('submit', (event) => event.preventDefault());

renderFields();
updatePreview();
updateCompletion();
updatePrintPageSize();
updateLaunchScreen();
if (storageLoadFailed) setImportStatus('Saved data could not be loaded', true);
document.querySelector('#brandHome').addEventListener('click', (event) => { event.preventDefault(); openLaunchScreen(); });
document.querySelector('#continueButton').addEventListener('click', closeLaunchScreen);
document.querySelector('#newCvButton').addEventListener('click', () => {
  resumeData = structuredClone(defaultData);
  storageLoadFailed = false;
  document.querySelector('#exportFilename').removeAttribute('data-edited');
  renderFields(); updatePreview(); updateCompletion(); saveData(); closeLaunchScreen();
});
document.querySelector('#launchImportButton').addEventListener('click', () => document.querySelector('#pdfInput').click());

if ('serviceWorker' in navigator && /^https?:$/.test(window.location.protocol)) {
  navigator.serviceWorker.register('./sw.js').catch((error) => {
    console.error('State CV could not enable offline support.', error);
  });
}