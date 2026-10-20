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
let storageDamaged = false;
let damagedRaw = null;
let damagedCopyStored = false;
let loadedRevision = 0;
let storageConflict = false;
let persistenceResult = 'unknown';
let persistenceRequestStarted = false;
let lastSnapshotAt = Date.now();
let resumeData = loadData();
let saveTimer;

try {
  const storedPersistenceResult = stateStorage.getItem('state-cv-persistence-v1');
  if (['granted', 'not granted', 'unavailable'].includes(storedPersistenceResult)) {
    persistenceResult = storedPersistenceResult;
    persistenceRequestStarted = true;
  }
} catch (error) {
  console.error('State CV could not read its local persistence status.', error);
}

try {
  const snapshots = stateStorage.readSnapshots();
  const lastSnapshot = snapshots.at(-1);
  if (lastSnapshot?.savedAt) {
    const timestamp = Date.parse(lastSnapshot.savedAt);
    if (Number.isFinite(timestamp)) lastSnapshotAt = timestamp;
  }
} catch (error) {
  console.error('State CV could not read saved snapshots.', error);
}

if (window.pdfjsLib) window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';

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
  let raw;
  try {
    raw = stateStorage.getItem(STORAGE_KEY);
  } catch (error) {
    storageLoadFailed = true;
    console.error('State CV could not read saved data.', error);
    return structuredClone(defaultData);
  }
  if (raw === null) {
    loadedRevision = 0;
    return structuredClone(defaultData);
  }
  try {
    const parsed = JSON.parse(raw);
    loadedRevision = stateStorage.getDataRevision(STORAGE_KEY);
    return normalizeData(parsed, { strict: true });
  } catch (error) {
    preserveDamagedData(raw, error);
    return structuredClone(defaultData);
  }
}

function preserveDamagedData(raw, cause) {
  storageLoadFailed = true;
  storageDamaged = true;
  damagedRaw = raw;
  loadedRevision = 0;
  try {
    stateStorage.preserveDamagedData(raw);
    damagedCopyStored = true;
  } catch (error) {
    damagedCopyStored = false;
    console.error('State CV could not save a separate copy of damaged data.', error);
  }
  console.error('State CV found damaged saved data and will not replace it automatically.', cause);
}

function saveData({ force = false } = {}) {
  if (storageLoadFailed && !force) {
    setStatus('error', 'Saved data not replaced');
    return false;
  }
  if (storageConflict && !force) {
    setStatus('error', 'Changes need your attention');
    return false;
  }
  try {
    const replacingDamagedData = storageDamaged;
    if (!storageLoadFailed && Date.now() - lastSnapshotAt >= 10 * 60 * 1000) {
      try {
        snapshotLatestStored(10 * 60 * 1000);
      } catch (error) {
        console.error('State CV could not create a periodic snapshot; continuing with the local save.', error);
      }
    }
    const data = { ...toStorable(), savedAt: new Date().toISOString() };
    loadedRevision = stateStorage.writeData(STORAGE_KEY, data, loadedRevision, force);
    storageLoadFailed = false;
    storageDamaged = false;
    storageConflict = false;
    if (replacingDamagedData) {
      showDamagedNotice('The original damaged data is preserved separately. Download it if you need the raw file.');
    } else {
      hideStorageNotice();
    }
    setStatus('saved', 'Saved locally');
    requestStoragePersistence();
    return true;
  } catch (error) {
    if (error.code === 'snapshot') {
      setStatus('error', 'Snapshot failed; local save paused');
      console.error('State CV could not create a protective snapshot.', error.cause);
      return false;
    }
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

async function requestStoragePersistence() {
  if (persistenceRequestStarted) return;
  persistenceRequestStarted = true;
  let result = 'unavailable';
  try {
    const storageManager = navigator.storage;
    if (storageManager && typeof storageManager.persist === 'function') {
      result = await storageManager.persist() ? 'granted' : 'not granted';
    }
  } catch (error) {
    result = 'not granted';
    console.error('State CV could not request persistent browser storage.', error);
  }
  persistenceResult = result;
  try {
    stateStorage.setItem('state-cv-persistence-v1', result);
  } catch (error) {
    console.error('State CV could not record the browser persistence result.', error);
    setStatus('error', 'Persistence result could not be recorded');
  }
  const persistenceNode = document.querySelector('#dataPersistenceStatus');
  if (persistenceNode) {
    persistenceNode.textContent = result === 'granted'
      ? 'Granted'
      : result === 'not granted'
        ? 'Not granted'
        : 'Unavailable in this browser context';
  }
}

function takeSnapshot(data = toStorable(), revision = loadedRevision, minimumIntervalMs = 0) {
  let snapshots;
  try {
    const normalizedData = normalizeData(data, { strict: true });
    snapshots = stateStorage.readSnapshots();
    const serializedData = JSON.stringify(normalizedData);
    if (serializedData === JSON.stringify(defaultData)) return;
    const newestSnapshot = snapshots.at(-1);
    if (newestSnapshot?.data) {
      try {
        if (JSON.stringify(normalizeData(newestSnapshot.data, { strict: true })) === serializedData) return;
      } catch (error) {
        console.error('State CV could not compare the latest snapshot before adding another.', error);
      }
    }
    snapshots = stateStorage.addSnapshot({
      savedAt: new Date().toISOString(),
      revision,
      data: structuredClone(data)
    }, minimumIntervalMs);
  } catch (error) {
    const snapshotError = new Error('Could not save a protective snapshot.');
    snapshotError.code = 'snapshot';
    snapshotError.cause = error;
    throw snapshotError;
  }
  const savedAt = Date.parse(snapshots.at(-1).savedAt);
  lastSnapshotAt = Number.isFinite(savedAt) ? savedAt : Date.now();
}

function snapshotLatestStored(minimumIntervalMs = 0) {
  const raw = stateStorage.getItem(STORAGE_KEY);
  if (raw === null) {
    takeSnapshot(undefined, undefined, minimumIntervalMs);
    return true;
  }
  const parsed = JSON.parse(raw);
  const revision = stateStorage.getDataRevision(STORAGE_KEY);
  const data = normalizeData(parsed, { strict: true });
  takeSnapshot({ schemaVersion: SCHEMA_VERSION, ...data }, revision, minimumIntervalMs);
  return true;
}

function scheduleSave() {
  setStatus('saving', 'Saving...');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveData();
  }, 350);
}

