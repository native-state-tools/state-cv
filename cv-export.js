const PDF_TEXT_SIZES = {
  compact: { name: 16, title: 9, contact: 9, heading: 9.5, body: 9, role: 10, meta: 9, date: 9 },
  standard: { name: 18, title: 10.5, contact: 10, heading: 11, body: 10.5, role: 11, meta: 10.5, date: 10 },
  large: { name: 20, title: 12, contact: 11.5, heading: 12, body: 12, role: 12.5, meta: 11.5, date: 11.5 }
};

function toPdfText(text) {
  return String(text ?? '')
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, '-')
    .replace(/\u2026/g, '...')
    .replace(/[\u2022\u2023\u2043\u2219\u25E6\u25AA\u25AB\u25CF\u25CB\u25A0]/g, '-')
    .replace(/\u00A0/g, ' ');
}

function isWinAnsiChar(character) {
  const code = character.codePointAt(0);
  if (code === 0x09 || code === 0x0A || code === 0x0D) return true;
  if (code >= 0x20 && code <= 0x7E) return true;
  if (code >= 0xA0 && code <= 0xFF) return true;
  return code === 0x20AC || code === 0x201A || code === 0x0192 || code === 0x201E ||
    code === 0x2026 || code === 0x2020 || code === 0x2021 || code === 0x02C6 ||
    code === 0x2030 || code === 0x0160 || code === 0x2039 || code === 0x0152 ||
    code === 0x017D || code === 0x2018 || code === 0x2019 || code === 0x201C ||
    code === 0x201D || code === 0x2022 || code === 0x2013 || code === 0x2014 ||
    code === 0x02DC || code === 0x2122 || code === 0x0161 || code === 0x203A ||
    code === 0x0153 || code === 0x017E || code === 0x0178;
}

function findUnsupportedChars(data) {
  const source = data && typeof data === 'object' ? data : {};
  const basics = source.basics && typeof source.basics === 'object' ? source.basics : {};
  const parts = [
    basics.name, basics.title, basics.location, basics.email, basics.phone, basics.website,
    source.summary, source.skills
  ];
  (Array.isArray(source.experience) ? source.experience : []).forEach((item) => {
    if (!item || typeof item !== 'object') return;
    parts.push(item.role, item.company, item.dates, item.highlights);
  });
  (Array.isArray(source.education) ? source.education : []).forEach((item) => {
    if (!item || typeof item !== 'object') return;
    parts.push(item.degree, item.school, item.dates);
  });
  const found = [];
  const seen = new Set();
  for (const character of toPdfText(parts.filter((part) => part != null && part !== '').join('\n'))) {
    if (!character.trim() || isWinAnsiChar(character) || seen.has(character)) continue;
    seen.add(character);
    found.push(character);
  }
  return found;
}

function getAtsTips(data) {
  const source = data && typeof data === 'object' ? data : {};
  const basics = source.basics && typeof source.basics === 'object' ? source.basics : {};
  const text = (value) => String(value ?? '').trim();
  const tips = [];
  if (!text(basics.name)) tips.push('Add your name.');
  if (!text(basics.email)) tips.push('Add your email.');
  if (!text(basics.phone)) tips.push('Add your phone number.');
  if (!text(source.summary)) tips.push('Add a professional summary.');
  if (!text(source.skills)) tips.push('Add your skills.');

  const countUndated = (entries, keys) => (Array.isArray(entries) ? entries : []).filter((item) => {
    if (!item || typeof item !== 'object') return false;
    return keys.some((key) => text(item[key])) && !text(item.dates);
  }).length;
  const experienceUndated = countUndated(source.experience, ['role', 'company', 'highlights']);
  if (experienceUndated === 1) tips.push('1 experience entry has no dates.');
  else if (experienceUndated > 1) tips.push(`${experienceUndated} experience entries have no dates.`);
  const educationUndated = countUndated(source.education, ['degree', 'school']);
  if (educationUndated === 1) tips.push('1 education entry has no dates.');
  else if (educationUndated > 1) tips.push(`${educationUndated} education entries have no dates.`);

  let longBullets = 0;
  (Array.isArray(source.experience) ? source.experience : []).forEach((item) => {
    if (!item || typeof item !== 'object') return;
    String(item.highlights ?? '').split(/\r?\n/).forEach((line) => {
      if (text(line).length > 200) longBullets += 1;
    });
  });
  if (longBullets === 1) tips.push('1 bullet is longer than 200 characters.');
  else if (longBullets > 1) tips.push(`${longBullets} bullets are longer than 200 characters.`);

  const unsupported = findUnsupportedChars(source);
  if (unsupported.length) tips.push(`Unsupported characters: ${unsupported.join(', ')}.`);
  return tips;
}

