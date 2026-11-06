const STORAGE_KEY = 'state-cv-data-v1';
const APP_NAME = 'State CV';
const SCHEMA_VERSION = 2;
const PREMIGRATION_KEY = 'state-cv-premigration-v1';
const MAX_PDF_IMPORT_BYTES = 10 * 1024 * 1024;
const MAX_JSON_IMPORT_BYTES = 2 * 1024 * 1024;
const MAX_EXPERIENCE_ENTRIES = 30;
const MAX_EDUCATION_ENTRIES = 20;
const MAX_VERSIONS = 50;
const ENTRY_ID_PATTERN = /^[A-Za-z0-9_-]{1,80}$/;
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
  experience: [blankExperience()],
  education: [blankEducation()],
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
let pendingV1Raw = null;
let cvVersions = [];
let activeVersionId = null;
let pendingEntryRemoval = null;
let resumeData = loadData();
migratePendingV1();
let saveTimer;
const BACKUP_REMINDER_KEY = 'state-cv-backup-reminder-v1';
const BACKUP_REMINDER_WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const BACKUP_REMINDER_LATER_MS = 30 * 24 * 60 * 60 * 1000;
let backupReminder = readBackupReminder();
let pdfExportNeedsBackupReminder = false;
let pendingVersionRemoval = null;
let undoToastTimer = null;
let actionToastTimer = null;
let tailorMode = false;
let versionSheetOpen = false;
const entryExpanded = { experience: [], education: [] };

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

function createEntryId(prefix) {
  const random = typeof crypto !== 'undefined' && crypto && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  return `${prefix}${random}`;
}

function assignEntryIds(records, prefix, makeId) {
  const seen = new Set();
  const makeUniqueId = () => {
    let id = '';
    for (let attempt = 0; attempt < 8; attempt += 1) {
      id = String(makeId(prefix) ?? '');
      if (id && !seen.has(id)) return id;
    }
    let extra = seen.size + 1;
    do {
      id = `${prefix}id${extra}`;
      extra += 1;
    } while (!id || seen.has(id));
    return id;
  };
  return (Array.isArray(records) ? records : []).map((record) => {
    const source = record && typeof record === 'object' && !Array.isArray(record) ? record : {};
    const next = { ...source };
    const current = source.id;
    const reusable = typeof current === 'string' && ENTRY_ID_PATTERN.test(current) && !seen.has(current);
    const id = reusable ? current : makeUniqueId();
    seen.add(id);
    next.id = id;
    return next;
  });
}

function blankExperience() {
  return { id: createEntryId('exp_'), role: '', company: '', dates: '', highlights: '' };
}

function blankEducation() {
  return { id: createEntryId('edu_'), degree: '', school: '', dates: '' };
}

function freshResumeData() {
  const data = structuredClone(defaultData);
  data.experience = [blankExperience()];
  data.education = [blankEducation()];
  return data;
}

function normalizeData(data, { strict = false, makeId = createEntryId } = {}) {
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
  const isCurrentSchema = Object.hasOwn(data, 'schemaVersion') && data.schemaVersion === SCHEMA_VERSION;
  let source = data;
  if (isCurrentSchema) {
    if (!isPlainObject(data.master)) {
      if (strict) reject('master must be an object.');
      source = {};
    } else {
      source = data.master;
    }
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
      const normalized = Object.fromEntries(fields.map(([key, maxLength]) => [
        key,
        normalizeText(record[key], `${field} ${key}`, maxLength)
      ]));
      normalized.id = record.id;
      return normalized;
    });
  };
  const softVersionText = (value, maxLength) => {
    if (typeof value !== 'string') return '';
    return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').slice(0, maxLength);
  };
  const versionBulletText = (value) => {
    if (typeof value !== 'string') return '';
    const text = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().replace(/^[-*\u2022]\s*/, '').trim();
    if (!text || text.length > 10000) return '';
    return text;
  };
  const versionSkillText = (value) => {
    if (typeof value !== 'string') return '';
    const text = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim();
    if (!text || text.length > 200) return '';
    return text;
  };
  const normalizeVersionList = (value, entryIds, experienceIds) => {
    if (value === undefined) return [];
    if (!Array.isArray(value)) {
      if (strict) reject('versions must be an array.');
      return [];
    }
    if (value.length > MAX_VERSIONS) {
      if (strict) reject(`versions has more than ${MAX_VERSIONS} items.`);
      value = value.slice(0, MAX_VERSIONS);
    }
    const seenIds = new Set();
    const kept = [];
    value.forEach((item) => {
      if (!isPlainObject(item)) return;
      if (typeof item.id !== 'string' || !ENTRY_ID_PATTERN.test(item.id) || seenIds.has(item.id)) return;
      seenIds.add(item.id);
      const rawName = typeof item.name === 'string' ? item.name.trim() : '';
      const name = (rawName || 'Untitled version').slice(0, 120);
      const hiddenEntries = [];
      const seenHidden = new Set();
      const hiddenSource = Array.isArray(item.hiddenEntries) ? item.hiddenEntries : [];
      hiddenSource.forEach((entryId) => {
        if (typeof entryId !== 'string' || !entryIds.has(entryId) || seenHidden.has(entryId)) return;
        seenHidden.add(entryId);
        hiddenEntries.push(entryId);
      });
      const hiddenBullets = {};
      const bulletSource = item.hiddenBullets && typeof item.hiddenBullets === 'object' && !Array.isArray(item.hiddenBullets)
        ? item.hiddenBullets
        : {};
      Object.keys(bulletSource).forEach((entryId) => {
        if (!experienceIds.has(entryId) || !Array.isArray(bulletSource[entryId])) return;
        const seenBullets = new Set();
        const bullets = [];
        bulletSource[entryId].forEach((bullet) => {
          const text = versionBulletText(bullet);
          if (!text || seenBullets.has(text) || bullets.length >= 200) return;
          seenBullets.add(text);
          bullets.push(text);
        });
        if (bullets.length) hiddenBullets[entryId] = bullets;
      });
      const hiddenSkills = [];
      const seenSkills = new Set();
      const skillSource = Array.isArray(item.hiddenSkills) ? item.hiddenSkills : [];
      skillSource.forEach((skill) => {
        const text = versionSkillText(skill);
        const key = text.toLowerCase();
        if (!text || seenSkills.has(key) || hiddenSkills.length >= 200) return;
        seenSkills.add(key);
        hiddenSkills.push(text);
      });
      kept.push({
        id: item.id,
        name,
        hiddenEntries,
        hiddenBullets,
        hiddenSkills,
        title: softVersionText(item.title, 200),
        summary: softVersionText(item.summary, 500),
        exportName: softVersionText(item.exportName, 120)
      });
    });
    return kept;
  };
  const basicsData = normalizeObject(source.basics, 'basics');
  const experienceRecords = normalizeRecords(source.experience, 'experience', MAX_EXPERIENCE_ENTRIES, [
    ['role', 200], ['company', 200], ['dates', 100], ['highlights', 10000]
  ]);
  const educationRecords = normalizeRecords(source.education, 'education', MAX_EDUCATION_ENTRIES, [
    ['degree', 200], ['school', 200], ['dates', 100]
  ]);
  const experience = assignEntryIds(
    experienceRecords.length ? experienceRecords : [{ role: '', company: '', dates: '', highlights: '' }],
    'exp_',
    makeId
  );
  const education = assignEntryIds(
    educationRecords.length ? educationRecords : [{ degree: '', school: '', dates: '' }],
    'edu_',
    makeId
  );
  const experienceIds = new Set();
  const entryIds = new Set();
  experience.forEach((item) => {
    if (item && typeof item.id === 'string') {
      experienceIds.add(item.id);
      entryIds.add(item.id);
    }
  });
  education.forEach((item) => { if (item && typeof item.id === 'string') entryIds.add(item.id); });
  return {
    master: {
      basics: {
        name: normalizeText(basicsData.name, 'basics name', 200),
        title: normalizeText(basicsData.title, 'basics title', 200),
        location: normalizeText(basicsData.location, 'basics location', 200),
        email: normalizeText(basicsData.email, 'basics email', 254),
        phone: normalizeText(basicsData.phone, 'basics phone', 40),
        website: normalizeText(basicsData.website, 'basics website', 300)
      },
      exportName: normalizeText(source.exportName, 'exportName', 120),
      summary: normalizeText(source.summary, 'summary', 500),
      experience,
      education,
      skills: normalizeText(source.skills, 'skills', 2000)
    },
    versions: isCurrentSchema ? normalizeVersionList(data.versions, entryIds, experienceIds) : []
  };
}

