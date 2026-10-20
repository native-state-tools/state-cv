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

    return {
      getItem(key) {
        return requireStorage().getItem(key);
      },
      setItem(key, value) {
        requireStorage().setItem(key, value);
      },
      removeItem(key) {
        requireStorage().removeItem(key);
      }
    };
  }

  root.StateCVStorage = createStorage;
})(typeof globalThis === 'object' ? globalThis : this);
