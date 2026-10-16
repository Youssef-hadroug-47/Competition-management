(function (root) {
  function createRequestCache() {
    const entries = new Map();

    return {
      getOrLoad(key, loader) {
        if (entries.has(key)) return entries.get(key);

        const request = Promise.resolve().then(loader);
        entries.set(key, request);
        request.catch(() => {
          if (entries.get(key) === request) entries.delete(key);
        });
        return request;
      },
      set(key, value) {
        const request = Promise.resolve(value);
        entries.set(key, request);
        return request;
      },
      isCurrent(key, request) {
        return entries.get(key) === request;
      },
      delete(key) {
        entries.delete(key);
      },
      clear() {
        entries.clear();
      },
    };
  }

  const api = { createRequestCache };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.RequestCache = api;
})(globalThis);
