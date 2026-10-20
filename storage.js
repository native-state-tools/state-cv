(function (root) {
  'use strict';

  function createStorage(storage) {
    if (storage === undefined) {
      try {
        storage = root.localStorage;
      } catch (error) {
        storage = null;
      }
    }

    function requireStorage() {
      if (!storage) throw new Error('Browser storage is unavailable in this context.');
      return storage;
    }

    function parseRevision(raw) {
      if (raw === null) return 0;
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch (error) {
        const damagedError = new Error('Saved data is not valid JSON.');
        damagedError.code = 'damaged';
        throw damagedError;
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        const damagedError = new Error('Saved data is not a valid object.');
        damagedError.code = 'damaged';
        throw damagedError;
      }
      if (!Object.hasOwn(parsed, 'revision')) return 0;
      if (!Number.isInteger(parsed.revision) || parsed.revision < 1) {
        const damagedError = new Error('Saved data has an invalid revision.');
        damagedError.code = 'damaged';
        throw damagedError;
      }
      return parsed.revision;
    }

    return {
      getItem(key) {
        return requireStorage().getItem(key);
      },
      setItem(key, value) {
        requireStorage().setItem(key, value);
      },
      removeItem(key) {
        requireStorage().removeItem(key);
      },
      getDataRevision(key) {
        return parseRevision(requireStorage().getItem(key));
      },
      writeData(key, data, expectedRevision, force = false) {
        const target = requireStorage();
        const currentRevision = parseRevision(target.getItem(key));
        if (!force && currentRevision !== expectedRevision) {
          const conflictError = new Error('Saved data changed in another tab.');
          conflictError.code = 'conflict';
          conflictError.actualRevision = currentRevision;
          throw conflictError;
        }
        const revision = currentRevision + 1;
        target.setItem(key, JSON.stringify({ ...data, revision }));
        return revision;
      }
    };
  }

  root.StateCVStorage = createStorage;
})(typeof globalThis === 'object' ? globalThis : this);
