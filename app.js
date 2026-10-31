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
let storageWriteFailed = false;
let damagedRaw = null;
let damagedCopyStored = false;
let loadedRevision = 0;
let storageConflict = false;
let storageNoticeKind = null;
let storageUnavailableDismissed = false;
let serviceWorkerRegistration = null;
let waitingServiceWorker = null;
let updateNoticeDismissed = false;
let updateRequested = false;
let updateReloaded = false;
let appVersionRequestId = 0;
let persistenceResult = 'unknown';
let persistenceRequestStarted = false;
let lastSnapshotAt = Date.now();
let resumeData = loadData();
let saveTimer;
const BACKUP_REMINDER_KEY = 'state-cv-backup-reminder-v1';
const BACKUP_REMINDER_WEEK_MS = 7 * 24 * 60 * 60 * 1000;
let backupReminder = readBackupReminder();
let backupReminderDismissed = false;
let pendingEntryRemoval = null;
let undoToastTimer = null;

try {
  const storedPersistenceResult = stateStorage.getItem('state-cv-persistence-v1');
  if (['granted', 'not granted', 'unavailable'].includes(storedPersistenceResult)) {
    persistenceResult = storedPersistenceResult;
    persistenceRequestStarted = storedPersistenceResult === 'granted';
  }
} catch (error) {
  console.warn('State CV could not read its local persistence status.', error);
}

try {
  const snapshots = stateStorage.readSnapshots();
  const lastSnapshot = snapshots.at(-1);
  if (lastSnapshot?.savedAt) {
    const timestamp = Date.parse(lastSnapshot.savedAt);
    if (Number.isFinite(timestamp)) lastSnapshotAt = timestamp;
  }
} catch (error) {
  console.warn('State CV could not read saved snapshots.', error);
}

if (window.pdfjsLib) window.pdfjsLib.GlobalWorkerOptions.workerSrc = '../vendor/pdf.worker.min.js';

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
    console.warn('State CV could not read saved data.', error);
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
    console.warn('State CV could not save a separate copy of damaged data.', error);
  }
  console.warn('State CV found damaged saved data and will not replace it automatically.', cause);
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
    storageWriteFailed = false;
    storageConflict = false;
    if (replacingDamagedData) {
      showDamagedNotice('The original damaged data is preserved separately. Download it if you need the raw file.');
    } else if (storageNoticeKind === 'unavailable') {
      hideStorageNotice();
    }
    setStatus('saved', 'Saved locally');
    requestStoragePersistence();
    noteBackupReminderEdit();
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
    storageWriteFailed = true;
    showStorageUnavailableNotice('Browser storage could not be written. Changes are not being saved.');
    setStatus('error', 'Not saving: storage unavailable');
    updateBackupReminderNotice();
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

async function updateLivePersistenceStatus(statusNode) {
  try {
    const storageManager = navigator.storage;
    if (!storageManager || typeof storageManager.persisted !== 'function') {
      statusNode.textContent = 'Unavailable';
      return;
    }
    statusNode.textContent = await storageManager.persisted() ? 'Persistent' : 'Not persistent';
  } catch (error) {
    statusNode.textContent = 'Unavailable';
    console.error('State CV could not read the current browser persistence status.', error);
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
  if (!saveTimer) return true;
  clearTimeout(saveTimer);
  saveTimer = null;
  return saveData();
}

function cancelScheduledSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
}

function showStorageConflict(revision) {
  storageConflict = true;
  storageNoticeKind = 'conflict';
  const notice = document.querySelector('#storageNotice');
  notice.querySelector('#storageNoticeMessage').textContent =
    'This CV was saved in another tab. Reload the latest version, or keep your changes and replace it.';
  notice.querySelector('#reloadLatestButton').hidden = false;
  notice.querySelector('#keepMineButton').hidden = false;
  notice.querySelector('#downloadDamagedButton').hidden = true;
  notice.querySelector('#dismissStorageNoticeButton').hidden = true;
  notice.querySelector('#dismissStorageNoticeButton').inert = true;
  notice.hidden = false;
  notice.inert = false;
  updateUpdateButtonState();
  updateStickyOffsets();
}

