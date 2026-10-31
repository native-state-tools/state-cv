function pdfItemBoxes(items) {
  const boxes = [];
  (Array.isArray(items) ? items : []).forEach((item) => {
    if (!item || typeof item.str !== 'string' || !item.str.trim()) return;
    const transform = Array.isArray(item.transform) ? item.transform : [];
    const x = Number(transform[4]) || 0;
    const y = Number(transform[5]) || 0;
    const width = Math.max(0, Number(item.width) || 0);
    const size = Math.abs(Number(item.height)) || Math.hypot(Number(transform[2]) || 0, Number(transform[3]) || 0) || 10;
    boxes.push({ x, y, end: x + width, width, size, text: item.str });
  });
  return boxes;
}

function splitPdfColumns(boxes) {
  if (boxes.length < 12) return [boxes];
  const minX = Math.min(...boxes.map((box) => box.x));
  const maxX = Math.max(...boxes.map((box) => box.end));
  const span = maxX - minX;
  if (!(span > 0) || boxes.some((box) => !box.width)) return [boxes];
  const rowsOf = (list, top, bottom) => new Set(list.filter((box) => box.y <= top + 1 && box.y >= bottom - 1).map((box) => Math.round(box.y))).size;
  const candidates = [...new Set(boxes.map((box) => box.x))].filter((x) => x > minX + span * 0.2 && x < minX + span * 0.8).sort((a, b) => a - b);
  for (const gutter of candidates) {
    const left = boxes.filter((box) => box.end <= gutter - 1);
    const right = boxes.filter((box) => box.x >= gutter - 0.5);
    if (left.length < 4 || right.length < 4) continue;
    const cross = boxes.filter((box) => !left.includes(box) && !right.includes(box));
    const top = Math.min(Math.max(...left.map((box) => box.y)), Math.max(...right.map((box) => box.y)));
    const bottom = Math.max(Math.min(...left.map((box) => box.y)), Math.min(...right.map((box) => box.y)));
    if (top <= bottom) continue;
    if (cross.some((box) => box.y <= top + 1 && box.y >= bottom - 1)) continue;
    if (rowsOf(left, top, bottom) < 4 || rowsOf(right, top, bottom) < 4) continue;
    if (right.filter((box) => box.y <= top + 1 && box.y >= bottom - 1 && !dateLine(box.text)).length < 3) continue;
    return [cross.filter((box) => box.y > top), left, right, cross.filter((box) => box.y < bottom)].filter((group) => group.length);
  }
  return [boxes];
}

function pdfBoxesToLines(boxes) {
  const rows = [];
  boxes.forEach((box) => {
    const row = rows.find((candidate) => Math.abs(candidate.y - box.y) < 4);
    if (row) row.boxes.push(box);
    else rows.push({ y: box.y, boxes: [box] });
  });
  return rows.sort((a, b) => b.y - a.y).map((row) => {
    let text = '';
    let previous = null;
    row.boxes.sort((a, b) => a.x - b.x).forEach((box) => {
      if (!previous) text = box.text;
      else {
        const gap = box.x - previous.end;
        const size = Math.max(previous.size, box.size);
        let separator = ' ';
        if (previous.width && gap > size * 2) separator = '\t';
        else if (previous.width && gap <= size * 0.12 && !/\s$/.test(text) && !/^\s/.test(box.text)) separator = '';
        text += separator + box.text;
      }
      previous = previous ? { ...box, end: Math.max(previous.end, box.end) } : box;
    });
    return text.replace(/\s*@\s*/g, '@').replace(/[^\S\t]+/g, ' ').replace(/ *\t[\s]*/g, '\t').trim();
  }).filter(Boolean);
}