function toStorable() {
  const versions = typeof cvVersions !== 'undefined' && Array.isArray(cvVersions) ? cvVersions : [];
  const experienceById = new Map();
  const entryIds = new Set();
  const addRecord = (listName, item) => {
    if (!item || typeof item.id !== 'string') return;
    entryIds.add(item.id);
    if (listName === 'experience') experienceById.set(item.id, item);
  };
  if (typeof resumeData !== 'undefined' && resumeData && typeof resumeData === 'object') {
    ['experience', 'education'].forEach((listName) => {
      const list = resumeData[listName];
      if (!Array.isArray(list)) return;
      list.forEach((item) => addRecord(listName, item));
    });
  }
  const pending = typeof pendingEntryRemoval !== 'undefined' ? pendingEntryRemoval : null;
  if (pending && pending.item) addRecord(pending.list, pending.item);
  const canMatchBullets = typeof splitBullets === 'function' && typeof normalizeBulletText === 'function';
  const canMatchSkills = typeof skillParts === 'function' && typeof skillKey === 'function';
  const liveSkillKeys = new Set();
  if (canMatchSkills && typeof resumeData !== 'undefined' && resumeData) {
    skillParts(resumeData.skills).forEach((skill) => {
      const key = skillKey(skill);
      if (key) liveSkillKeys.add(key);
    });
  }
  const cleanText = (value, maxLength) => (
    typeof value === 'string'
      ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').slice(0, maxLength)
      : ''
  );
  return {
    schemaVersion: SCHEMA_VERSION,
    master: resumeData,
    versions: versions.filter((version) => version && typeof version === 'object').map((version) => {
      const hiddenEntries = (Array.isArray(version.hiddenEntries) ? version.hiddenEntries : [])
        .filter((id) => typeof id === 'string' && entryIds.has(id));
      const hiddenBullets = {};
      const sourceBullets = version.hiddenBullets && typeof version.hiddenBullets === 'object' && !Array.isArray(version.hiddenBullets)
        ? version.hiddenBullets
        : {};
      Object.keys(sourceBullets).forEach((id) => {
        if (!experienceById.has(id) || !Array.isArray(sourceBullets[id])) return;
        const live = new Set();
        if (canMatchBullets) splitBullets(experienceById.get(id).highlights).forEach((text) => live.add(text));
        const kept = [];
        const seen = new Set();
        sourceBullets[id].forEach((item) => {
          if (typeof item !== 'string') return;
          const text = canMatchBullets ? normalizeBulletText(item) : item;
          if (!text || text.length > 10000 || seen.has(text)) return;
          if (canMatchBullets && !live.has(text)) return;
          if (kept.length >= 200) return;
          seen.add(text);
          kept.push(text);
        });
        if (kept.length) hiddenBullets[id] = kept;
      });
      const hiddenSkills = [];
      const seenSkills = new Set();
      (Array.isArray(version.hiddenSkills) ? version.hiddenSkills : []).forEach((item) => {
        if (typeof item !== 'string') return;
        const text = item.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim();
        if (!text || text.length > 200) return;
        const key = text.toLowerCase();
        if (seenSkills.has(key)) return;
        if (canMatchSkills && !liveSkillKeys.has(key)) return;
        if (hiddenSkills.length >= 200) return;
        seenSkills.add(key);
        hiddenSkills.push(text);
      });
      return {
        id: version.id,
        name: version.name,
        hiddenEntries,
        hiddenBullets,
        hiddenSkills,
        title: cleanText(version.title, 200),
        summary: cleanText(version.summary, 500),
        exportName: cleanText(version.exportName, 120)
      };
    })
  };
}

function loadData() {
  let raw;
  try {
    raw = stateStorage.getItem(STORAGE_KEY);
  } catch (error) {
    storageLoadFailed = true;
    console.warn('State CV could not read saved data.', error);
    cvVersions = [];
    activeVersionId = null;
    return freshResumeData();
  }
  if (raw === null) {
    loadedRevision = 0;
    cvVersions = [];
    activeVersionId = null;
    return freshResumeData();
  }
  try {
    const parsed = JSON.parse(raw);
    loadedRevision = stateStorage.getDataRevision(STORAGE_KEY);
    const normalized = normalizeData(parsed, { strict: true });
    const legacy = !Object.hasOwn(parsed, 'schemaVersion') || parsed.schemaVersion === 1;
    if (legacy) pendingV1Raw = raw;
    cvVersions = normalized.versions;
    activeVersionId = null;
    return normalized.master;
  } catch (error) {
    preserveDamagedData(raw, error);
    cvVersions = [];
    activeVersionId = null;
    return freshResumeData();
  }
}

function migratePendingV1() {
  if (!pendingV1Raw) return;
  const raw = pendingV1Raw;
  pendingV1Raw = null;
  try {
    if (stateStorage.getItem(PREMIGRATION_KEY) === null) {
      stateStorage.setItem(PREMIGRATION_KEY, raw);
    }
  } catch (error) {
    abortV1Migration(error);
    return;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
    takeSnapshot(parsed, loadedRevision);
  } catch (error) {
    abortV1Migration(error);
    return;
  }
  try {
    const stored = { ...toStorable(), savedAt: new Date().toISOString() };
    loadedRevision = stateStorage.writeData(STORAGE_KEY, stored, loadedRevision);
  } catch (error) {
    if (error.code === 'conflict') {
      showStorageConflict(error.actualRevision);
      setStatus('error', 'Changes need your attention');
      return;
    }
    abortV1Migration(error);
  }
}

