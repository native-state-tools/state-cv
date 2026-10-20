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

    function readSnapshots(target) {
      const raw = target.getItem('state-cv-snapshots-v1');
      if (raw === null) return [];
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) throw new Error('Saved snapshots are not a valid list.');
      return parsed;
    }

    function writeSnapshotList(target, snapshots) {
      const list = snapshots.slice(-5);
      while (true) {
        try {
          target.setItem('state-cv-snapshots-v1', JSON.stringify(list));
          return list;
        } catch (error) {
          if (list.length <= 1) throw error;
          list.shift();
        }
      }
    }

    function writeDataWithEviction(target, key, value) {
      try {
        target.setItem(key, value);
      } catch (initialError) {
        let snapshots;
        try {
          snapshots = readSnapshots(target);
        } catch (error) {
          throw initialError;
        }
        while (snapshots.length) {
          snapshots.shift();
          try {
            target.setItem('state-cv-snapshots-v1', JSON.stringify(snapshots));
          } catch (error) {
            continue;
          }
          try {
            target.setItem(key, value);
            return;
          } catch (error) {
            initialError = error;
          }
        }
        throw initialError;
      }
    }

    return {
      getItem(key) {
        return requireStorage().getItem(key);
      },
      setItem(key, value) {
        writeDataWithEviction(requireStorage(), key, value);
      },
      removeItem(key) {
        requireStorage().removeItem(key);
      },
      getDataRevision(key) {
        return parseRevision(requireStorage().getItem(key));
      },
      writeData(key, data, expectedRevision, force = false) {
        const target = requireStorage();
        let currentRevision;
        try {
          currentRevision = parseRevision(target.getItem(key));
        } catch (error) {
          if (!force) throw error;
          currentRevision = expectedRevision;
        }
        if (!force && currentRevision !== expectedRevision) {
          const conflictError = new Error('Saved data changed in another tab.');
          conflictError.code = 'conflict';
          conflictError.actualRevision = currentRevision;
          throw conflictError;
        }
        const revision = currentRevision + 1;
        writeDataWithEviction(target, key, JSON.stringify({ ...data, revision }));
        return revision;
      },
      readSnapshots() {
        return readSnapshots(requireStorage());
      },
      addSnapshot(snapshot) {
        const target = requireStorage();
        const snapshots = readSnapshots(target);
        snapshots.push(snapshot);
        return writeSnapshotList(target, snapshots);
      },
      preserveDamagedData(raw) {
        writeDataWithEviction(requireStorage(), 'state-cv-damaged-v1', raw);
      },
      clearAll() {
        const target = requireStorage();
        const keys = [
          'state-cv-snapshots-v1',
          'state-cv-damaged-v1',
          'state-cv-persistence-v1',
          'state-cv-data-v1'
        ];
        const previous = new Map(keys.map((key) => [key, target.getItem(key)]));
        try {
          keys.forEach((key) => target.removeItem(key));
        } catch (error) {
          let restoreError = null;
          previous.forEach((value, key) => {
            if (value === null) return;
            try {
              target.setItem(key, value);
            } catch (failure) {
              restoreError = failure;
            }
          });
          const clearError = new Error(restoreError
            ? 'Clear all data failed and some saved items could not be restored.'
            : 'Clear all data failed; the saved items were restored.');
          clearError.cause = error;
          throw clearError;
        }
      }
    };
  }

  root.StateCVStorage = createStorage;
})(typeof globalThis === 'object' ? globalThis : this);