function pdfItemsToLines(items) {
  return splitPdfColumns(pdfItemBoxes(items)).flatMap(pdfBoxesToLines)
    .filter((line) => !/^(?:.*\s)?page\s+\d+(?:\s*(?:of|\/)\s*\d+)?$/i.test(line) && !/^\d+\s*(?:of|\/)\s*\d+$/i.test(line));
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
      content.items.forEach((item) => {
        textChars += item.str.length;
        if (textChars > MAX_PDF_TEXT_CHARS) throw new ImportError('This PDF contains too much text to import.');
      });
      pages.push(pdfItemsToLines(content.items));
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
  if (/^(skills|technical skills|core competencies|areas of expertise|tools( and technologies)?|technology( stack)?|key skills|core skills|skills (and|&) tools)$/.test(heading)) return 'skills';
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
  return IMPORT_DATE_PATTERN.test(String(line ?? ''));
}

function extractDate(line) {
  return String(line ?? '').match(IMPORT_DATE_PATTERN)?.[0] || '';
}

const IMPORT_MONTH = '\\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?';
const IMPORT_DATE_POINT = `(?:${IMPORT_MONTH}\\s+|\\b\\d{1,2}[/.-])?(?:19|20)\\d{2}\\b`;
const IMPORT_DATE_PATTERN = new RegExp(`${IMPORT_DATE_POINT}\\s*(?:[-–—]|to|until)\\s*(?:${IMPORT_DATE_POINT}|present\\b|current\\b|now\\b|today\\b)|${IMPORT_MONTH}\\s+(?:19|20)\\d{2}\\b`, 'i');
const IMPORT_BULLET = /^\s*(?:[•●▪◦‣*]|[-–](?=\s))\s*/;

function cleanImportedLine(line) { return String(line ?? '').replace(IMPORT_BULLET, '').replace(/\s+/g, ' ').trim(); }

function trimImportSeparators(value) { return String(value ?? '').replace(/^[\s|·•,;–—-]+|[\s|·•,;–—-]+$/g, ''); }

function splitImportParts(line) {
  return String(line ?? '').split(/\s*(?:\t|\||·|\s[—–]\s)\s*/).map((part) => trimImportSeparators(cleanImportedLine(part))).filter(Boolean);
}

function mergeWrappedLines(values) {
  return values.reduce((merged, value) => {
    const hasBullet = IMPORT_BULLET.test(value);
    const current = cleanImportedLine(value);
    if (!current) return merged;
    const previous = merged.at(-1) || '';
    if (merged.length && !hasBullet && !/[.!?]$/.test(previous)) merged[merged.length - 1] = /[A-Za-z]-$/.test(previous) && /^[a-z]/.test(current) ? `${previous}${current}` : `${previous} ${current}`;
    else merged.push(current);
    return merged;
  }, []);
}

function parseExperience(lines) {
  if (!lines?.length) return [];
  const raw = lines.map((line) => String(line ?? ''));
  const isBullet = (line) => IMPORT_BULLET.test(line);
  const isAnchor = (line) => {
    if (isBullet(line)) return false;
    const date = extractDate(line);
    if (!date) return false;
    const rest = cleanImportedLine(line.replace(date, ''));
    return rest.length <= 90 && !/[.!?]$/.test(rest);
  };
  const headerLike = (line) => {
    if (line === undefined || isBullet(line) || dateLine(line)) return false;
    const value = cleanImportedLine(line);
    return Boolean(value) && value.length <= 80 && !/[.!?;:]$/.test(value) && value.split(' ').length <= 10 && !/^[a-z]/.test(value);
  };
  const anchors = raw.map((line, index) => (isAnchor(line) ? index : -1)).filter((index) => index >= 0);
  if (!anchors.length) {
    const values = raw.map(cleanImportedLine).filter(Boolean);
    return values.length ? [{ role: values[0] || '', company: values[1] || '', dates: '', highlights: values.slice(2).join('\n') }] : [];
  }
  const jobs = [];
  let consumedUntil = -1;
  anchors.forEach((anchor, position) => {
    const nextAnchor = anchors[position + 1] ?? raw.length;
    const date = extractDate(raw[anchor]).replace(/\s+/g, ' ').trim();
    const rest = splitImportParts(raw[anchor].replace(extractDate(raw[anchor]), ''));
    const prev = anchor - 1 > consumedUntil && headerLike(raw[anchor - 1]) ? anchor - 1 : -1;
    const prev2 = prev - 1 > consumedUntil && headerLike(raw[prev - 1]) ? prev - 1 : -1;
    const next = anchor + 1 < nextAnchor && anchor + 2 !== nextAnchor && headerLike(raw[anchor + 1]) ? anchor + 1 : -1;
    const joined = (index) => splitImportParts(raw[index]).join(', ');
    let role = '';
    let company = '';
    let start = anchor;
    let end = anchor;
    if (!rest.length) {
      if (prev2 >= 0) { role = joined(prev2); company = joined(prev); start = prev2; }
      else if (prev >= 0) { role = joined(prev); start = prev; if (next >= 0) { company = joined(next); end = next; } }
    } else if (prev >= 0 && next < 0) {
      role = joined(prev); company = rest.join(', '); start = prev;
    } else if (rest.length >= 2) {
      role = rest[0]; company = rest.slice(1).join(', ');
    } else {
      role = rest[0];
      if (next >= 0) { company = joined(next); end = next; }
    }
    jobs.push({ role, company, dates: date, start, end });
    consumedUntil = end;
  });
  return jobs.map((job, index) => {
    const stop = index + 1 < jobs.length ? jobs[index + 1].start : raw.length;
    const highlights = mergeWrappedLines(raw.slice(job.end + 1, stop)).filter((value) => value.length > 10).join('\n');
    return { role: job.role, company: job.company, dates: job.dates, highlights };
  }).filter((job) => job.role || job.company || job.highlights);
}