function abortV1Migration(error) {
  storageLoadFailed = true;
  storageWriteFailed = true;
  console.error('State CV could not migrate saved data to the current format.', error);
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

function saveData({ force = false, statusMessage = '' } = {}) {
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
    setStatus('saved', statusMessage || 'Saved locally');
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
    const masterKey = (master) => {
      const copy = structuredClone(master);
      ['experience', 'education'].forEach((listName) => {
        copy[listName] = (Array.isArray(copy[listName]) ? copy[listName] : []).map((record) => {
          const next = { ...(record && typeof record === 'object' ? record : {}) };
          delete next.id;
          return next;
        });
      });
      return JSON.stringify(copy);
    };
    snapshots = stateStorage.readSnapshots();
    const serializedData = masterKey(normalizedData.master);
    if (serializedData === masterKey(defaultData)) return;
    const newestSnapshot = snapshots.at(-1);
    if (newestSnapshot?.data) {
      try {
        if (masterKey(normalizeData(newestSnapshot.data, { strict: true }).master) === serializedData) return;
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
  const normalized = normalizeData(parsed, { strict: true });
  takeSnapshot({
    schemaVersion: SCHEMA_VERSION,
    master: normalized.master,
    versions: normalized.versions
  }, revision, minimumIntervalMs);
  return true;
}

function scheduleSave(statusMessage) {
  const message = typeof statusMessage === 'string' ? statusMessage : '';
  setStatus('saving', message || 'Saving...');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveData({ statusMessage: message });
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

function noteSuccessfulPdfExport() {
  if (finiteReminderNumber(backupReminder.lastBackupAt) > 0) return;
  pdfExportNeedsBackupReminder = true;
  updateBackupReminderNotice();
}

function snoozeBackupReminder(durationMs) {
  pdfExportNeedsBackupReminder = false;
  backupReminder.snoozeUntil = Date.now() + durationMs;
  writeBackupReminder(backupReminder);
  hideBackupReminder();
}

function updateBackupReminderNotice() {
  const exportOpen = exportPanelShouldShow();
  if (storageDamaged || storageLoadFailed || storageWriteFailed || exportOpen ||
      !shouldRemindBackup(backupReminder, Date.now(), { afterPdfExport: pdfExportNeedsBackupReminder })) {
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
  if (listName === 'version') pendingEntryRemoval = null;
  else pendingVersionRemoval = null;
  const toast = document.querySelector('#undoToast');
  const message = document.querySelector('#undoToastMessage');
  if (!toast || !message) return;
  message.textContent = listName === 'education'
    ? 'Education entry removed'
    : listName === 'version'
      ? 'Version removed'
      : 'Experience entry removed';
  clearTimeout(undoToastTimer);
  toast.hidden = false;
  toast.inert = false;
  undoToastTimer = setTimeout(hideUndoToast, 8000);
  syncUndoToastSpace();
}

function syncUndoToastSpace() {
  const root = document.documentElement;
  const toast = document.querySelector('#undoToast');
  const open = Boolean(toast && !toast.hidden);
  root.classList.toggle('undo-toast-open', open);
  if (!open) {
    root.style.setProperty('--undo-toast-height', '0px');
    return;
  }
  root.style.setProperty('--undo-toast-height', `${Math.ceil(toast.getBoundingClientRect().height)}px`);
  if (!window.matchMedia('(max-width: 1023px)').matches) return;
  window.requestAnimationFrame(() => {
    if (toast.hidden) return;
    const pager = document.querySelector('[data-editor-section]:not([hidden]) .section-pager');
    if (!pager) return;
    const toastBox = toast.getBoundingClientRect();
    const pagerBox = pager.getBoundingClientRect();
    const gap = 12;
    if (pagerBox.bottom <= toastBox.top - gap || pagerBox.top >= toastBox.bottom) return;
    window.scrollBy(0, pagerBox.bottom - toastBox.top + gap);
  });
}

function dismissUndoToast({ restoreFocus = false } = {}) {
  clearTimeout(undoToastTimer);
  undoToastTimer = null;
  const toast = document.querySelector('#undoToast');
  if (!toast) return;
  const returnFocus = restoreFocus && toast.contains(document.activeElement);
  toast.inert = true;
  toast.hidden = true;
  syncUndoToastSpace();
  if (returnFocus) {
    const focusTarget = document.querySelector('#appShell').inert ? '#continueButton' : '#brandHome';
    document.querySelector(focusTarget).focus();
  }
}

function hideUndoToast() {
  pendingEntryRemoval = null;
  pendingVersionRemoval = null;
  dismissUndoToast({ restoreFocus: true });
}

function showActionToast(message) {
  const toast = document.querySelector('#actionToast');
  const text = document.querySelector('#actionToastMessage');
  if (!toast || !text) return;
  text.textContent = message;
  updateStickyOffsets();
  toast.hidden = false;
  toast.inert = false;
  clearTimeout(actionToastTimer);
  actionToastTimer = setTimeout(() => {
    actionToastTimer = null;
    toast.inert = true;
    toast.hidden = true;
  }, 2500);
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
  const flags = expandedFlags(pending.list, items.length);
  if (replacePlaceholder) {
    items[0] = structuredClone(pending.item);
    flags[0] = true;
  } else {
    restoredIndex = Math.min(Math.max(pending.index, 0), items.length);
    items.splice(restoredIndex, 0, structuredClone(pending.item));
    flags.splice(restoredIndex, 0, true);
  }
  rememberExpanded(pending.list, flags);
  renderRepeaters();
  updatePreview();
  updateCompletion();
  scheduleSave();
  const listId = pending.list === 'experience' ? 'experienceList' : 'educationList';
  const sectionId = pending.list === 'experience' ? 'experience' : 'education';
  showEditorSection(sectionId);
  const entry = document.querySelectorAll(`#${listId} .repeat-item`)[restoredIndex];
  const toggle = entry ? entry.querySelector('.entry-toggle') : null;
  if (toggle) toggle.focus();
}

function shouldRemindBackup(state, now, options) {
  const source = state && typeof state === 'object' ? state : {};
  const asNumber = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
  const editsSinceBackup = asNumber(source.editsSinceBackup);
  const lastBackupAt = asNumber(source.lastBackupAt);
  const snoozeUntil = asNumber(source.snoozeUntil);
  const currentTime = asNumber(now);
  const weekMs = 7 * 24 * 60 * 60 * 1000;
  const noBackupYet = lastBackupAt <= 0;
  const backupIsOld = lastBackupAt > 0 && currentTime - lastBackupAt > weekMs;
  const extras = options && typeof options === 'object' ? options : {};
  const exportMoment = extras.afterPdfExport === true && noBackupYet;
  return (editsSinceBackup >= 50 || exportMoment) && (noBackupYet || backupIsOld) && currentTime >= snoozeUntil;
}

function downloadBackup() {
  downloadFile(
    new Blob([JSON.stringify(toStorable(), null, 2)], { type: 'application/json' }),
    `${safeFilename(document.querySelector('#exportFilename').value || resumeData.basics.name || 'CV')}.json`
  );
  backupReminder.lastBackupAt = Date.now();
  backupReminder.editsSinceBackup = 0;
  pdfExportNeedsBackupReminder = false;
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
    ['state-cv-data-v1', 'state-cv-snapshots-v1', 'state-cv-damaged-v1', 'state-cv-persistence-v1', 'state-cv-premigration-v1'].forEach((key) => {
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
    resumeData = structuredClone(normalizedData.master);
    cvVersions = structuredClone(Array.isArray(normalizedData.versions) ? normalizedData.versions : []);
    activeVersionId = null;
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
    resumeData = freshResumeData();
    cvVersions = [];
    activeVersionId = null;
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
    pdfExportNeedsBackupReminder = false;
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
      resumeData = freshResumeData();
      cvVersions = [];
      activeVersionId = null;
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
      resumeData = normalized.master;
      cvVersions = normalized.versions;
      activeVersionId = null;
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

function createVersion(name, makeId) {
  const trimmed = typeof name === 'string' ? name.trim() : '';
  const versionName = (trimmed || 'Untitled version').slice(0, 120);
  const id = String(typeof makeId === 'function' ? makeId('ver_') : '');
  return {
    id,
    name: versionName,
    hiddenEntries: [],
    hiddenBullets: {},
    hiddenSkills: [],
    title: '',
    summary: '',
    exportName: ''
  };
}

function duplicateVersion(version, existingNames, makeId) {
  const source = version && typeof version === 'object' ? version : {};
  const rawName = typeof source.name === 'string' ? source.name.trim() : '';
  const baseName = rawName || 'Untitled version';
  const taken = new Set();
  (Array.isArray(existingNames) ? existingNames : []).forEach((existing) => {
    if (typeof existing === 'string' && existing.trim()) taken.add(existing.trim());
  });
  let candidate = `${baseName} copy`;
  let number = 2;
  while (taken.has(candidate) && number < 1000) {
    candidate = `${baseName} copy ${number}`;
    number += 1;
  }
  const hiddenEntries = Array.isArray(source.hiddenEntries)
    ? source.hiddenEntries.filter((entryId) => typeof entryId === 'string')
    : [];
  const id = String(typeof makeId === 'function' ? makeId('ver_') : '');
  const text = (value, max) => (typeof value === 'string' ? value.slice(0, max) : '');
  return {
    id,
    name: candidate.slice(0, 120),
    hiddenEntries: hiddenEntries.slice(),
    hiddenBullets: copyHiddenBullets(source.hiddenBullets),
    hiddenSkills: copyStringList(source.hiddenSkills).slice(0, 200),
    title: text(source.title, 200),
    summary: text(source.summary, 500),
    exportName: text(source.exportName, 120)
  };
}

function copyStringList(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string') : [];
}

function copyHiddenBullets(value) {
  const copy = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return copy;
  Object.keys(value).forEach((key) => {
    const list = copyStringList(value[key]);
    if (list.length) copy[key] = list.slice();
  });
  return copy;
}

function normalizeBulletText(value) {
  return String(value ?? '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .trim()
    .replace(/^[-*\u2022]\s*/, '')
    .trim();
}

function splitBullets(highlights) {
  return String(highlights ?? '').split(/\r\n|\r|\n/).map(normalizeBulletText).filter(Boolean);
}

function skillKey(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function skillParts(skills) {
  return String(skills ?? '').split(/[,|;\t]|[\u2022\u00b7\u25aa]/).map((part) => (
    part.replace(/^[\u2022\u25cf\u25aa\u25e6\u00b7\u2013\u2014*-]\s*/, '').replace(/\s+/g, ' ').trim()
  )).filter(Boolean);
}

function splitSkillList(skills) {
  const seen = new Set();
  const result = [];
  skillParts(skills).forEach((skill) => {
    const key = skillKey(skill);
    if (!key || seen.has(key)) return;
    seen.add(key);
    result.push(skill);
  });
  return result;
}

function skillsJoiner(skills) {
  const text = String(skills ?? '');
  if (text.includes(',')) return ', ';
  if (text.includes('|')) return ' | ';
  if (text.includes(';')) return '; ';
  if (text.includes('\t')) return '\t';
  return ', ';
}

function filterHighlights(highlights, hiddenList) {
  const hidden = new Set((Array.isArray(hiddenList) ? hiddenList : []).map(normalizeBulletText).filter(Boolean));
  if (!hidden.size) return highlights;
  const lines = String(highlights ?? '').split(/\r\n|\r|\n/);
  let removed = false;
  const kept = [];
  lines.forEach((line) => {
    const text = normalizeBulletText(line);
    if (text && hidden.has(text)) {
      removed = true;
      return;
    }
    kept.push(line);
  });
  if (!removed) return highlights;
  while (kept.length && !normalizeBulletText(kept[0])) kept.shift();
  while (kept.length && !normalizeBulletText(kept[kept.length - 1])) kept.pop();
  return kept.join('\n');
}

function filterSkills(skills, hiddenSkills) {
  const hidden = new Set((Array.isArray(hiddenSkills) ? hiddenSkills : []).map(skillKey).filter(Boolean));
  if (!hidden.size) return skills;
  const original = typeof skills === 'string' ? skills : '';
  const parts = skillParts(original);
  const kept = parts.filter((skill) => !hidden.has(skillKey(skill)));
  if (kept.length === parts.length) return skills;
  return kept.join(skillsJoiner(original));
}

function applyVersion(master, version) {
  const source = master && typeof master === 'object' && !Array.isArray(master) ? master : {};
  const next = { ...source };
  if (source.basics && typeof source.basics === 'object' && !Array.isArray(source.basics)) {
    next.basics = { ...source.basics };
  }
  const copyList = (list) => (Array.isArray(list) ? list.map((item) => (
    item && typeof item === 'object' ? { ...item } : item
  )) : []);
  next.experience = copyList(source.experience);
  next.education = copyList(source.education);
  if (!version) return next;
  const hidden = new Set(Array.isArray(version.hiddenEntries) ? version.hiddenEntries : []);
  const bulletMap = version.hiddenBullets && typeof version.hiddenBullets === 'object' && !Array.isArray(version.hiddenBullets)
    ? version.hiddenBullets
    : {};
  next.experience = next.experience.map((item) => {
    if (!item || typeof item !== 'object') return item;
    const highlights = filterHighlights(item.highlights, bulletMap[item.id]);
    if (highlights === item.highlights) return item;
    return { ...item, highlights };
  }).filter((item) => !(item && typeof item === 'object' && hidden.has(item.id)));
  next.education = next.education.filter((item) => !(item && typeof item === 'object' && hidden.has(item.id)));
  const title = typeof version.title === 'string' ? version.title : '';
  if (title.trim()) {
    const basics = next.basics && typeof next.basics === 'object' && !Array.isArray(next.basics) ? next.basics : {};
    next.basics = { ...basics, title };
  }
  const summary = typeof version.summary === 'string' ? version.summary : '';
  if (summary.trim()) next.summary = summary;
  const skills = filterSkills(next.skills, version.hiddenSkills);
  if (skills !== next.skills) next.skills = skills;
  return next;
}

function entryCardTitle(type, item) {
  const record = item && typeof item === 'object' ? item : {};
  const text = (value) => (typeof value === 'string' ? value.trim() : '');
  const parts = type === 'education'
    ? [text(record.degree), text(record.school)]
    : [text(record.role), text(record.company)];
  const title = parts.filter(Boolean).join(', ');
  if (title) return title;
  return type === 'education' ? 'New education entry' : 'New experience entry';
}

function moveEntry(items, fromIndex, toIndex) {
  if (!Array.isArray(items) || !Number.isInteger(fromIndex) || !Number.isInteger(toIndex)) return false;
  if (fromIndex < 0 || toIndex < 0 || fromIndex >= items.length || toIndex >= items.length) return false;
  if (fromIndex === toIndex) return false;
  const [moved] = items.splice(fromIndex, 1);
  items.splice(toIndex, 0, moved);
  return true;
}

function renderFields() {
  entryExpanded.experience = [];
  entryExpanded.education = [];
  document.querySelectorAll('[data-path]').forEach((field) => { field.value = getValue(field.dataset.path); });
  renderRepeaters();
  updateSummaryCount();
  renderVersionControls();
}

function renderRepeaters() {
  renderRepeater('experienceList', 'experienceTemplate', resumeData.experience, blankExperience);
  renderRepeater('educationList', 'educationTemplate', resumeData.education, blankEducation);
  renderVersionEntries();
}

function expandedFlags(type, count) {
  const stored = entryExpanded[type] || [];
  const flags = [];
  for (let index = 0; index < count; index += 1) {
    flags.push(typeof stored[index] === 'boolean' ? stored[index] : count < 2);
  }
  return flags;
}

function rememberExpanded(type, flags) {
  entryExpanded[type] = flags.slice();
}

function labelEntryControls(entry, type, index, count, item) {
  const toggle = entry.querySelector('.entry-toggle');
  const titleNode = entry.querySelector('.entry-card-title');
  const open = toggle.getAttribute('aria-expanded') === 'true';
  const title = entryCardTitle(type, item);
  titleNode.textContent = title;
  const toggleLabel = `${open ? 'Collapse' : 'Expand'} ${type} entry ${index + 1}: ${title}`;
  toggle.setAttribute('aria-label', toggleLabel);
  toggle.title = toggleLabel;
  const up = entry.querySelector('[data-move="up"]');
  const down = entry.querySelector('[data-move="down"]');
  const upLabel = 'Move up';
  const downLabel = 'Move down';
  up.setAttribute('aria-label', upLabel);
  up.title = `Move ${type} entry ${index + 1} up`;
  up.disabled = index === 0;
  down.setAttribute('aria-label', downLabel);
  down.title = `Move ${type} entry ${index + 1} down`;
  down.disabled = index === count - 1;
  const removeButton = entry.querySelector('.remove-item');
  const removeLabel = `Remove ${type} entry ${index + 1}`;
  removeButton.setAttribute('aria-label', removeLabel);
  removeButton.title = removeLabel;
}

function focusRepeatEntry(type, index, selector) {
  const listId = type === 'experience' ? 'experienceList' : 'educationList';
  const entry = document.querySelectorAll(`#${listId} .repeat-item`)[index];
  const target = entry ? entry.querySelector(selector) : null;
  if (target) target.focus();
}

function focusMoveButton(type, index, direction) {
  const listId = type === 'experience' ? 'experienceList' : 'educationList';
  const entry = document.querySelectorAll(`#${listId} .repeat-item`)[index];
  if (!entry) return;
  const preferred = direction < 0 ? 'up' : 'down';
  const preferredButton = entry.querySelector(`[data-move="${preferred}"]`);
  const otherButton = entry.querySelector(`[data-move="${preferred === 'up' ? 'down' : 'up'}"]`);
  const target = preferredButton && !preferredButton.disabled ? preferredButton : otherButton;
  if (target && !target.disabled) target.focus();
}

function addEntry(type) {
  const items = resumeData[type];
  const maxEntries = type === 'experience' ? MAX_EXPERIENCE_ENTRIES : MAX_EDUCATION_ENTRIES;
  if (items.length >= maxEntries) {
    setImportStatus(`Limit of ${maxEntries} entries reached`, true);
    return;
  }
  const flags = expandedFlags(type, items.length);
  items.push(type === 'experience' ? blankExperience() : blankEducation());
  flags.push(true);
  rememberExpanded(type, flags);
  renderRepeaters();
  updatePreview();
  updateCompletion();
  scheduleSave();
  focusRepeatEntry(type, items.length - 1, 'input, textarea');
}

function moveRepeatEntry(type, fromIndex, direction) {
  const items = resumeData[type];
  const toIndex = fromIndex + direction;
  const flags = expandedFlags(type, items.length);
  if (!moveEntry(items, fromIndex, toIndex)) return;
  moveEntry(flags, fromIndex, toIndex);
  rememberExpanded(type, flags);
  renderRepeaters();
  updatePreview();
  updateCompletion();
  scheduleSave(`Moved to position ${toIndex + 1} of ${items.length}`);
  focusMoveButton(type, toIndex, direction);
}

function renderRepeater(listId, templateId, items, createBlankRecord) {
  const list = document.querySelector(`#${listId}`);
  const entryType = listId === 'experienceList' ? 'experience' : 'education';
  const openFlags = expandedFlags(entryType, items.length);
  list.replaceChildren();
  items.forEach((item, index) => {
    const node = document.querySelector(`#${templateId}`).content.cloneNode(true);
    const entry = node.querySelector('.repeat-item');
    const toggle = entry.querySelector('.entry-toggle');
    const body = entry.querySelector('.entry-card-body');
    const open = openFlags[index];
    const bodyId = `${entryType}-entry-${index}`;
    body.id = bodyId;
    toggle.setAttribute('aria-controls', bodyId);
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    body.hidden = !open;
    body.inert = !open;
    labelEntryControls(entry, entryType, index, items.length, item);
    node.querySelectorAll('[data-key]').forEach((field) => {
      field.value = item[field.dataset.key] || '';
      field.addEventListener('input', () => {
        item[field.dataset.key] = field.value;
        if (field.dataset.key === 'role' || field.dataset.key === 'company' || field.dataset.key === 'degree' || field.dataset.key === 'school') {
          labelEntryControls(entry, entryType, index, items.length, item);
          const versionBox = document.querySelector(`#versionEntryList [data-entry-id="${item.id}"]`);
          const versionText = versionBox && versionBox.parentElement ? versionBox.parentElement.querySelector('span') : null;
          if (versionText) versionText.textContent = entryCardTitle(entryType, item);
        }
        if (field.dataset.key === 'highlights') renderVersionEntries();
        updatePreview();
        updateCompletion();
        scheduleSave();
      });
    });
    toggle.addEventListener('click', () => {
      const nextOpen = toggle.getAttribute('aria-expanded') !== 'true';
      const flags = expandedFlags(entryType, items.length);
      flags[index] = nextOpen;
      rememberExpanded(entryType, flags);
      toggle.setAttribute('aria-expanded', nextOpen ? 'true' : 'false');
      body.hidden = !nextOpen;
      body.inert = !nextOpen;
      labelEntryControls(entry, entryType, index, items.length, item);
    });
    entry.querySelector('[data-move="up"]').addEventListener('click', () => moveRepeatEntry(entryType, index, -1));
    entry.querySelector('[data-move="down"]').addEventListener('click', () => moveRepeatEntry(entryType, index, 1));
    entry.querySelector('.remove-item').addEventListener('click', () => {
      const removed = {
        item: structuredClone(item),
        index,
        list: entryType,
        placeholderAdded: false
      };
      const flags = expandedFlags(entryType, items.length);
      items.splice(index, 1);
      flags.splice(index, 1);
      if (!items.length) {
        items.push(createBlankRecord());
        removed.placeholderAdded = true;
      }
      rememberExpanded(entryType, flags);
      pendingEntryRemoval = removed;
      renderRepeaters();
      updatePreview();
      updateCompletion();
      scheduleSave();
      showUndoToast(entryType);
    });
    list.appendChild(node);
  });
}

function updateSummaryCount() { document.querySelector('#summaryCount').textContent = `${resumeData.summary.length} / 500`; }

function activeVersion() {
  if (!activeVersionId || !Array.isArray(cvVersions)) return null;
  return cvVersions.find((version) => version && version.id === activeVersionId) || null;
}

function currentExportData() {
  return applyVersion(resumeData, activeVersion());
}

function versionDisplayName() {
  const version = activeVersion();
  return version ? version.name : 'Master CV';
}

function focusCheckedVersionRadio() {
  const sheet = document.querySelector('#versionSheet');
  if (!sheet || sheet.hidden) return;
  const checked = sheet.querySelector('input[type="radio"]:checked');
  if (checked) checked.focus();
  else sheet.focus();
}

function syncVersionSheet({ focus = false } = {}) {
  const sheet = document.querySelector('#versionSheet');
  const backdrop = document.querySelector('#versionSheetBackdrop');
  const pill = document.querySelector('#versionPill');
  if (!sheet || !pill) return;
  const phone = phoneLayout();
  pill.setAttribute('aria-expanded', versionSheetOpen ? 'true' : 'false');
  sheet.setAttribute('aria-modal', versionSheetOpen && phone ? 'true' : 'false');
  sheet.hidden = !versionSheetOpen;
  sheet.inert = !versionSheetOpen;
  if (backdrop) {
    const showBackdrop = versionSheetOpen && phone;
    backdrop.hidden = !showBackdrop;
    backdrop.inert = !showBackdrop;
  }
  const topbar = document.querySelector('.topbar');
  if (topbar) topbar.classList.toggle('version-sheet-host', versionSheetOpen && phone);
  if (versionSheetOpen && focus) focusCheckedVersionRadio();
}

function openVersionSheet({ focus = true } = {}) {
  closeMoreMenu();
  if (exportPopoverOpen || (phoneLayout() && document.querySelector('#appShell').dataset.mobileView === 'export')) {
    closeExportPopover();
  }
  versionSheetOpen = true;
  syncVersionSheet({ focus });
}

function closeVersionSheet({ returnFocus = false } = {}) {
  const sheet = document.querySelector('#versionSheet');
  const focusWasInside = Boolean(sheet && sheet.contains(document.activeElement));
  if (!versionSheetOpen && !(sheet && !sheet.hidden)) return;
  versionSheetOpen = false;
  syncVersionSheet();
  if (returnFocus || focusWasInside) {
    const pill = document.querySelector('#versionPill');
    if (pill) pill.focus();
  }
}

function sheetFocusable(sheet) {
  const elements = [...sheet.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')]
    .filter((element) => !element.hidden && !element.closest('[hidden], [inert]') && element.getClientRects().length);
  return elements.filter((element) => {
    if (element.type !== 'radio') return true;
    const group = elements.filter((item) => item.type === 'radio' && item.name === element.name);
    const checked = group.find((radio) => radio.checked) || group[0];
    return element === checked;
  });
}

function updateVersionPill() {
  const label = document.querySelector('#versionPillLabel');
  if (label) label.textContent = versionDisplayName();
}

function updateVersionBanner() {
  const banner = document.querySelector('#versionBanner');
  const text = document.querySelector('#versionBannerText');
  const version = activeVersion();
  if (!banner) return;
  banner.hidden = !version;
  banner.inert = !version;
  if (text && version) {
    text.replaceChildren();
    text.append(document.createTextNode(`Viewing ${version.name} · Edits change your `));
    const keep = document.createElement('span');
    keep.className = 'version-banner-keep';
    keep.textContent = 'master CV';
    text.append(keep);
  }
  syncVersionBannerTailor();
  updateStickyOffsets();
}

function syncVersionBannerTailor() {
  const button = document.querySelector('#versionBannerTailor');
  if (!button) return;
  const show = Boolean(activeVersion()) && !tailorMode;
  button.hidden = !show;
  button.inert = !show;
}

function syncTailorChrome() {
  if (tailorMode && !activeVersion()) tailorMode = false;
  const active = tailorMode;
  const panel = document.querySelector('#tailorPanel');
  const form = document.querySelector('#resumeForm');
  const heading = document.querySelector('.panel-heading');
  const quick = document.querySelector('.quick-actions');
  const sectionNav = document.querySelector('.section-nav');
  const phone = phoneLayout();
  if (panel) {
    panel.hidden = !active;
    panel.inert = !active;
  }
  if (form) {
    form.hidden = active;
    form.inert = active;
  }
  if (heading) {
    heading.hidden = active;
    heading.inert = active;
  }
  if (quick) {
    quick.hidden = active;
    quick.inert = active;
  }
  if (sectionNav) {
    sectionNav.hidden = active && phone;
    sectionNav.inert = active && phone;
  }
  const title = document.querySelector('#tailorHeading');
  const version = activeVersion();
  if (title && version) title.textContent = `Tailoring: ${version.name}`;
  const shell = document.querySelector('#appShell');
  if (shell) shell.dataset.tailor = active ? 'true' : 'false';
  syncVersionBannerTailor();
  updateStickyOffsets();
}

function enterTailorMode() {
  if (!activeVersion()) return;
  tailorMode = true;
  versionSheetOpen = false;
  syncVersionSheet();
  syncTailorChrome();
  const heading = document.querySelector('#tailorHeading');
  if (heading) heading.focus({ preventScroll: true });
}

function leaveTailorMode({ focusHeading = false } = {}) {
  if (!tailorMode) {
    syncTailorChrome();
    return;
  }
  tailorMode = false;
  syncTailorChrome();
  if (!focusHeading) return;
  const section = document.querySelector('[data-editor-section]:not([hidden]) h2');
  if (section) section.focus({ preventScroll: true });
}

function closeVersionRename(returnFocus) {
  const panel = document.querySelector('#versionRename');
  if (!panel) return;
  panel.hidden = true;
  panel.inert = true;
  if (returnFocus) {
    const button = document.querySelector('#renameVersionButton');
    if (button && !button.disabled) button.focus();
  }
}

function hiddenBulletSet(version, entryId) {
  const source = version && version.hiddenBullets && typeof version.hiddenBullets === 'object' ? version.hiddenBullets[entryId] : [];
  const hidden = new Set();
  (Array.isArray(source) ? source : []).forEach((item) => {
    const text = normalizeBulletText(item);
    if (text) hidden.add(text);
  });
  return hidden;
}

function renderVersionEntries() {
  const list = document.querySelector('#versionEntryList');
  if (!list) return;
  const openBullets = new Set();
  list.querySelectorAll('details[data-entry-id][open]').forEach((node) => {
    if (node.dataset.entryId) openBullets.add(node.dataset.entryId);
  });
  list.replaceChildren();
  const version = activeVersion();
  if (!version) return;
  const hidden = new Set(Array.isArray(version.hiddenEntries) ? version.hiddenEntries : []);
  const addEntries = (type, items) => {
    (Array.isArray(items) ? items : []).forEach((item) => {
      if (!item || typeof item.id !== 'string') return;
      const block = document.createElement('div');
      block.className = 'version-entry-block';
      const label = document.createElement('label');
      label.className = 'version-entry';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = !hidden.has(item.id);
      input.dataset.entryId = item.id;
      const text = document.createElement('span');
      text.textContent = entryCardTitle(type, item);
      input.addEventListener('change', () => {
        const active = activeVersion();
        if (!active) return;
        const nextHidden = Array.isArray(active.hiddenEntries) ? active.hiddenEntries.filter((id) => id !== item.id) : [];
        if (!input.checked) nextHidden.push(item.id);
        active.hiddenEntries = nextHidden;
        updatePreview();
        scheduleSave();
        if (type === 'experience') {
          renderVersionEntries();
          const next = document.querySelector(`#versionEntryList [data-entry-id="${item.id}"]`);
          if (next) next.focus();
        }
      });
      label.append(input, text);
      block.append(label);
      if (type === 'experience' && input.checked) {
        const bullets = splitBullets(item.highlights);
        if (bullets.length) {
          const details = document.createElement('details');
          details.className = 'version-bullets';
          details.dataset.entryId = item.id;
          if (openBullets.has(item.id)) details.open = true;
          const summary = document.createElement('summary');
          summary.textContent = 'Bullets';
          const bulletList = document.createElement('div');
          bulletList.className = 'version-choice-list';
          const hiddenBullets = hiddenBulletSet(version, item.id);
          bullets.forEach((bullet) => {
            const bulletLabel = document.createElement('label');
            bulletLabel.className = 'version-entry version-bullet';
            const bulletInput = document.createElement('input');
            bulletInput.type = 'checkbox';
            bulletInput.checked = !hiddenBullets.has(bullet);
            bulletInput.dataset.bullet = bullet;
            bulletInput.addEventListener('change', () => {
              const active = activeVersion();
              if (!active) return;
              if (!active.hiddenBullets || typeof active.hiddenBullets !== 'object' || Array.isArray(active.hiddenBullets)) {
                active.hiddenBullets = {};
              }
              const current = Array.isArray(active.hiddenBullets[item.id]) ? active.hiddenBullets[item.id] : [];
              const next = current.filter((entry) => normalizeBulletText(entry) !== bullet);
              if (!bulletInput.checked) next.push(bullet);
              if (next.length) active.hiddenBullets[item.id] = next;
              else delete active.hiddenBullets[item.id];
              bulletList.querySelectorAll('input[type="checkbox"]').forEach((box) => {
                if (box.dataset.bullet === bullet) box.checked = bulletInput.checked;
              });
              updatePreview();
              scheduleSave();
            });
            const bulletText = document.createElement('span');
            bulletText.textContent = bullet;
            bulletLabel.append(bulletInput, bulletText);
            bulletList.append(bulletLabel);
          });
          details.append(summary, bulletList);
          block.append(details);
        }
      }
      list.append(block);
    });
  };
  addEntries('experience', resumeData.experience);
  addEntries('education', resumeData.education);
}

function renderVersionSkills() {
  const list = document.querySelector('#versionSkillList');
  if (!list) return;
  list.replaceChildren();
  const version = activeVersion();
  if (!version) return;
  const hidden = new Set((Array.isArray(version.hiddenSkills) ? version.hiddenSkills : []).map(skillKey).filter(Boolean));
  const skills = splitSkillList(resumeData.skills);
  if (!skills.length) {
    const empty = document.createElement('p');
    empty.className = 'versions-hint';
    empty.textContent = 'No skills in the master CV.';
    list.append(empty);
    return;
  }
  skills.forEach((skill) => {
    const label = document.createElement('label');
    label.className = 'version-entry';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = !hidden.has(skillKey(skill));
    input.addEventListener('change', () => {
      const active = activeVersion();
      if (!active) return;
      const key = skillKey(skill);
      const next = (Array.isArray(active.hiddenSkills) ? active.hiddenSkills : []).filter((item) => skillKey(item) !== key);
      if (!input.checked) next.push(skill);
      active.hiddenSkills = next;
      updatePreview();
      scheduleSave();
    });
    const text = document.createElement('span');
    text.textContent = skill;
    label.append(input, text);
    list.append(label);
  });
}

function syncVersionCopyFields() {
  const version = activeVersion();
  const title = document.querySelector('#versionTitle');
  const summary = document.querySelector('#versionSummary');
  const count = document.querySelector('#versionSummaryCount');
  const titleValue = version && typeof version.title === 'string' ? version.title : '';
  const summaryValue = version && typeof version.summary === 'string' ? version.summary : '';
  if (title && document.activeElement !== title) title.value = titleValue;
  if (summary && document.activeElement !== summary) summary.value = summaryValue;
  const summaryLength = summary && document.activeElement === summary ? summary.value.length : summaryValue.length;
  if (count) count.textContent = `${summaryLength} / 500`;
}

function renderVersionRadios() {
  const list = document.querySelector('#versionRadioList');
  if (!list) return;
  list.replaceChildren();
  const addRadio = (id, name) => {
    const label = document.createElement('label');
    label.className = 'version-choice';
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = 'activeVersion';
    input.value = id;
    input.checked = id ? activeVersionId === id : !activeVersion();
    input.addEventListener('change', () => {
      if (input.checked) onVersionSelected(id);
    });
    const text = document.createElement('span');
    text.textContent = name;
    label.append(input, text);
    list.append(label);
  };
  addRadio('', 'Master CV');
  (Array.isArray(cvVersions) ? cvVersions : []).forEach((item) => {
    if (!item || typeof item.id !== 'string') return;
    addRadio(item.id, item.name);
  });
}

function renderVersionControls() {
  const list = document.querySelector('#versionRadioList');
  if (!list) return;
  if (activeVersionId && !activeVersion()) activeVersionId = null;
  const current = activeVersion();
  renderVersionRadios();
  const managing = Boolean(current);
  const renameButton = document.querySelector('#renameVersionButton');
  const duplicateButton = document.querySelector('#duplicateVersionButton');
  const deleteButton = document.querySelector('#deleteVersionButton');
  const tailorButton = document.querySelector('#tailorFromSheetButton');
  if (renameButton) renameButton.disabled = !managing;
  if (duplicateButton) duplicateButton.disabled = !managing;
  if (deleteButton) deleteButton.disabled = !managing;
  if (tailorButton) {
    tailorButton.hidden = !managing;
    tailorButton.inert = !managing;
  }
  if (!managing) closeVersionRename(false);
  renderVersionEntries();
  renderVersionSkills();
  syncVersionCopyFields();
  showExportFilename();
  updateVersionPill();
  updateVersionBanner();
  updateFormatLabel();
  syncTailorChrome();
}

function masterExportBase() {
  const person = resumeData.basics && typeof resumeData.basics.name === 'string' ? resumeData.basics.name.trim() : '';
  return person ? `${person} CV` : 'Untitled CV';
}

function defaultExportFilename() {
  const version = activeVersion();
  if (!version) {
    const custom = typeof resumeData.exportName === 'string' ? resumeData.exportName.trim() : '';
    return custom ? resumeData.exportName : masterExportBase();
  }
  const custom = typeof version.exportName === 'string' ? version.exportName.trim() : '';
  return custom ? version.exportName : `${masterExportBase()} - ${version.name}`;
}

function showExportFilename() {
  const filename = document.querySelector('#exportFilename');
  if (!filename) return;
  const version = activeVersion();
  if (version) filename.removeAttribute('data-edited');
  else if (typeof resumeData.exportName === 'string' && resumeData.exportName.trim()) filename.dataset.edited = 'true';
  else filename.removeAttribute('data-edited');
  filename.value = defaultExportFilename();
}

function createNewVersion() {
  if (!Array.isArray(cvVersions)) cvVersions = [];
  if (cvVersions.length >= MAX_VERSIONS) {
    setImportStatus('You can keep up to 50 versions.');
    return;
  }
  const version = createVersion('Untitled version', createEntryId);
  cvVersions.push(version);
  activeVersionId = version.id;
  closeVersionRename(false);
  renderVersionControls();
  updatePreview();
  scheduleSave();
  showActionToast('Version created');
  focusCheckedVersionRadio();
}

function openVersionRename() {
  const version = activeVersion();
  const panel = document.querySelector('#versionRename');
  const input = document.querySelector('#versionRenameInput');
  if (!version || !panel || !input) return;
  input.value = version.name;
  panel.hidden = false;
  panel.inert = false;
  input.focus();
  input.select();
}

function saveVersionName() {
  const version = activeVersion();
  const input = document.querySelector('#versionRenameInput');
  if (!version || !input) return;
  const trimmed = input.value.trim();
  version.name = (trimmed || 'Untitled version').slice(0, 120);
  closeVersionRename(false);
  renderVersionControls();
  updatePreview();
  scheduleSave();
  showActionToast('Version renamed');
  focusCheckedVersionRadio();
}

function duplicateActiveVersion() {
  const version = activeVersion();
  if (!version) return;
  if (cvVersions.length >= MAX_VERSIONS) {
    setImportStatus('You can keep up to 50 versions.');
    return;
  }
  const copy = duplicateVersion(version, cvVersions.map((item) => item.name), createEntryId);
  cvVersions.push(copy);
  activeVersionId = copy.id;
  closeVersionRename(false);
  renderVersionControls();
  updatePreview();
  scheduleSave();
  showActionToast('Version duplicated');
  focusCheckedVersionRadio();
}

function deleteActiveVersion() {
  const version = activeVersion();
  if (!version) return;
  const index = cvVersions.findIndex((item) => item.id === version.id);
  if (index < 0) return;
  pendingVersionRemoval = { version: structuredClone(version), index };
  cvVersions.splice(index, 1);
  activeVersionId = null;
  tailorMode = false;
  closeVersionRename(false);
  renderVersionControls();
  updatePreview();
  scheduleSave();
  showUndoToast('version');
  focusCheckedVersionRadio();
}

function undoVersionRemoval() {
  const pending = pendingVersionRemoval;
  if (!pending) return;
  if (cvVersions.length >= MAX_VERSIONS) {
    setImportStatus('You can keep up to 50 versions.');
    return;
  }
  pendingVersionRemoval = null;
  dismissUndoToast();
  const index = Math.min(Math.max(pending.index, 0), cvVersions.length);
  cvVersions.splice(index, 0, pending.version);
  activeVersionId = pending.version.id;
  renderVersionControls();
  updatePreview();
  scheduleSave();
  showActionToast('Version restored');
  if (!versionSheetOpen) openVersionSheet({ focus: false });
  focusCheckedVersionRadio();
}

function onVersionSelected(value) {
  const nextId = value && cvVersions.some((version) => version.id === value) ? value : null;
  activeVersionId = nextId;
  closeVersionRename(false);
  if (!nextId) tailorMode = false;
  renderVersionControls();
  updatePreview();
  if (versionSheetOpen) focusCheckedVersionRadio();
}

function updateWorkspaceName() {
  const name = resumeData.basics.name.trim();
  document.querySelector('#workspaceName').textContent = name ? `${name} CV` : 'Untitled CV';
  const filename = document.querySelector('#exportFilename');
  if (!filename || document.activeElement === filename) return;
  const version = activeVersion();
  if (version) {
    if (typeof version.exportName === 'string' && version.exportName.trim()) return;
    filename.value = defaultExportFilename();
    return;
  }
  if (!filename.dataset.edited) filename.value = defaultExportFilename();
}

function updatePreview({ force = false } = {}) {
  updateWorkspaceName();
  if (!force && getComputedStyle(document.querySelector('#previewPanel')).display === 'none') return;
  const { basics, summary, experience, education, skills } = currentExportData();
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
      const bulletLines = splitBullets(item.highlights);
      if (bulletLines.length) {
        const bullets = element('ul', 'entry-bullets');
        bulletLines.forEach((bullet) => bullets.append(element('li', '', bullet)));
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

const EDITOR_SECTIONS = ['contact', 'summary', 'experience', 'education', 'skills'];
const EDITOR_SECTION_LABELS = {
  contact: '01. Contact',
  summary: '02. Summary',
  experience: '03. Experience',
  education: '04. Education',
  skills: '05. Skills'
};

function getSectionStatus(data) {
  const source = data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  const basics = source.basics && typeof source.basics === 'object' && !Array.isArray(source.basics) ? source.basics : {};
  const textFilled = (value) => typeof value === 'string' && value.trim() !== '';
  const list = (value) => (Array.isArray(value) ? value : []);
  return {
    contact: textFilled(basics.name) && textFilled(basics.title) && textFilled(basics.email),
    summary: textFilled(source.summary),
    experience: list(source.experience).some((item) => item && typeof item === 'object' && (textFilled(item.role) || textFilled(item.company))),
    education: list(source.education).some((item) => item && typeof item === 'object' && (textFilled(item.degree) || textFilled(item.school))),
    skills: textFilled(source.skills)
  };
}

function updateCompletion() {
  const status = getSectionStatus(resumeData);
  const values = [resumeData.basics.name, resumeData.basics.title, resumeData.basics.email, resumeData.summary, resumeData.experience.some((item) => item.role || item.company), resumeData.education.some((item) => item.degree || item.school), resumeData.skills];
  const percent = Math.round((values.filter(Boolean).length / values.length) * 100);
  document.querySelector('#completionPercent').textContent = `${percent}%`;
  document.querySelector('#completionLabel').textContent = percent === 100 ? 'Ready to send' : percent >= 70 ? 'Looking strong' : 'Add your details';
  const progress = Math.min(100, Math.round(percent / 25) * 25);
  document.querySelector('#completionRing').className = `completion-ring progress-${progress}`;
  updateSectionChecks(status);
  renderAtsTips();
  updatePdfImportCard();
}

function updateSectionChecks(status) {
  EDITOR_SECTIONS.forEach((id) => {
    const complete = Boolean(status && status[id]);
    const mark = document.querySelector(`[data-section-check="${id}"]`);
    if (mark) mark.hidden = !complete;
    const button = document.querySelector(`[data-section-target="${id}"]`);
    if (button) button.setAttribute('aria-label', complete ? `${EDITOR_SECTION_LABELS[id]}, complete` : EDITOR_SECTION_LABELS[id]);
  });
}

function showEditorSection(sectionId, { focusHeading = false } = {}) {
  const nextId = EDITOR_SECTIONS.includes(sectionId) ? sectionId : 'contact';
  document.querySelectorAll('[data-editor-section]').forEach((section) => {
    const active = section.dataset.editorSection === nextId;
    section.hidden = !active;
    section.inert = !active;
  });
  document.querySelectorAll('[data-section-target]').forEach((button) => {
    if (button.dataset.sectionTarget === nextId) button.setAttribute('aria-current', 'step');
    else button.removeAttribute('aria-current');
  });
  const section = document.querySelector(`[data-editor-section="${nextId}"]`);
  if (!section) return;
  const heading = section.querySelector('h2');
  if (focusHeading && heading) heading.focus({ preventScroll: true });
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  section.scrollIntoView({ block: 'start', behavior: reduceMotion ? 'auto' : 'smooth' });
}

function setSectionNavCollapsed(collapsed) {
  const panel = document.querySelector('.editor-panel');
  if (panel) panel.dataset.sectionsCollapsed = collapsed ? 'true' : 'false';
  const toggle = document.querySelector('#sectionNavToggle');
  if (!toggle) return;
  toggle.setAttribute('aria-expanded', String(!collapsed));
  toggle.setAttribute('aria-label', collapsed ? 'Expand sections' : 'Collapse sections');
  const icon = toggle.querySelector('.section-nav-toggle-icon');
  if (icon) icon.textContent = collapsed ? '»' : '«';
}

function updatePdfImportCard() {
  const button = document.querySelector('#importPdfButton');
  if (!button) return;
  const show = isBlankCv(resumeData);
  button.hidden = !show;
  button.inert = !show;
}

let atsTipCount = -1;
function renderAtsTips() {
  const tips = getAtsTips(resumeData);
  const details = document.querySelector('#atsTips');
  const summaryLabel = document.querySelector('#atsTipsSummary');
  const count = document.querySelector('#atsTipsCount');
  const list = document.querySelector('#atsTipsList');
  if (summaryLabel) summaryLabel.textContent = tips.length ? 'ATS tips' : 'ATS tips: all good';
  if (count) {
    count.hidden = tips.length === 0;
    count.textContent = tips.length ? `(${tips.length})` : '';
  }
  if (list) {
    list.replaceChildren();
    tips.forEach((message) => {
      const item = document.createElement('li');
      item.textContent = message;
      list.append(item);
    });
    list.hidden = tips.length === 0;
  }
  if (details) {
    details.classList.toggle('is-clear', tips.length === 0);
    if (!tips.length) details.open = false;
    else if (atsTipCount === 0) details.open = true;
  }
  atsTipCount = tips.length;
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
    const normalized = normalizeData(parsed, { strict: true });
    const versionCount = Array.isArray(normalized.versions) ? normalized.versions.length : 0;
    if (isBlankCv(normalized.master) && versionCount === 0) return true;
    if (versionCount > 0) {
      const versionLabel = versionCount === 1 ? '1 version' : `${versionCount} versions`;
      return window.confirm(`Importing will replace your current CV. Your ${versionLabel} will be removed. A copy is kept in Your data > Recent snapshots. Continue?`);
    }
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
  const continueButton = document.querySelector('#continueButton');
  const newCvButton = document.querySelector('#newCvButton');
  if (continueButton) continueButton.classList.toggle('launch-card-primary', hasDraft);
  if (newCvButton) newCvButton.classList.toggle('launch-card-primary', !hasDraft);
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
  resumeData = freshResumeData();
  cvVersions = [];
  activeVersionId = null;
  document.querySelector('#exportFilename').removeAttribute('data-edited');
  renderFields(); updatePreview(); updateCompletion();
  showEditorSection('contact');
  const saved = saveData({ force: storageLoadFailed || storageDamaged });
  if (saved) closeLaunchScreen();
}

document.querySelectorAll('[data-path]').forEach((field) => field.addEventListener('input', () => { setValue(field.dataset.path, field.value); if (field.dataset.path === 'summary') updateSummaryCount(); if (field.dataset.path === 'skills') renderVersionSkills(); updatePreview(); updateCompletion(); scheduleSave(); }));
document.querySelector('#addExperience').addEventListener('click', () => addEntry('experience'));
document.querySelector('#addEducation').addEventListener('click', () => addEntry('education'));

async function copyPlainText() {
  const exportData = currentExportData();
  const text = cvToPlainText(exportData);
  try {
    if (!navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') {
      throw new Error('Clipboard is unavailable.');
    }
    await navigator.clipboard.writeText(text);
    setImportStatus('Plain text copied.');
  } catch (error) {
    savePlainTextFile(text, exportData);
    setImportStatus('Clipboard blocked. Plain text downloaded.');
    console.error('State CV could not copy plain text and downloaded it instead.', error);
  }
}
let editViewScrollY = 0;
let exportPopoverOpen = false;
function phoneLayout() {
  return window.matchMedia('(max-width: 1023px)').matches;
}
function exportPanelShouldShow() {
  if (phoneLayout()) return document.querySelector('#appShell').dataset.mobileView === 'export';
  return exportPopoverOpen;
}
function syncExportPanel({ focus = false } = {}) {
  const panel = document.querySelector('#exportPanel');
  const button = document.querySelector('#printButton');
  const show = exportPanelShouldShow();
  panel.hidden = !show;
  panel.inert = !show;
  button.setAttribute('aria-expanded', String(!phoneLayout() && exportPopoverOpen));
  if (show && focus) panel.focus({ preventScroll: true });
  updateBackupReminderNotice();
}
function closeExportPopover({ returnFocus = false } = {}) {
  const wasPhoneExport = phoneLayout() && document.querySelector('#appShell').dataset.mobileView === 'export';
  exportPopoverOpen = false;
  if (wasPhoneExport) {
    setMobileView('edit');
    if (returnFocus) document.querySelector('#mobileExportButton').focus();
    return;
  }
  const panel = document.querySelector('#exportPanel');
  if (returnFocus || panel.contains(document.activeElement)) document.querySelector('#printButton').focus();
  syncExportPanel();
}
function setMobileView(view) {
  if ((view === 'preview' || view === 'export') && versionSheetOpen) closeVersionSheet();
  if (view === 'edit' && tailorMode) leaveTailorMode();
  const appShell = document.querySelector('#appShell');
  const currentView = appShell.dataset.mobileView || 'edit';
  const leavingEdit = (view === 'preview' || view === 'export') && currentView === 'edit';
  if (leavingEdit) editViewScrollY = window.scrollY;
  appShell.dataset.mobileView = view;
  document.querySelectorAll('[data-mobile-view-button]').forEach((button) => {
    button.setAttribute('aria-pressed', String(button.dataset.mobileViewButton === view));
  });
  document.querySelector('#mobileExportButton').setAttribute('aria-pressed', String(view === 'export'));
  const enteredExport = view === 'export' && currentView !== 'export' && phoneLayout();
  syncExportPanel({ focus: enteredExport });
  if (view === 'edit' && (currentView === 'preview' || currentView === 'export')) {
    window.requestAnimationFrame(() => window.scrollTo({ top: editViewScrollY, behavior: 'instant' }));
  } else if (view === 'preview' || view === 'export') {
    window.scrollTo({ top: 0, behavior: 'instant' });
  }
  if (view === 'preview') updatePreview();
}
document.querySelectorAll('[data-mobile-view-button]').forEach((button) => {
  button.addEventListener('click', () => setMobileView(button.dataset.mobileViewButton));
});
document.querySelector('#mobileExportButton').addEventListener('click', () => setMobileView('export'));
document.querySelector('#printButton').addEventListener('click', () => {
  if (phoneLayout()) {
    setMobileView('export');
    return;
  }
  exportPopoverOpen = !exportPopoverOpen;
  if (exportPopoverOpen) {
    closeMoreMenu();
    closeVersionSheet();
  }
  if (!exportPopoverOpen && document.querySelector('#exportPanel').contains(document.activeElement)) {
    document.querySelector('#printButton').focus();
  }
  syncExportPanel({ focus: exportPopoverOpen });
});
document.querySelector('#downloadPdfButton').addEventListener('click', () => exportPdf(currentExportData()));
document.querySelector('#exportPanel').addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  event.preventDefault();
  event.stopPropagation();
  closeExportPopover({ returnFocus: true });
});
document.querySelector('#atsTips').addEventListener('toggle', () => {
  const details = document.querySelector('#atsTips');
  if (details.open && !getAtsTips(resumeData).length) details.open = false;
});
window.addEventListener('beforeprint', () => updatePreview({ force: true }));
window.matchMedia('(min-width: 1024px)').addEventListener('change', (event) => {
  updatePreview();
  if (!event.matches) {
    setSectionNavCollapsed(false);
    exportPopoverOpen = false;
  } else if (document.querySelector('#appShell').dataset.mobileView === 'export') {
    document.querySelector('#appShell').dataset.mobileView = 'edit';
  }
  syncExportPanel();
  syncVersionSheet();
  syncTailorChrome();
});
document.querySelector('#sectionNavToggle').addEventListener('click', () => {
  const expanded = document.querySelector('#sectionNavToggle').getAttribute('aria-expanded') === 'true';
  setSectionNavCollapsed(expanded);
});
document.querySelectorAll('[data-section-target]').forEach((button) => {
  button.addEventListener('click', () => {
    if (tailorMode) leaveTailorMode();
    showEditorSection(button.dataset.sectionTarget, { focusHeading: true });
  });
});
document.querySelectorAll('[data-section-back]').forEach((button) => {
  button.addEventListener('click', () => {
    const current = button.closest('[data-editor-section]').dataset.editorSection;
    const index = EDITOR_SECTIONS.indexOf(current);
    if (index > 0) showEditorSection(EDITOR_SECTIONS[index - 1], { focusHeading: true });
  });
});
document.querySelectorAll('[data-section-next]').forEach((button) => {
  button.addEventListener('click', () => {
    const current = button.closest('[data-editor-section]').dataset.editorSection;
    if (current === 'skills' && window.matchMedia('(max-width: 1023px)').matches) {
      setMobileView('preview');
      return;
    }
    const index = EDITOR_SECTIONS.indexOf(current);
    if (index >= 0 && index < EDITOR_SECTIONS.length - 1) showEditorSection(EDITOR_SECTIONS[index + 1], { focusHeading: true });
  });
});
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
  const exportAnchor = document.querySelector('.export-anchor');
  if (exportPopoverOpen && exportAnchor && !exportAnchor.contains(event.target)) {
    exportPopoverOpen = false;
    syncExportPanel();
  }
  const versionAnchor = document.querySelector('#versionPillSlot');
  if (versionSheetOpen && !phoneLayout() && versionAnchor && !versionAnchor.contains(event.target)) closeVersionSheet();
});
document.addEventListener('keydown', (event) => {
  if (!versionSheetOpen) return;
  const sheet = document.querySelector('#versionSheet');
  if (!sheet) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    closeVersionSheet({ returnFocus: true });
    return;
  }
  if (event.key !== 'Tab' || !phoneLayout()) return;
  const focusable = sheetFocusable(sheet);
  if (!focusable.length) {
    event.preventDefault();
    sheet.focus();
    return;
  }
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && (document.activeElement === first || !sheet.contains(document.activeElement))) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && (document.activeElement === last || !sheet.contains(document.activeElement))) {
    event.preventDefault();
    first.focus();
  }
});
moreMenu.addEventListener('toggle', () => {
  if (!moreMenu.open) return;
  if (exportPopoverOpen) {
    exportPopoverOpen = false;
    syncExportPanel();
  }
  if (versionSheetOpen) closeVersionSheet();
});
moreMenu.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    event.preventDefault();
    closeMoreMenu({ returnFocus: true });
  }
});
moreMenu.querySelectorAll('button').forEach((control) => {
  control.addEventListener('click', () => closeMoreMenu({ returnFocus: true }));
});
function updateFormatLabel() {
  const label = document.querySelector('#formatLabel');
  if (!label) return;
  const sizeLabel = document.documentElement.classList.contains('page-a4') ? 'A4' : 'Letter';
  const suffix = `${sizeLabel} / selectable text`;
  const version = activeVersion();
  label.textContent = version ? `${version.name} · ${suffix}` : suffix;
}
function updatePrintPageSize(size = selectedChoice('paperSize', 'letter')) {
  const normalizedSize = size === 'a4' ? 'a4' : 'letter';
  document.documentElement.classList.toggle('page-a4', normalizedSize === 'a4');
  document.documentElement.classList.toggle('page-letter', normalizedSize === 'letter');
  updateFormatLabel();
}
function applyPreviewTextSize(size = selectedChoice('textSize', 'standard')) {
  const preview = document.querySelector('#resumePreview');
  if (!preview) return;
  const normalized = Object.hasOwn(PDF_TEXT_SIZES, size) ? size : 'standard';
  preview.classList.remove('preview-text-compact', 'preview-text-standard', 'preview-text-large');
  preview.classList.add(`preview-text-${normalized}`);
}
document.querySelectorAll('input[name="paperSize"]').forEach((input) => {
  input.addEventListener('change', () => {
    if (input.checked) updatePrintPageSize(input.value);
  });
});
document.querySelectorAll('input[name="textSize"]').forEach((input) => {
  input.addEventListener('change', () => {
    if (input.checked) applyPreviewTextSize(input.value);
  });
});
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
    showEditorSection('contact');
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
document.querySelector('#exportFilename').addEventListener('input', (event) => {
  const version = activeVersion();
  if (version) {
    version.exportName = event.target.value.trim() ? event.target.value : '';
    event.target.removeAttribute('data-edited');
  } else {
    event.target.dataset.edited = 'true';
    resumeData.exportName = event.target.value;
  }
  scheduleSave();
});
document.querySelector('#exportFilename').addEventListener('blur', (event) => {
  const version = activeVersion();
  if (!version) return;
  if (typeof version.exportName === 'string' && version.exportName.trim()) return;
  event.target.value = defaultExportFilename();
});
document.querySelector('#versionTitle').addEventListener('input', (event) => {
  const version = activeVersion();
  if (!version) return;
  version.title = event.target.value.slice(0, 200);
  updatePreview();
  scheduleSave();
});
document.querySelector('#versionSummary').addEventListener('input', (event) => {
  const version = activeVersion();
  if (!version) return;
  version.summary = event.target.value.slice(0, 500);
  const count = document.querySelector('#versionSummaryCount');
  if (count) count.textContent = `${version.summary.length} / 500`;
  updatePreview();
  scheduleSave();
});
document.querySelector('#exportButton').addEventListener('click', downloadBackup);
document.querySelector('#copyPlainTextButton').addEventListener('click', copyPlainText);
document.querySelector('#downloadPlainTextButton').addEventListener('click', () => downloadPlainText(currentExportData()));
document.querySelector('#versionPill').addEventListener('click', () => {
  if (versionSheetOpen) closeVersionSheet({ returnFocus: true });
  else openVersionSheet();
});
document.querySelector('#versionSheetBackdrop').addEventListener('click', () => closeVersionSheet({ returnFocus: true }));
document.querySelector('#versionBannerTailor').addEventListener('click', enterTailorMode);
document.querySelector('#tailorFromSheetButton').addEventListener('click', enterTailorMode);
document.querySelector('#tailorDoneButton').addEventListener('click', () => leaveTailorMode({ focusHeading: true }));
document.querySelector('#newVersionButton').addEventListener('click', createNewVersion);
document.querySelector('#renameVersionButton').addEventListener('click', openVersionRename);
document.querySelector('#duplicateVersionButton').addEventListener('click', duplicateActiveVersion);
document.querySelector('#deleteVersionButton').addEventListener('click', deleteActiveVersion);
document.querySelector('#versionRenameSave').addEventListener('click', saveVersionName);
document.querySelector('#versionRenameCancel').addEventListener('click', () => closeVersionRename(true));
document.querySelector('#versionRenameInput').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    saveVersionName();
  } else if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    closeVersionRename(true);
  }
});
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
      resumeData = normalized.master;
      cvVersions = normalized.versions;
      activeVersionId = null;
      document.querySelector('#exportFilename').removeAttribute('data-edited');
      renderFields(); updatePreview(); updateCompletion();
      showEditorSection('contact');
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
document.querySelector('#undoRemovalButton').addEventListener('click', () => {
  if (pendingVersionRemoval) undoVersionRemoval();
  else undoEntryRemoval();
});
document.querySelector('#backupReminderDownload').addEventListener('click', () => {
  downloadBackup();
  hideBackupReminder();
});
document.querySelector('#backupReminderLater').addEventListener('click', () => {
  snoozeBackupReminder(BACKUP_REMINDER_LATER_MS);
});
document.querySelector('#backupReminderSnooze').addEventListener('click', () => {
  snoozeBackupReminder(BACKUP_REMINDER_WEEK_MS);
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
  showStorageUnavailableNotice(storageWriteFailed
    ? 'Browser storage could not be written. Changes are not being saved.'
    : undefined);
  setImportStatus(
    storageWriteFailed ? 'Not saving: storage unavailable' : 'Saved data could not be loaded; saving is blocked',
    true
  );
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
  const sectionNav = document.querySelector('.section-nav');
  root.style.setProperty('--notice-height', `${noticeStack.getBoundingClientRect().height}px`);
  root.style.setProperty('--topbar-height', `${topbar.getBoundingClientRect().height}px`);
  const navIsSticky = sectionNav && getComputedStyle(sectionNav).position === 'sticky';
  const navHeight = navIsSticky ? sectionNav.getBoundingClientRect().height : 0;
  root.style.setProperty('--section-nav-offset', `${navHeight}px`);
  const topbarBottom = topbar.getBoundingClientRect().bottom;
  const chromeBelowTopbar = (element) => {
    if (!element || element.hidden || element.closest('[hidden]')) return 0;
    const box = element.getBoundingClientRect();
    if (box.height <= 0) return 0;
    const margin = Number.parseFloat(getComputedStyle(element).marginBottom) || 0;
    return Math.max(0, box.bottom + margin - topbarBottom);
  };
  let bannerHeight = chromeBelowTopbar(document.querySelector('#versionBanner'));
  const tailorPanel = document.querySelector('#tailorPanel');
  if (tailorPanel && !tailorPanel.hidden) {
    bannerHeight = Math.max(bannerHeight, chromeBelowTopbar(tailorPanel.querySelector('.tailor-bar')));
  }
  root.style.setProperty('--banner-height', `${Math.ceil(bannerHeight)}px`);
}

updateStickyOffsets();
if (typeof ResizeObserver === 'function') {
  const stickyOffsetObserver = new ResizeObserver(updateStickyOffsets);
  stickyOffsetObserver.observe(document.querySelector('#noticeStack'));
  stickyOffsetObserver.observe(document.querySelector('.topbar'));
  stickyOffsetObserver.observe(document.querySelector('.section-nav'));
  stickyOffsetObserver.observe(document.querySelector('#versionBanner'));
  stickyOffsetObserver.observe(document.querySelector('#tailorPanel'));
} else {
  window.addEventListener('resize', updateStickyOffsets);
}