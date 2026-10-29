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

document.querySelectorAll('[data-path]').forEach((field) => field.addEventListener('input', () => { setValue(field.dataset.path, field.value); if (field.dataset.path === 'summary') updateSummaryCount(); updatePreview(); updateCompletion(); scheduleSave(); }));
document.querySelector('#addExperience').addEventListener('click', () => {
  if (resumeData.experience.length >= MAX_EXPERIENCE_ENTRIES) { setImportStatus(`Limit of ${MAX_EXPERIENCE_ENTRIES} entries reached`, true); return; }
  resumeData.experience.push({ role: '', company: '', dates: '', highlights: '' }); renderRepeaters(); updateCompletion(); scheduleSave();
});
document.querySelector('#addEducation').addEventListener('click', () => {
  if (resumeData.education.length >= MAX_EDUCATION_ENTRIES) { setImportStatus(`Limit of ${MAX_EDUCATION_ENTRIES} entries reached`, true); return; }
  resumeData.education.push({ degree: '', school: '', dates: '' }); renderRepeaters(); updateCompletion(); scheduleSave();
});
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
    if (hasSavedDraft() && !window.confirm('Importing will replace your current CV. A copy is kept in Your data > Recent snapshots. Continue?')) {
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
      if (hasSavedDraft() && !window.confirm('Importing will replace your current CV. A copy is kept in Your data > Recent snapshots. Continue?')) {
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