function cvToPlainText(data) {
  const source = data && typeof data === 'object' ? data : {};
  const basics = source.basics && typeof source.basics === 'object' ? source.basics : {};
  const clean = (value) => toPdfText(value).trim();
  const lines = [];
  const add = (value) => {
    const text = clean(value);
    if (text) lines.push(text);
  };
  const section = (heading, bodyLines) => {
    if (!bodyLines.some((line) => String(line ?? '').trim())) return;
    if (lines.length) lines.push('');
    lines.push(heading);
    bodyLines.forEach((line) => lines.push(String(line)));
  };
  const bulletLines = (value) => String(value ?? '').split(/\r\n|\r|\n/).map((line) => clean(line).replace(/^[-*]\s+/, '')).filter(Boolean);

  add(basics.name);
  add(basics.title);
  add([basics.location, basics.email, basics.phone, basics.website].map(clean).filter(Boolean).join(' | '));
  const summary = clean(source.summary);
  if (summary) section('Professional Summary', [summary]);

  const experience = (Array.isArray(source.experience) ? source.experience : []).filter((item) =>
    item && typeof item === 'object' && [item.role, item.company, item.dates, item.highlights].some((value) => clean(value)));
  if (experience.length) {
    const body = [];
    experience.forEach((item, index) => {
      if (index > 0) body.push('');
      addEntry(body, [clean(item.role), clean(item.company), clean(item.dates)]);
      bulletLines(item.highlights).forEach((bullet) => body.push(`- ${bullet}`));
    });
    section('Experience', body);
  }

  const education = (Array.isArray(source.education) ? source.education : []).filter((item) =>
    item && typeof item === 'object' && [item.degree, item.school, item.dates].some((value) => clean(value)));
  if (education.length) {
    const body = [];
    education.forEach((item, index) => {
      if (index > 0) body.push('');
      addEntry(body, [clean(item.degree), clean(item.school), clean(item.dates)]);
    });
    section('Education', body);
  }

  const skills = clean(source.skills);
  if (skills) section('Skills', [skills]);
  return lines.join('\n');

  function addEntry(body, values) {
    values.forEach((value) => { if (value) body.push(value); });
  }
}