function parseEducation(lines) {
  if (!lines?.length) return [];
  const records = [];
  let group = [];
  let activeDates = '';
  const flush = (dates = activeDates) => {
    let values = group.map((value) => trimImportSeparators(cleanImportedLine(value))).filter(Boolean);
    if (!values.length) { group = []; return; }
    if (values.length === 1) values = splitImportParts(group[0]);
    records.push({ degree: values.length > 1 ? values.at(-2) : values[0] || '', school: values.length > 1 ? values.at(-1) : '', dates });
    group = [];
  };
  lines.forEach((line) => {
    if (!dateLine(line)) { group.push(line); return; }
    const date = extractDate(line);
    const rest = date ? trimImportSeparators(cleanImportedLine(line.replace(date, ''))) : '';
    if (!rest) {
      activeDates = date || cleanImportedLine(line);
      if (group.length) flush(activeDates);
      return;
    }
    if (activeDates && group.length) flush(activeDates);
    activeDates = date;
    group.push(rest);
  });
  if (group.length) flush(activeDates);
  return records.filter((item) => item.degree || item.school);
}

function splitSkills(lines) {
  const seen = new Set();
  const skills = [];
  const merged = [];
  (Array.isArray(lines) ? lines : []).forEach((value) => {
    const line = String(value);
    const previous = merged.at(-1);
    if (previous !== undefined && /[,;|]/.test(previous) && !/[,;|]\s*$/.test(previous) && /^[a-z]/.test(line.trim())) merged[merged.length - 1] = `${previous} ${line.trim()}`;
    else merged.push(line);
  });
  merged.forEach((line) => {
    line.split(/[,|;\t]|[•·▪]/).forEach((part) => {
      const skill = part.replace(/^[•●▪◦·\u2013\u2014*-]\s*/, '').replace(/\s+/g, ' ').trim();
      if (!skill || seen.has(skill)) return;
      seen.add(skill);
      skills.push(skill);
    });
  });
  return skills.join(', ');
}