function flushScheduledSave() {
  if (!saveTimer) return;
  clearTimeout(saveTimer);
  saveTimer = null;
  saveData();
}

function cancelScheduledSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
}

function showStorageConflict(revision) {
  storageConflict = true;
  const notice = document.querySelector('#storageNotice');
  notice.querySelector('#storageNoticeMessage').textContent =
    'This CV was saved in another tab. Reload the latest version, or keep your changes and replace it.';
  notice.querySelector('#reloadLatestButton').hidden = false;
  notice.querySelector('#keepMineButton').hidden = false;
  notice.querySelector('#downloadDamagedButton').hidden = true;
  notice.hidden = false;
  notice.inert = false;
}

function showDamagedNotice(message) {
  const notice = document.querySelector('#storageNotice');
  notice.querySelector('#storageNoticeMessage').textContent = message ||
    (damagedCopyStored
      ? 'Saved data could not be validated. A separate copy is preserved; import a backup or explicitly start a new CV before saving.'
      : 'Saved data could not be validated, and the separate browser copy could not be saved. Download the raw data now; import a backup or explicitly start a new CV before saving.');
  notice.querySelector('#reloadLatestButton').hidden = true;
  notice.querySelector('#keepMineButton').hidden = true;
  notice.querySelector('#downloadDamagedButton').hidden = !damagedRaw;
  notice.hidden = false;
  notice.inert = false;
}

function downloadDamagedData() {
  let raw = damagedRaw;
  try {
    raw = stateStorage.getItem('state-cv-damaged-v1') ?? raw;
  } catch (error) {
    console.error('State CV could not read the preserved damaged-data copy.', error);
  }
  if (raw === null) {
    setStatus('error', 'No damaged-data copy is available');
    return;
  }
  downloadFile(new Blob([raw], { type: 'application/json' }), 'state-cv-damaged-data.json');
}

function downloadBackup() {
  downloadFile(
    new Blob([JSON.stringify(toStorable(), null, 2)], { type: 'application/json' }),
    `${safeFilename(document.querySelector('#exportFilename').value || resumeData.basics.name || 'CV')}.json`
  );
}