function exportPdf() {
  setImportStatus('Preparing PDF export...');
  try {
    if (!window.jspdf?.jsPDF) {
      setImportStatus('PDF library unavailable. Use the print dialog to save as PDF.');
      window.print();
      return;
    }
    const unsupported = findUnsupportedChars(resumeData);
    const unsupportedNote = unsupported.length ? unsupportedExportNote(unsupported) : '';
    if (unsupportedNote) setImportStatus(unsupportedNote);

    const { jsPDF } = window.jspdf;
    const paperSize = document.querySelector('#paperSize').value === 'a4' ? 'a4' : 'letter';
    const textSize = document.querySelector('#textSize')?.value;
    const sizes = PDF_TEXT_SIZES[textSize] || PDF_TEXT_SIZES.standard;
    const doc = new jsPDF({ unit: 'pt', format: paperSize, compress: true });
    const pageWidth = doc.internal.pageSize.getWidth();
    const pageHeight = doc.internal.pageSize.getHeight();
    const margin = 44;
    const contentWidth = pageWidth - margin * 2;
    const ink = [29, 36, 33];
    let y = margin;
    const { basics, summary, experience, education, skills } = resumeData;
    const pdfDrawText = (value) => {
      let safe = '';
      for (const character of toPdfText(value)) safe += isWinAnsiChar(character) ? character : '?';
      return safe;
    };
    const ensureSpace = (height) => { if (y + height > pageHeight - margin) { doc.addPage(); y = margin; } };
    const writeLines = (text, size, options = {}) => {
      const value = pdfDrawText(text).trim();
      if (!value) return;
      doc.setFont('helvetica', options.bold ? 'bold' : 'normal');
      doc.setFontSize(size);
      doc.setTextColor(ink[0], ink[1], ink[2]);
      const lines = doc.splitTextToSize(value, Math.max(40, options.width || contentWidth));
      const leading = options.leading || size * 1.32;
      ensureSpace(lines.length * leading);
      doc.text(lines, options.x || margin, y);
      y += lines.length * leading;
    };
    const sectionHeading = (label) => {
      const size = sizes.heading;
      ensureSpace(size + 22);
      y += Math.max(8, size * 0.75);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(size);
      doc.setTextColor(35, 42, 39);
      doc.text(label.toUpperCase(), margin, y);
      y += 4;
      doc.setDrawColor(170, 178, 173);
      doc.setLineWidth(0.6);
      doc.line(margin, y, pageWidth - margin, y);
      y += Math.max(10, size);
    };
    const writeContact = (parts, size) => {
      const visible = parts.flatMap((part) => {
        const text = pdfDrawText(part.text).trim();
        return text ? [{ text, url: part.url || '' }] : [];
      });
      if (!visible.length) return false;
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(size);
      doc.setTextColor(ink[0], ink[1], ink[2]);
      const leading = size * 1.32;
      const separator = ' | ';
      const right = pageWidth - margin;
      ensureSpace(leading);
      let x = margin;
      const newline = () => { y += leading; x = margin; ensureSpace(leading); };
      visible.forEach((part, index) => {
        let pendingSeparator = index > 0;
        const chunks = doc.splitTextToSize(part.text, contentWidth);
        chunks.forEach((chunk, chunkIndex) => {
          const prefix = pendingSeparator ? separator : '';
          if (x > margin && x + doc.getTextWidth(prefix + chunk) > right + 0.1) newline();
          if (pendingSeparator && x > margin) {
            doc.text(separator, x, y);
            x += doc.getTextWidth(separator);
          }
          if (part.url) doc.textWithLink(chunk, x, y, { url: part.url });
          else doc.text(chunk, x, y);
          x += doc.getTextWidth(chunk);
          pendingSeparator = false;
          if (chunkIndex < chunks.length - 1) newline();
        });
      });
      y += leading;
      return true;
    };
    const drawDatedBlock = (primary, secondary, dates, primarySize, secondarySize) => {
      const primaryText = pdfDrawText(primary).trim();
      const secondaryText = pdfDrawText(secondary).trim();
      const dateText = pdfDrawText(dates).trim();
      if (!primaryText && !secondaryText && !dateText) return;
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(sizes.date);
      const dateWidth = dateText ? Math.min(doc.getTextWidth(dateText) + 14, contentWidth * 0.46) : 0;
      const measure = (text, size, bold, width) => {
        doc.setFont('helvetica', bold ? 'bold' : 'normal');
        doc.setFontSize(size);
        return doc.splitTextToSize(text, Math.max(40, width));
      };
      const primaryLines = primaryText ? measure(primaryText, primarySize, true, contentWidth - dateWidth) : [];
      const secondaryLines = secondaryText ? measure(secondaryText, secondarySize, false, primaryText ? contentWidth : contentWidth - dateWidth) : [];
      const primaryLeading = primarySize * 1.28;
      const secondaryLeading = secondarySize * 1.28;
      ensureSpace((primaryLines.length * primaryLeading) + (secondaryLines.length * secondaryLeading) + (dateText ? sizes.date : 0));
      const top = y;
      if (primaryLines.length) {
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(primarySize);
        doc.setTextColor(ink[0], ink[1], ink[2]);
        doc.text(primaryLines, margin, y);
        y += primaryLines.length * primaryLeading;
      }
      if (secondaryLines.length) {
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(secondarySize);
        doc.setTextColor(ink[0], ink[1], ink[2]);
        doc.text(secondaryLines, margin, y);
        y += secondaryLines.length * secondaryLeading;
      }
      if (dateText) {
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(sizes.date);
        doc.setTextColor(82, 91, 86);
        doc.text(dateText, pageWidth - margin, top, { align: 'right' });
        if (!primaryLines.length && !secondaryLines.length) y += sizes.date * 1.28;
        doc.setTextColor(ink[0], ink[1], ink[2]);
      }
    };

    doc.setTextColor(ink[0], ink[1], ink[2]);
    const name = pdfDrawText(basics.name).trim();
    const title = pdfDrawText(String(basics.title ?? '').toUpperCase()).trim();
    if (name) writeLines(name, sizes.name, { bold: true, leading: sizes.name * 1.15 });
    if (title) writeLines(title, sizes.title, { leading: sizes.title * 1.3 });
    const emailUrl = asciiLink(basics.email, 'mailto:');
    const websiteUrl = asciiWebLink(basics.website);
    const drewContact = writeContact([
      { text: basics.location },
      { text: basics.email, url: emailUrl },
      { text: basics.phone },
      { text: basics.website, url: websiteUrl }
    ], sizes.contact);
    if (name || title || drewContact) {
      y += 4;
      doc.setDrawColor(ink[0], ink[1], ink[2]);
      doc.setLineWidth(1.4);
      doc.line(margin, y, pageWidth - margin, y);
      y += 8;
    }
    if (pdfDrawText(summary).trim()) { sectionHeading('Professional Summary'); writeLines(summary, sizes.body); }
    const visibleExperience = experience.filter((item) => item.role || item.company || item.dates || item.highlights);
    if (visibleExperience.length) {
      sectionHeading('Experience');
      visibleExperience.forEach((item) => {
        drawDatedBlock(item.role, item.company, item.dates, sizes.role, sizes.meta);
        String(item.highlights ?? '').split(/\r\n|\r|\n/).forEach((bullet) => {
          const text = pdfDrawText(bullet).replace(/^[-*]\s+/, '').trim();
          if (text) writeLines(`- ${text}`, sizes.body, { x: margin + 12, width: contentWidth - 12 });
        });
        y += 6;
      });
    }
    const visibleEducation = education.filter((item) => item.degree || item.school || item.dates);
    if (visibleEducation.length) {
      sectionHeading('Education');
      visibleEducation.forEach((item) => {
        drawDatedBlock(item.degree, item.school, item.dates, sizes.role, sizes.meta);
        y += 4;
      });
    }
    if (pdfDrawText(skills).trim()) { sectionHeading('Skills'); writeLines(skills, sizes.body); }
    const metaName = name;
    doc.setProperties({
      title: metaName ? `${metaName} CV` : 'CV',
      author: metaName || 'State CV'
    });
    if (typeof doc.setLanguage === 'function') doc.setLanguage('en');
    const filename = `${safeFilename(document.querySelector('#exportFilename').value || basics.name || 'CV')}.pdf`;
    doc.save(filename);
    const downloadMessage = isIosDevice()
      ? 'PDF exported. If it opens, tap Share > Save to Files'
      : 'PDF exported. Download started.';
    setImportStatus(unsupportedNote ? `${downloadMessage} ${unsupportedNote}` : downloadMessage);
  } catch (error) {
    console.error('State CV could not export a PDF.', error);
    setImportStatus('PDF export failed. Please try again.', true);
  }
}