function detectContact(text) {
  const source = String(text ?? '');
  const emailMatch = source.match(/[\w.+-]+@[\w-]+\.[\w.-]+/i);
  const email = emailMatch ? emailMatch[0] : '';
  const emailStart = emailMatch ? emailMatch.index : -1;
  const emailEnd = emailStart >= 0 ? emailStart + email.length : -1;
  const emailDomain = email.includes('@') ? email.split('@')[1].toLowerCase() : '';
  const phonePattern = /(?:\+\d{1,3}[ .]?)?(?:\(?\d{1,4}\)?[ .\-])+\d{2,4}(?:[ .\-]\d{2,4})*/g;
  let phone = '';
  let phoneMatch;
  while ((phoneMatch = phonePattern.exec(source))) {
    const candidate = phoneMatch[0];
    const digits = candidate.replace(/\D/g, '');
    if (digits.length < 7 || digits.length > 15) continue;
    if (dateLine(candidate)) continue;
    phone = candidate;
    break;
  }
  const websitePattern = /(?:https?:\/\/)?(?:www\.)?(?:linkedin\.com\/[^\s]+|[\w-]+\.(?:com|me|io)(?:\/[^\s]+)?)/ig;
  let website = '';
  let websiteMatch;
  while ((websiteMatch = websitePattern.exec(source))) {
    const value = websiteMatch[0];
    const start = websiteMatch.index;
    const end = start + value.length;
    if (emailStart >= 0 && start < emailEnd && end > emailStart) continue;
    const bare = value.replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/+$/, '').toLowerCase();
    if (emailDomain && bare === emailDomain) continue;
    website = value;
    break;
  }
  return { email, phone, website };
}

function importPdfLines(lines) {
  cancelScheduledSave();
  hideUndoToast();
  const text = lines.join('\n');
  const sections = splitPdfSections(lines);
  const { email, phone, website } = detectContact(text);
  const emailIndex = email ? lines.findIndex((line) => line.includes(email)) : -1;
  const sectionAfterHeader = lines.findIndex((line, index) => index > Math.max(emailIndex, 0) && sectionType(line));
  const headerRegion = lines.slice(0, sectionAfterHeader >= 0 ? sectionAfterHeader : Math.min(lines.length, 8));
  const headerLines = lines.slice(0, emailIndex >= 0 ? emailIndex + 1 : 6).map(cleanImportedLine).filter((line) => line && !line.includes(email) && !line.match(/[\w.+-]+@[\w-]+\.[\w.-]+/i));
  const isHeaderLabel = (line) => Boolean(sectionType(line)) || /^(resume|curriculum vitae|contact|professional (title|summary|experience)|work history|employment history|career history|personal details)$/i.test(line);
  const looksLikeLocation = (part) => /^[A-Z][A-Za-z.'\- ]{1,40},\s*(?:[A-Z]{2}|[A-Z][a-z]+(?: [A-Z][a-z]+)*)$/.test(part) && !/@|\d/.test(part);
  const name = headerLines.find((line) => line.length < 60 && !dateLine(line) && !isHeaderLabel(line) && !line.match(/\d{3,}/)) || '';
  const titleCandidate = headerLines.find((line) => line !== name && line.length < 70 && !dateLine(line) && !isHeaderLabel(line) && !line.match(/\d{3,}/) && !looksLikeLocation(line) && !/[|\t]/.test(line));
  const title = titleCandidate && !/@/.test(titleCandidate) ? titleCandidate : '';
  const location = headerRegion.flatMap(splitImportParts).find((part) => part !== name && looksLikeLocation(part)) || '';
  const summary = mergeWrappedLines((sections.summary || []).map((line) => line.replace(/\t/g, ' '))).join(' ');
  const importedExperience = parseExperience(sections.experience);
  const importedEducation = parseEducation(sections.education);
  const detectedBasics = { name, title, location, email, phone, website };
  resumeData = structuredClone(defaultData);
  resumeData.basics = { ...resumeData.basics, ...detectedBasics };
  resumeData.exportName = name ? `${name} CV` : 'CV';
  document.querySelector('#exportFilename').removeAttribute('data-edited');
  if (summary) resumeData.summary = summary.slice(0, 500);
  if (sections.skills?.length) resumeData.skills = splitSkills(sections.skills);
  if (importedExperience.length) resumeData.experience = importedExperience;
  if (importedEducation.length) resumeData.education = importedEducation;
  resumeData = normalizeData(resumeData, { strict: false });
  renderFields();
  updatePreview();
  updateCompletion();
  const saved = saveData();
  return { sections: Object.keys(sections).filter((key) => sections[key].length), experience: importedExperience.length, education: importedEducation.length, saved };
}
