(function (root) {
  function createActivityTracker(onChange = () => {}) {
    const activeRequests = new Map();
    let nextId = 0;

    function snapshot() {
      let processing = 0;
      activeRequests.forEach((isMutation) => {
        if (isMutation) processing += 1;
      });
      return {
        count: activeRequests.size,
        processing,
      };
    }

    function notify() {
      onChange(snapshot());
    }

    function begin(method) {
      const id = ++nextId;
      activeRequests.set(id, !['GET', 'HEAD', 'OPTIONS'].includes(String(method).toUpperCase()));
      notify();
      let ended = false;
      return () => {
        if (ended) return;
        ended = true;
        activeRequests.delete(id);
        notify();
      };
    }

    return {
      begin,
      run(method, operation) {
        return Promise.resolve().then(operation).finally(begin(method));
      },
      snapshot,
    };
  }

  const api = { createActivityTracker };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.PageActivityTracker = api;
})(globalThis);

(function () {
  if (typeof document === 'undefined' || typeof window === 'undefined') return;
  const page = document.querySelector('.page');
  if (!page || !window.PageActivityTracker) return;

  const message = document.createElement('span');
  const indicator = document.createElement('span');
  indicator.className = 'page-busy-overlay__spinner';
  indicator.setAttribute('aria-hidden', 'true');

  const panel = document.createElement('div');
  panel.className = 'page-busy-overlay__panel';
  panel.setAttribute('role', 'status');
  panel.setAttribute('aria-live', 'polite');
  panel.append(indicator, message);

  const overlay = document.createElement('div');
  overlay.className = 'page-busy-overlay';
  overlay.hidden = true;
  overlay.appendChild(panel);
  document.body.appendChild(overlay);

  const wasInert = page.inert;
  const tracker = window.PageActivityTracker.createActivityTracker(({ count, processing }) => {
    const busy = count > 0;
    overlay.hidden = !busy;
    page.inert = busy || wasInert;
    if (busy) page.setAttribute('aria-busy', 'true');
    else page.removeAttribute('aria-busy');
    message.textContent = processing ? 'Processing your request…' : 'Loading tournament data…';
  });
  window.PageActivity = tracker;
})();