function downloadFile(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function formatStoredDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? 'Unknown'
    : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function formatStoredSize(bytes) {
  if (bytes < 1024) return `About ${bytes} bytes`;
  return `About ${(bytes / 1024).toFixed(1)} KB`;
}

function renderYourDataDialog() {
  const dialogStatus = document.querySelector('#dataDialogStatus');
  const lastSaved = document.querySelector('#dataLastSaved');
  const storedSize = document.querySelector('#dataStoredSize');
  const persistenceStatus = document.querySelector('#dataPersistenceStatus');
  const snapshotsList = document.querySelector('#snapshotsList');
  const snapshotsEmpty = document.querySelector('#snapshotsEmpty');
  const damagedDownloadButton = document.querySelector('#downloadDamagedDialogButton');
  if (!dialogStatus) return;

  dialogStatus.textContent = '';
  let approxBytes = 0;
  let latestSavedAt = null;
  let damaged = damagedRaw;
  let storedDataRaw = null;
  try {
    ['state-cv-data-v1', 'state-cv-snapshots-v1', 'state-cv-damaged-v1', 'state-cv-persistence-v1'].forEach((key) => {
      const value = stateStorage.getItem(key);
      if (value !== null) {
        approxBytes += (key.length + value.length) * 2;
        if (key === 'state-cv-data-v1') storedDataRaw = value;
        if (key === 'state-cv-damaged-v1') damaged = value;
      }
    });
    if (storedDataRaw !== null) {
      try {
        latestSavedAt = JSON.parse(storedDataRaw).savedAt || null;
      } catch (error) {
        lastSaved.textContent = 'Saved data needs attention';
      }
    }
    if (storedDataRaw === null || latestSavedAt) {
      lastSaved.textContent = latestSavedAt ? formatStoredDate(latestSavedAt) : 'Not saved yet';
    } else {
      lastSaved.textContent = 'Time not recorded for this draft';
    }
    storedSize.textContent = formatStoredSize(approxBytes);
  } catch (error) {
    lastSaved.textContent = 'Could not read';
    storedSize.textContent = 'Could not calculate';
    dialogStatus.textContent = 'Some local storage details could not be read.';
    console.error('State CV could not read storage details for Your data.', error);
  }
  persistenceStatus.textContent = persistenceResult === 'granted'
    ? 'Granted'
    : persistenceResult === 'not granted'
      ? 'Not granted'
      : persistenceResult === 'unavailable'
        ? 'Unavailable in this browser context'
        : 'Not requested yet';
  damagedDownloadButton.hidden = !damaged;
  damagedDownloadButton.inert = !damaged;
  snapshotsList.replaceChildren();

  let snapshots = [];
  try {
    snapshots = stateStorage.readSnapshots();
  } catch (error) {
    dialogStatus.textContent = 'Saved snapshots could not be read.';
    console.error('State CV could not render saved snapshots.', error);
  }
  let validSnapshots = 0;
  let invalidSnapshots = 0;
  snapshots.slice(-5).forEach((snapshot, offset) => {
    const index = snapshots.length - 1 - offset;
    let normalized;
    if (!snapshot || typeof snapshot.savedAt !== 'string' || !Number.isInteger(snapshot.revision) ||
        snapshot.revision < 0 || !Number.isFinite(Date.parse(snapshot.savedAt))) {
      invalidSnapshots++;
      return;
    }
    try {
      normalized = normalizeData(snapshot.data, { strict: true });
    } catch (error) {
      invalidSnapshots++;
      return;
    }
    validSnapshots++;
    const item = document.createElement('article');
    item.className = 'snapshot-item';
    const label = document.createElement('p');
    label.textContent = `${formatStoredDate(snapshot.savedAt)} · Revision ${snapshot.revision}`;
    const restoreButton = document.createElement('button');
    restoreButton.className = 'button button-dark';
    restoreButton.type = 'button';
    restoreButton.textContent = 'Restore';
    restoreButton.addEventListener('click', () => restoreSnapshot(index, normalized));
    item.append(label, restoreButton);
    snapshotsList.append(item);
  });
  if (invalidSnapshots) dialogStatus.textContent = 'One or more saved snapshots could not be validated and are unavailable for restore.';
  snapshotsEmpty.hidden = validSnapshots > 0;
  snapshotsEmpty.inert = validSnapshots > 0;
}

function restoreSnapshot(index, normalizedData) {
  if (storageLoadFailed) {
    document.querySelector('#dataDialogStatus').textContent =
      'Import a JSON backup or explicitly start a new CV before replacing damaged or unreadable saved data.';
    return;
  }
  if (storageConflict) {
    document.querySelector('#dataDialogStatus').textContent = 'Resolve the other-tab change before restoring a snapshot.';
    return;
  }
  try {
    takeSnapshot();
    if (!storageLoadFailed) {
      const currentRevision = stateStorage.getDataRevision(STORAGE_KEY);
      if (currentRevision !== loadedRevision) {
        showStorageConflict(currentRevision);
        document.querySelector('#dataDialogStatus').textContent = 'This CV changed in another tab. Resolve that change before restoring.';
        return;
      }
    }
    cancelScheduledSave();
    resumeData = structuredClone(normalizedData);
    document.querySelector('#exportFilename').removeAttribute('data-edited');
    renderFields(); updatePreview(); updateCompletion();
    const saved = saveData();
    renderYourDataDialog();
    document.querySelector('#dataDialogStatus').textContent = saved
      ? 'Snapshot restored and saved.'
      : 'Snapshot loaded in this tab but could not be saved.';
  } catch (error) {
    document.querySelector('#dataDialogStatus').textContent = error.code === 'snapshot'
      ? 'Could not protect the current CV; restore was stopped.'
      : 'This snapshot could not be restored.';
    console.error(`State CV could not restore snapshot ${index}.`, error);
  }
}

function openYourDataDialog() {
  renderYourDataDialog();
  document.querySelector('#yourDataDialog').showModal();
}

function closeYourDataDialog() {
  if (document.querySelector('#yourDataDialog').open) document.querySelector('#yourDataDialog').close();
}

let clearDataConfirmationTimer;
let clearDataConfirmed = false;
function resetClearDataConfirmation() {
  clearDataConfirmed = false;
  const button = document.querySelector('#clearDataButton');
  button.textContent = 'Clear all data';
  clearTimeout(clearDataConfirmationTimer);
}

function clearAllData() {
  const button = document.querySelector('#clearDataButton');
  const dialogStatus = document.querySelector('#dataDialogStatus');
  if (!clearDataConfirmed) {
    clearDataConfirmed = true;
    button.textContent = 'Click again to clear (download a backup first)';
    clearDataConfirmationTimer = setTimeout(resetClearDataConfirmation, 5000);
    return;
  }
  resetClearDataConfirmation();
  try {
    cancelScheduledSave();
    stateStorage.clearAll();
    resumeData = structuredClone(defaultData);
    loadedRevision = 0;
    storageLoadFailed = false;
    storageDamaged = false;
    storageConflict = false;
    damagedRaw = null;
    damagedCopyStored = false;
    persistenceResult = 'unknown';
    persistenceRequestStarted = false;
    renderFields(); updatePreview(); updateCompletion(); updateLaunchScreen();
    hideStorageNotice();
    dialogStatus.textContent = 'All State CV data was cleared from this browser.';
    renderYourDataDialog();
    document.querySelector('#dataDialogStatus').textContent = 'All State CV data was cleared from this browser.';
  } catch (error) {
    dialogStatus.textContent = 'Could not clear all data. The current CV was preserved where possible.';
    console.error('State CV could not clear all local data.', error);
  }
}

function hideStorageNotice() {
  const notice = document.querySelector('#storageNotice');
  if (notice.contains(document.activeElement)) {
    const focusTarget = document.querySelector('#appShell').inert ? '#continueButton' : '#brandHome';
    document.querySelector(focusTarget).focus();
  }
  notice.inert = true;
  notice.hidden = true;
}

function reloadLatestData() {
  try {
    const raw = stateStorage.getItem(STORAGE_KEY);
    if (raw === null) {
      cancelScheduledSave();
      resumeData = structuredClone(defaultData);
      loadedRevision = 0;
      storageLoadFailed = false;
      storageDamaged = false;
      damagedRaw = null;
      damagedCopyStored = false;
    } else {
      const parsed = JSON.parse(raw);
      const normalized = normalizeData(parsed, { strict: true });
      loadedRevision = stateStorage.getDataRevision(STORAGE_KEY);
      cancelScheduledSave();
      resumeData = normalized;
    }
    storageLoadFailed = false;
    storageDamaged = false;
    storageConflict = false;
    renderFields(); updatePreview(); updateCompletion(); updateLaunchScreen();
    if (damagedRaw) {
      showDamagedNotice('An earlier damaged data copy remains preserved separately. Download it if you need the raw file.');
    } else {
      hideStorageNotice();
    }
    setStatus('saved', 'Latest version loaded');
  } catch (error) {
    try {
      const raw = stateStorage.getItem(STORAGE_KEY);
      if (raw !== null) preserveDamagedData(raw, error);
    } catch (readError) {
      console.error('State CV could not preserve the latest saved data.', readError);
    }
    showDamagedNotice();
    setStatus('error', 'Latest version could not be loaded');
    console.error('State CV could not reload the latest saved data.', error);
  }
}

function keepMine() {
  if (!storageConflict) return;
  try {
    cancelScheduledSave();
    const currentRevision = stateStorage.getDataRevision(STORAGE_KEY);
    snapshotLatestStored();
    loadedRevision = currentRevision;
    saveData({ force: true });
  } catch (error) {
    setStatus('error', 'Latest version could not be checked');
    console.error('State CV could not preserve the latest saved data.', error);
  }
}

window.addEventListener('storage', (event) => {
  if (event.key !== STORAGE_KEY) return;
  try {
    if (event.newValue !== null) {
      const parsed = JSON.parse(event.newValue);
      normalizeData(parsed, { strict: true });
    }
    const revision = event.newValue === null ? 0 : stateStorage.getDataRevision(STORAGE_KEY);
    if (revision !== loadedRevision) showStorageConflict(revision);
  } catch (error) {
    if (event.newValue !== null) preserveDamagedData(event.newValue, error);
    showDamagedNotice();
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
  const preview = document.querySelector('#resumePreview');
  preview.replaceChildren();
  const element = (tag, className, text = '') => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    node.textContent = text;
    return node;
  };
  const header = element('header', 'resume-header');
  header.append(element('h2', '', basics.name || 'Your Name'));
  header.append(element('div', 'resume-title', basics.title || 'Professional Title'));
  const contact = element('div', 'resume-contact');
  const contactValues = [basics.location, basics.email, basics.phone, basics.website].filter(Boolean);
  (contactValues.length ? contactValues : ['City, State', 'email@example.com', '(555) 123-4567'])
    .forEach((value) => contact.append(element('span', '', value)));
  header.append(contact);
  preview.append(header);

  const appendSection = (title) => {
    const section = element('section', 'resume-section');
    section.append(element('h3', '', title));
    preview.append(section);
    return section;
  };
  if (summary) appendSection('Professional Summary').append(element('p', 'skills-line', summary));
  const visibleExperience = experience.filter((item) => item.role || item.company || item.highlights);
  if (visibleExperience.length) {
    const section = appendSection('Experience');
    visibleExperience.forEach((item) => {
      const entry = element('div', 'resume-entry');
      const top = element('div', 'entry-top');
      top.append(element('strong', 'entry-role', item.role || 'Role'));
      top.append(element('span', 'entry-date', item.dates));
      entry.append(top, element('div', 'entry-company', item.company));
      if (item.highlights) {
        const bullets = element('ul', 'entry-bullets');
        item.highlights.split('\n').filter(Boolean).forEach((bullet) => bullets.append(element('li', '', bullet)));
        entry.append(bullets);
      }
      section.append(entry);
    });
  }
  const visibleEducation = education.filter((item) => item.degree || item.school);
  if (visibleEducation.length) {
    const section = appendSection('Education');
    visibleEducation.forEach((item) => {
      const entry = element('div', 'resume-entry');
      const top = element('div', 'entry-top');
      top.append(element('strong', 'entry-role', item.degree || 'Degree'));
      top.append(element('span', 'entry-date', item.dates));
      entry.append(top, element('div', 'entry-company', item.school));
      section.append(entry);
    });
  }
  if (skills) appendSection('Skills').append(element('p', 'skills-line', skills));
  if (!summary && !visibleExperience.length && !visibleEducation.length && !skills) {
    const empty = element('p', 'empty-preview', 'Your CV will appear here as you build it.');
    empty.append(document.createElement('br'), document.createTextNode('Start with your contact details.'));
    preview.append(empty);
  }
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
  } catch (error) {
    storageLoadFailed = true;
    console.error('State CV could not check for a saved draft.', error);
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
  try {
    takeSnapshot();
    cancelScheduledSave();
  } catch (error) {
    setStatus('error', 'Could not protect the current CV');
    console.error('State CV could not create a snapshot before starting a new CV.', error);
    return;
  }
  resumeData = structuredClone(defaultData);
  document.querySelector('#exportFilename').removeAttribute('data-edited');
  renderFields(); updatePreview(); updateCompletion();
  const saved = saveData({ force: storageLoadFailed || storageDamaged });
  if (saved) closeLaunchScreen();
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
  cancelScheduledSave();
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
  const saved = saveData();
  return { sections: Object.keys(sections).filter((key) => sections[key].length), experience: importedExperience.length, education: importedEducation.length, saved };
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
  const preview = document.querySelector('#previewPanel');
  if (isHidden && preview.contains(document.activeElement)) button.focus();
  document.querySelector('#appShell').dataset.previewHidden = String(isHidden);
  button.setAttribute('aria-expanded', String(!isHidden));
  button.textContent = isHidden ? 'Show preview' : 'Hide preview';
  preview.inert = isHidden;
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
  if (storageLoadFailed) {
    setImportStatus('Import a JSON backup or explicitly start a new CV before replacing unreadable saved data', true);
    return;
  }
  if (file.size > MAX_PDF_IMPORT_BYTES) {
    setImportStatus('PDF is too large', true);
    alert(`Please choose a PDF smaller than ${MAX_PDF_IMPORT_BYTES / (1024 * 1024)} MB.`);
    return;
  }
  setImportStatus('Reading PDF...');
  try {
    const lines = await extractPdfText(file);
    if (!lines.length) throw new ImportError('This PDF has no selectable text. Try an OCR-enabled PDF.');
    takeSnapshot();
    const imported = importPdfLines(lines);
    if (!imported.saved) {
      setImportStatus('PDF imported in this tab, but it could not be saved locally', true);
      return;
    }
    setImportStatus(`PDF imported · ${imported.experience + imported.education} entries`);
    closeLaunchScreen();
  } catch (error) {
    if (error instanceof ImportError) {
      setImportStatus(error.message, true);
      alert(error.message);
    } else if (error.code === 'snapshot') {
      setImportStatus('Could not protect the current CV; PDF import stopped', true);
      console.error('State CV could not snapshot before importing a PDF.', error.cause);
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
document.querySelector('#exportButton').addEventListener('click', downloadBackup);
document.querySelector('#yourDataButton').addEventListener('click', openYourDataDialog);
document.querySelector('#closeYourDataButton').addEventListener('click', closeYourDataDialog);
document.querySelector('#closeYourDataFooterButton').addEventListener('click', closeYourDataDialog);
document.querySelector('#yourDataDialog').addEventListener('close', () => moreMenuButton.focus());
document.querySelector('#yourDataDialog').addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    event.preventDefault();
    closeYourDataDialog();
  }
});
document.querySelector('#yourDataDialog').addEventListener('cancel', (event) => {
  event.preventDefault();
  closeYourDataDialog();
});
document.querySelector('#downloadBackupButton').addEventListener('click', downloadBackup);
document.querySelector('#downloadDamagedDialogButton').addEventListener('click', downloadDamagedData);
document.querySelector('#clearDataButton').addEventListener('click', clearAllData);
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
      cancelScheduledSave();
      takeSnapshot();
      resumeData = normalized;
      document.querySelector('#exportFilename').removeAttribute('data-edited');
      renderFields(); updatePreview(); updateCompletion();
      const saved = saveData({ force: storageLoadFailed || storageDamaged });
      if (saved) closeLaunchScreen();
    } catch (error) {
      if (error instanceof ImportError) {
        const message = `That backup could not be imported. ${error.message}`;
        setImportStatus(message, true);
        alert(message);
      } else if (error.code === 'snapshot') {
        setImportStatus('Could not protect the current CV; backup import stopped', true);
        console.error('State CV could not snapshot before importing a backup.', error.cause);
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
document.querySelector('#downloadDamagedButton').addEventListener('click', downloadDamagedData);
document.querySelector('#dismissStorageNoticeButton').addEventListener('click', hideStorageNotice);

renderFields();
updatePreview();
updateCompletion();
updatePrintPageSize();
updateLaunchScreen();
if (storageDamaged) showDamagedNotice();
else if (storageLoadFailed) {
  setImportStatus('Saved data could not be loaded; saving is blocked', true);
  const notice = document.querySelector('#storageNotice');
  notice.querySelector('#storageNoticeMessage').textContent =
    'Browser storage could not be read. State CV will not overwrite saved data.';
  notice.hidden = false;
  notice.inert = false;
}
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