function asciiLink(value, prefix) {
  const text = String(value ?? '').trim();
  if (!text || /\s/.test(text) || /[^\u0020-\u007E]/.test(text)) return '';
  if (prefix === 'mailto:' && /^mailto:/i.test(text)) return text;
  if (/^[a-z][a-z0-9+.-]*:/i.test(text)) return '';
  return `${prefix}${text}`;
}

function asciiWebLink(value) {
  const text = String(value ?? '').trim();
  if (!text || /\s/.test(text) || /[^\u0020-\u007E]/.test(text)) return '';
  if (/^https?:\/\//i.test(text)) return text;
  if (/^[a-z][a-z0-9+.-]*:/i.test(text)) return '';
  return `https://${text}`;
}

function unsupportedExportNote(chars) {
  const shown = chars.slice(0, 24);
  const extra = chars.length > shown.length ? ` and ${chars.length - shown.length} more` : '';
  return `Some characters are not supported in the PDF and were replaced: ${shown.join(', ')}${extra}`;
}

function plainTextFilename() {
  return `${safeFilename(document.querySelector('#exportFilename').value || resumeData.basics.name || 'CV')}.txt`;
}

function savePlainTextFile(text) {
  const body = text && !String(text).endsWith('\n') ? `${text}\n` : String(text ?? '');
  downloadFile(new Blob([body], { type: 'text/plain;charset=utf-8' }), plainTextFilename());
}

function downloadPlainText() {
  savePlainTextFile(cvToPlainText(resumeData));
  setImportStatus('Plain text downloaded.');
}