function showDamagedNotice(message) {
  storageNoticeKind = 'damaged';
  const notice = document.querySelector('#storageNotice');
  notice.querySelector('#storageNoticeMessage').textContent = message ||
    (damagedCopyStored
      ? 'Saved data could not be validated. A separate copy is preserved; import a backup or explicitly start a new CV before saving.'
      : 'Saved data could not be validated, and the separate browser copy could not be saved. Download the raw data now; import a backup or explicitly start a new CV before saving.');
  notice.querySelector('#reloadLatestButton').hidden = true;
  notice.querySelector('#keepMineButton').hidden = true;
  notice.querySelector('#downloadDamagedButton').hidden = !damagedRaw;
  notice.querySelector('#dismissStorageNoticeButton').hidden = false;
  notice.querySelector('#dismissStorageNoticeButton').inert = false;
  notice.hidden = false;
  notice.inert = false;
  updateUpdateButtonState();
  updateStickyOffsets();
}

function showStorageUnavailableNotice(message) {
  if (storageUnavailableDismissed) return;
  storageNoticeKind = 'unavailable';
  const notice = document.querySelector('#storageNotice');
  notice.querySelector('#storageNoticeMessage').textContent = message ||
    'Browser storage could not be read. State CV will not overwrite saved data.';
  notice.querySelector('#reloadLatestButton').hidden = true;
  notice.querySelector('#reloadLatestButton').inert = true;
  notice.querySelector('#keepMineButton').hidden = true;
  notice.querySelector('#keepMineButton').inert = true;
  notice.querySelector('#downloadDamagedButton').hidden = true;
  notice.querySelector('#downloadDamagedButton').inert = true;
  notice.querySelector('#dismissStorageNoticeButton').hidden = false;
  notice.querySelector('#dismissStorageNoticeButton').inert = false;
  notice.hidden = false;
  notice.inert = false;
  updateUpdateButtonState();
  updateStickyOffsets();
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

function finiteReminderNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function readBackupReminder() {
  try {
    const raw = localStorage.getItem(BACKUP_REMINDER_KEY);
    if (!raw) return { lastBackupAt: 0, editsSinceBackup: 0, snoozeUntil: 0 };
    const parsed = JSON.parse(raw);
    const source = parsed && typeof parsed === 'object' ? parsed : {};
    return {
      lastBackupAt: finiteReminderNumber(source.lastBackupAt),
      editsSinceBackup: finiteReminderNumber(source.editsSinceBackup),
      snoozeUntil: finiteReminderNumber(source.snoozeUntil)
    };
  } catch (error) {
    console.warn('State CV could not read the backup reminder.', error);
    return { lastBackupAt: 0, editsSinceBackup: 0, snoozeUntil: 0 };
  }
}

function writeBackupReminder(state) {
  try {
    localStorage.setItem(BACKUP_REMINDER_KEY, JSON.stringify({
      lastBackupAt: finiteReminderNumber(state && state.lastBackupAt),
      editsSinceBackup: finiteReminderNumber(state && state.editsSinceBackup),
      snoozeUntil: finiteReminderNumber(state && state.snoozeUntil)
    }));
  } catch (error) {
    console.warn('State CV could not save the backup reminder.', error);
  }
}

function noteBackupReminderEdit() {
  try {
    backupReminder.editsSinceBackup = finiteReminderNumber(backupReminder.editsSinceBackup) + 1;
    writeBackupReminder(backupReminder);
    updateBackupReminderNotice();
  } catch (error) {
    console.warn('State CV could not update the backup reminder.', error);
  }
}

function updateBackupReminderNotice() {
  if (backupReminderDismissed || storageDamaged || storageLoadFailed || storageWriteFailed ||
      !shouldRemindBackup(backupReminder, Date.now())) {
    hideBackupReminder();
    return;
  }
  const notice = document.querySelector('#backupReminder');
  if (!notice) return;
  notice.hidden = false;
  notice.inert = false;
  updateStickyOffsets();
}

function hideBackupReminder() {
  const notice = document.querySelector('#backupReminder');
  if (!notice || notice.hidden) return;
  if (notice.contains(document.activeElement)) {
    const focusTarget = document.querySelector('#appShell').inert ? '#continueButton' : '#brandHome';
    document.querySelector(focusTarget).focus();
  }
  notice.inert = true;
  notice.hidden = true;
  updateStickyOffsets();
}

function isBlankPlaceholder(listName, record) {
  if (!record || typeof record !== 'object') return false;
  const keys = listName === 'experience'
    ? ['role', 'company', 'dates', 'highlights']
    : ['degree', 'school', 'dates'];
  return keys.every((key) => record[key] === '');
}

function isBlankCv(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
  const blankText = (value) => typeof value === 'string' && value.trim() === '';
  const basics = data.basics && typeof data.basics === 'object' && !Array.isArray(data.basics) ? data.basics : {};
  const recordsBlank = (records, keys) => {
    if (records === undefined) return true;
    if (!Array.isArray(records)) return false;
    return records.every((record) => record && typeof record === 'object' && !Array.isArray(record) &&
      keys.every((key) => blankText(record[key])));
  };
  return ['name', 'title', 'location', 'email', 'phone', 'website'].every((key) => blankText(basics[key]))
    && blankText(data.exportName)
    && blankText(data.summary)
    && blankText(data.skills)
    && recordsBlank(data.experience, ['role', 'company', 'dates', 'highlights'])
    && recordsBlank(data.education, ['degree', 'school', 'dates']);
}

function showUndoToast(listName) {
  const toast = document.querySelector('#undoToast');
  const message = document.querySelector('#undoToastMessage');
  if (!toast || !message) return;
  message.textContent = listName === 'education' ? 'Education entry removed' : 'Experience entry removed';
  clearTimeout(undoToastTimer);
  toast.hidden = false;
  toast.inert = false;
  undoToastTimer = setTimeout(hideUndoToast, 8000);
}

function dismissUndoToast({ restoreFocus = false } = {}) {
  clearTimeout(undoToastTimer);
  undoToastTimer = null;
  const toast = document.querySelector('#undoToast');
  if (!toast) return;
  const returnFocus = restoreFocus && toast.contains(document.activeElement);
  toast.inert = true;
  toast.hidden = true;
  if (returnFocus) {
    const focusTarget = document.querySelector('#appShell').inert ? '#continueButton' : '#brandHome';
    document.querySelector(focusTarget).focus();
  }
}

function hideUndoToast() {
  pendingEntryRemoval = null;
  dismissUndoToast({ restoreFocus: true });
}

function undoEntryRemoval() {
  const pending = pendingEntryRemoval;
  const items = pending && resumeData[pending.list];
  if (!pending || !Array.isArray(items)) return;
  const replacePlaceholder = pending.placeholderAdded && items.length === 1 && isBlankPlaceholder(pending.list, items[0]);
  const maxEntries = pending.list === 'experience' ? MAX_EXPERIENCE_ENTRIES : MAX_EDUCATION_ENTRIES;
  if (!replacePlaceholder && items.length >= maxEntries) {
    setStatus('error', `Limit of ${maxEntries} entries reached`);
    return;
  }
  pendingEntryRemoval = null;
  dismissUndoToast();
  let restoredIndex = 0;
  if (replacePlaceholder) {
    items[0] = structuredClone(pending.item);
  } else {
    restoredIndex = Math.min(Math.max(pending.index, 0), items.length);
    items.splice(restoredIndex, 0, structuredClone(pending.item));
  }
  renderRepeaters();
  updatePreview();
  updateCompletion();
  scheduleSave();
  const listId = pending.list === 'experience' ? 'experienceList' : 'educationList';
  const entry = document.querySelectorAll(`#${listId} .repeat-item`)[restoredIndex];
  const field = entry ? entry.querySelector('input, textarea') : null;
  if (field) field.focus();
}

function shouldRemindBackup(state, now) {
  const source = state && typeof state === 'object' ? state : {};
  const asNumber = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
  const editsSinceBackup = asNumber(source.editsSinceBackup);
  const lastBackupAt = asNumber(source.lastBackupAt);
  const snoozeUntil = asNumber(source.snoozeUntil);
  const currentTime = asNumber(now);
  const weekMs = 7 * 24 * 60 * 60 * 1000;
  const noBackupYet = lastBackupAt <= 0;
  const backupIsOld = lastBackupAt > 0 && currentTime - lastBackupAt > weekMs;
  return editsSinceBackup >= 20 && (noBackupYet || backupIsOld) && currentTime >= snoozeUntil;
}

function downloadBackup() {
  downloadFile(
    new Blob([JSON.stringify(toStorable(), null, 2)], { type: 'application/json' }),
    `${safeFilename(document.querySelector('#exportFilename').value || resumeData.basics.name || 'CV')}.json`
  );
  backupReminder.lastBackupAt = Date.now();
  backupReminder.editsSinceBackup = 0;
  writeBackupReminder(backupReminder);
  updateBackupReminderNotice();
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
  const livePersistenceStatus = document.querySelector('#dataLivePersistenceStatus');
  const appVersion = document.querySelector('#dataAppVersion');
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
  livePersistenceStatus.textContent = 'Checking…';
  updateLivePersistenceStatus(livePersistenceStatus);
  updateAppVersion(appVersion);
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
    hideUndoToast();
    resumeData = structuredClone(normalizedData);
    document.querySelector('#exportFilename').removeAttribute('data-edited');
    renderFields(); updatePreview(); updateCompletion();
    const saved = saveData({ force: storageLoadFailed || storageDamaged });
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

let dataDialogReturnFocus = null;
function openYourDataDialog() {
  renderYourDataDialog();
  const dialog = document.querySelector('#yourDataDialog');
  const opener = document.activeElement;
  dataDialogReturnFocus = opener instanceof HTMLElement && opener.closest('.more-menu')
    ? document.querySelector('.more-menu summary')
    : opener;
  dialog.showModal();
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
    storageWriteFailed = false;
    storageConflict = false;
    damagedRaw = null;
    damagedCopyStored = false;
    persistenceResult = 'unknown';
    persistenceRequestStarted = false;
    backupReminder = { lastBackupAt: 0, editsSinceBackup: 0, snoozeUntil: 0 };
    backupReminderDismissed = false;
    try {
      localStorage.removeItem(BACKUP_REMINDER_KEY);
    } catch (error) {
      console.warn('State CV could not clear the backup reminder.', error);
    }
    hideUndoToast();
    hideBackupReminder();
    renderFields(); updatePreview(); updateCompletion(); updateLaunchScreen();
    hideStorageNotice();
    setStatus('saved', 'No saved draft');
    dialogStatus.textContent = 'All State CV data was cleared from this browser.';
    renderYourDataDialog();
    document.querySelector('#dataDialogStatus').textContent = 'All State CV data was cleared from this browser.';
  } catch (error) {
    dialogStatus.textContent = 'Could not clear all data. The current CV was preserved where possible.';
    console.error('State CV could not clear all local data.', error);
  }
}

function hideStorageNotice({ dismissed = false } = {}) {
  const notice = document.querySelector('#storageNotice');
  if (dismissed && storageNoticeKind === 'unavailable') storageUnavailableDismissed = true;
  storageNoticeKind = null;
  if (notice.contains(document.activeElement)) {
    const focusTarget = document.querySelector('#appShell').inert ? '#continueButton' : '#brandHome';
    document.querySelector(focusTarget).focus();
  }
  notice.inert = true;
  notice.hidden = true;
  updateStickyOffsets();
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
      storageWriteFailed = false;
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
    storageWriteFailed = false;
    storageConflict = false;
    hideUndoToast();
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
    if (saveData({ force: true })) hideStorageNotice();
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
  const entryType = listId === 'experienceList' ? 'experience' : 'education';
  list.replaceChildren();
  items.forEach((item, index) => {
    const node = document.querySelector(`#${templateId}`).content.cloneNode(true);
    node.querySelectorAll('[data-key]').forEach((field) => {
      field.value = item[field.dataset.key] || '';
      field.addEventListener('input', () => { item[field.dataset.key] = field.value; updatePreview(); updateCompletion(); scheduleSave(); });
    });
    const removeButton = node.querySelector('.remove-item');
    removeButton.setAttribute('aria-label', `Remove ${entryType} entry ${index + 1}`);
    removeButton.title = `Remove ${entryType} entry ${index + 1}`;
    removeButton.addEventListener('click', () => {
      const removed = {
        item: structuredClone(item),
        index,
        list: entryType,
        placeholderAdded: false
      };
      items.splice(index, 1);
      if (!items.length) {
        items.push(createBlankRecord());
        removed.placeholderAdded = true;
      }
      pendingEntryRemoval = removed;
      renderRepeaters(); updatePreview(); updateCompletion(); scheduleSave();
      showUndoToast(entryType);
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
  renderAtsTips();
}

function renderAtsTips() {
  const tips = getAtsTips(resumeData);
  const count = document.querySelector('#atsTipsCount');
  if (count) count.textContent = `(${tips.length})`;
  const list = document.querySelector('#atsTipsList');
  if (!list) return;
  list.replaceChildren();
  (tips.length ? tips : ['No ATS issues found.']).forEach((message) => {
    const item = document.createElement('li');
    item.textContent = message;
    list.append(item);
  });
}

function setStatus(state, message) {
  if (state !== 'error' && storageDamaged) {
    state = 'error';
    message = 'Not saving: damaged data';
  } else if (state !== 'error' && (storageLoadFailed || storageWriteFailed)) {
    state = 'error';
    message = 'Not saving: storage unavailable';
  }
  const status = document.querySelector('#saveStatus');
  status.className = `save-status ${state}`;
  const dot = document.createElement('span');
  dot.className = 'status-dot';
  status.replaceChildren(dot, document.createTextNode(message));
  updateUpdateButtonState();
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
    console.warn('State CV could not check for a saved draft.', error);
    return false;
  }
}

function confirmReplacingSavedCv() {
  const unreadableMessage = 'Importing will replace the saved CV data on this device. It could not be read, so no snapshot copy is available. Continue?';
  const savedMessage = 'Importing will replace your current CV. A copy is kept in Your data > Recent snapshots. Continue?';
  if (storageLoadFailed) return window.confirm(unreadableMessage);
  let raw;
  try {
    raw = stateStorage.getItem(STORAGE_KEY);
  } catch (error) {
    storageLoadFailed = true;
    console.warn('State CV could not check for a saved draft.', error);
    return window.confirm(unreadableMessage);
  }
  if (raw === null) return true;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return window.confirm(unreadableMessage);
  }
  try {
    if (isBlankCv(normalizeData(parsed, { strict: true }))) return true;
  } catch (error) {
    return window.confirm(unreadableMessage);
  }
  return window.confirm(savedMessage);
}

function updateLaunchScreen() {
  const hasDraft = hasSavedDraft();
  const name = resumeData.basics.name.trim();
  document.querySelector('#continueLabel').textContent = hasDraft ? `Continue ${name || 'your CV'}` : 'Continue your CV';
  document.querySelector('#continueMeta').textContent = storageDamaged
    ? 'Saved data needs attention'
    : hasDraft
      ? 'Saved locally'
      : 'No saved draft yet';
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
  hideUndoToast();
  resumeData = structuredClone(defaultData);
  document.querySelector('#exportFilename').removeAttribute('data-edited');
  renderFields(); updatePreview(); updateCompletion();
  const saved = saveData({ force: storageLoadFailed || storageDamaged });
  if (saved) closeLaunchScreen();
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

async function copyPlainText() {
  const text = cvToPlainText(resumeData);
  try {
    if (!navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') {
      throw new Error('Clipboard is unavailable.');
    }
    await navigator.clipboard.writeText(text);
    setImportStatus('Plain text copied.');
  } catch (error) {
    savePlainTextFile(text);
    setImportStatus('Clipboard blocked. Plain text downloaded.');
    console.error('State CV could not copy plain text and downloaded it instead.', error);
  }
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
function applyPreviewTextSize(size = document.querySelector('#textSize')?.value) {
  const preview = document.querySelector('#resumePreview');
  if (!preview) return;
  const normalized = Object.hasOwn(PDF_TEXT_SIZES, size) ? size : 'standard';
  preview.classList.remove('preview-text-compact', 'preview-text-standard', 'preview-text-large');
  preview.classList.add(`preview-text-${normalized}`);
}
document.querySelector('#paperSize').addEventListener('change', (event) => updatePrintPageSize(event.target.value));
document.querySelector('#textSize').addEventListener('change', (event) => applyPreviewTextSize(event.target.value));
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
    if (!confirmReplacingSavedCv()) {
      setImportStatus('Import cancelled');
      document.querySelector('#pdfInput').value = '';
      document.querySelector('#importInput').value = '';
      return;
    }
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
document.querySelector('#copyPlainTextButton').addEventListener('click', copyPlainText);
document.querySelector('#downloadPlainTextButton').addEventListener('click', downloadPlainText);
document.querySelector('#yourDataButton').addEventListener('click', openYourDataDialog);
document.querySelector('#closeYourDataButton').addEventListener('click', closeYourDataDialog);
document.querySelector('#closeYourDataFooterButton').addEventListener('click', closeYourDataDialog);
document.querySelector('#yourDataDialog').addEventListener('close', () => {
  if (dataDialogReturnFocus instanceof HTMLElement && dataDialogReturnFocus.isConnected) dataDialogReturnFocus.focus();
  dataDialogReturnFocus = null;
});
document.querySelector('#yourDataDialog').addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    event.preventDefault();
    closeYourDataDialog();
    return;
  }
  if (event.key === 'Tab') {
    const dialog = event.currentTarget;
    const focusable = [...dialog.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')]
      .filter((element) => !element.hidden && !element.closest('[hidden], [inert]') && element.getClientRects().length);
    if (!focusable.length) {
      event.preventDefault();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) {
      event.preventDefault();
      first.focus();
    }
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
      if (!confirmReplacingSavedCv()) {
        setImportStatus('Import cancelled');
        event.target.value = '';
        return;
      }
      cancelScheduledSave();
      takeSnapshot();
      hideUndoToast();
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
document.querySelector('#dismissStorageNoticeButton').addEventListener('click', () => hideStorageNotice({ dismissed: true }));
document.querySelector('#undoRemovalButton').addEventListener('click', undoEntryRemoval);
document.querySelector('#backupReminderDownload').addEventListener('click', () => {
  downloadBackup();
  hideBackupReminder();
});
document.querySelector('#backupReminderLater').addEventListener('click', () => {
  backupReminderDismissed = true;
  hideBackupReminder();
});
document.querySelector('#backupReminderSnooze').addEventListener('click', () => {
  backupReminder.snoozeUntil = Date.now() + BACKUP_REMINDER_WEEK_MS;
  writeBackupReminder(backupReminder);
  hideBackupReminder();
});

renderFields();
updatePreview();
updateCompletion();
updatePrintPageSize();
applyPreviewTextSize();
updateLaunchScreen();
if (storageDamaged) {
  showDamagedNotice();
  setStatus('error', 'Not saving: damaged data');
}
else if (storageLoadFailed) {
  showStorageUnavailableNotice();
  setImportStatus('Saved data could not be loaded; saving is blocked', true);
}
updateBackupReminderNotice();
if (persistenceResult !== 'granted' && hasSavedDraft()) requestStoragePersistence();
document.querySelector('#brandHome').addEventListener('click', (event) => { event.preventDefault(); openLaunchScreen(); });
document.querySelector('#continueButton').addEventListener('click', closeLaunchScreen);
document.querySelector('#newCvButton').addEventListener('click', () => {
  startNewCv({ confirmReplacement: hasSavedDraft() });
});
document.querySelector('#startNewCvButton').addEventListener('click', startNewCv);
document.querySelector('#launchImportButton').addEventListener('click', () => document.querySelector('#pdfInput').click());

function updateUpdateButtonState() {
  const button = document.querySelector('#applyUpdateButton');
  if (!button) return;
  const blocked = storageConflict || storageLoadFailed || storageDamaged || storageWriteFailed;
  button.disabled = blocked || !waitingServiceWorker;
  button.inert = blocked || !waitingServiceWorker;
  const hint = document.querySelector('#updateBlockedHint');
  hint.hidden = !blocked;
  hint.inert = !blocked;
}

function showUpdateNotice(worker) {
  if (!worker || updateNoticeDismissed) return;
  waitingServiceWorker = worker;
  const notice = document.querySelector('#updateNotice');
  notice.hidden = false;
  notice.inert = false;
  updateUpdateButtonState();
  updateStickyOffsets();
}

function observeInstallingWorker(registration, worker) {
  if (!worker) return;
  worker.addEventListener('statechange', () => {
    if (worker.state === 'installed' && navigator.serviceWorker.controller) {
      showUpdateNotice(registration.waiting || worker);
    }
  });
}

function refreshServiceWorker() {
  if (!serviceWorkerRegistration) return;
  serviceWorkerRegistration.update().catch((error) => {
    console.error('State CV could not check for an app update.', error);
  });
}

async function updateAppVersion(versionNode) {
  const requestId = ++appVersionRequestId;
  versionNode.textContent = 'Checking…';
  if (!('serviceWorker' in navigator) || !/^https?:$/.test(window.location.protocol) ||
      typeof MessageChannel !== 'function') {
    versionNode.textContent = 'Not available';
    return;
  }

  const startedAt = Date.now();
  let channel;
  try {
    let worker = navigator.serviceWorker.controller || serviceWorkerRegistration?.active;
    if (!worker) {
      const registration = await Promise.race([
        navigator.serviceWorker.ready,
        new Promise((resolve) => setTimeout(() => resolve(null), 500))
      ]);
      worker = registration?.active || navigator.serviceWorker.controller;
    }
    const remaining = 1000 - (Date.now() - startedAt);
    if (!worker || remaining <= 0) {
      if (requestId === appVersionRequestId) versionNode.textContent = 'Not available';
      return;
    }

    channel = new MessageChannel();
    const version = await new Promise((resolve) => {
      const timeout = setTimeout(() => resolve(null), remaining);
      channel.port1.onmessage = (event) => {
        clearTimeout(timeout);
        resolve(event.data);
      };
      worker.postMessage({ type: 'GET_VERSION' }, [channel.port2]);
    });
    if (requestId === appVersionRequestId) {
      versionNode.textContent = typeof version === 'string' && version.startsWith('state-cv-cache-')
        ? version
        : 'Not available';
    }
  } catch (error) {
    if (requestId === appVersionRequestId) versionNode.textContent = 'Not available';
    console.error('State CV could not read the app version from its service worker.', error);
  } finally {
    if (channel) channel.port1.close();
  }
}

document.querySelector('#applyUpdateButton').addEventListener('click', () => {
  if (!waitingServiceWorker || storageConflict || storageLoadFailed || storageDamaged || storageWriteFailed) return;
  if (!flushScheduledSave()) return;
  updateRequested = true;
  document.querySelector('#applyUpdateButton').disabled = true;
  try {
    waitingServiceWorker.postMessage({ type: 'SKIP_WAITING' });
  } catch (error) {
    updateRequested = false;
    updateUpdateButtonState();
    console.error('State CV could not apply the waiting app update.', error);
  }
});
document.querySelector('#laterUpdateButton').addEventListener('click', () => {
  updateNoticeDismissed = true;
  const notice = document.querySelector('#updateNotice');
  notice.inert = true;
  notice.hidden = true;
  updateStickyOffsets();
});

if ('serviceWorker' in navigator && /^https?:$/.test(window.location.protocol)) {
  navigator.serviceWorker.register('../sw.js', { scope: '../', updateViaCache: 'none' }).then((registration) => {
    serviceWorkerRegistration = registration;
    if (registration.waiting && navigator.serviceWorker.controller) showUpdateNotice(registration.waiting);
    registration.addEventListener('updatefound', () => {
      observeInstallingWorker(registration, registration.installing);
    });
    observeInstallingWorker(registration, registration.installing);
  }).catch((error) => {
    console.error('State CV could not enable offline support.', error);
  });
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!updateRequested || updateReloaded) return;
    updateReloaded = true;
    window.location.reload();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refreshServiceWorker();
  });
  window.addEventListener('online', refreshServiceWorker);
}

function updateStickyOffsets() {
  const root = document.documentElement;
  const noticeStack = document.querySelector('#noticeStack');
  const topbar = document.querySelector('.topbar');
  root.style.setProperty('--notice-height', `${noticeStack.getBoundingClientRect().height}px`);
  root.style.setProperty('--topbar-height', `${topbar.getBoundingClientRect().height}px`);
}

updateStickyOffsets();
if (typeof ResizeObserver === 'function') {
  const stickyOffsetObserver = new ResizeObserver(updateStickyOffsets);
  stickyOffsetObserver.observe(document.querySelector('#noticeStack'));
  stickyOffsetObserver.observe(document.querySelector('.topbar'));
} else {
  window.addEventListener('resize', updateStickyOffsets);
}