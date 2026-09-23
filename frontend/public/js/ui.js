/**
 * ui.js — tiny DOM helpers.
 *
 * SECURITY: `el()` builds elements with createElement + textContent, never
 * innerHTML, so data coming back from the API (tournament names, user
 * names, etc.) can never be interpreted as HTML/script. Anywhere in this
 * app you see `.textContent = value`, that's deliberate — it's the safe
 * counterpart to `.innerHTML = value`, which we don't use for API data
 * anywhere in this codebase.
 */

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
    else if (value !== undefined && value !== null) node.setAttribute(key, value);
  }
  for (const child of [].concat(children)) {
    if (child == null) continue;
    node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

function showBanner(node, message, kind = 'error') {
  clear(node);
  if (!message) {
    node.hidden = true;
    return;
  }
  node.hidden = false;
  node.className = `banner banner--${kind}`;
  node.textContent = message; // never innerHTML — message may echo user/API input
}

/** Generic, non-leaky error text for anything unexpected from the network layer. */
function friendlyErrorMessage(err) {
  if (err && err.isApiError) {
    // Server-provided error strings (e.g. "Invalid credentials") are safe
    // to show verbatim — they're written for end users by the API itself.
    return err.message || 'Something went wrong. Please try again.';
  }
  return 'We couldn\u2019t reach the server. Check your connection and try again.';
}

function confirmAction(title, message, confirmLabel = 'Confirm') {
  return new Promise((resolve) => {
    const cancel = () => finish(false);
    const confirm = () => finish(true);
    const backdrop = el('div', { class: 'modal-backdrop app-confirm-backdrop' }, [
      el('section', { class: 'modal app-confirm', role: 'alertdialog', 'aria-modal': 'true', 'aria-labelledby': 'app-confirm-title' }, [
        el('h2', { id: 'app-confirm-title', text: title }),
        el('p', { class: 'app-confirm__message', text: message }),
        el('div', { class: 'modal__actions' }, [
          el('button', { class: 'btn btn--ghost', type: 'button', text: 'Cancel', onclick: cancel }),
          el('button', { class: 'btn btn--primary', type: 'button', text: confirmLabel, onclick: confirm }),
        ]),
      ]),
    ]);

    function finish(value) {
      backdrop.remove();
      document.removeEventListener('keydown', onKeyDown);
      resolve(value);
    }

    function onKeyDown(event) {
      if (event.key === 'Escape') cancel();
    }

    backdrop.addEventListener('click', (event) => {
      if (event.target === backdrop) cancel();
    });
    document.addEventListener('keydown', onKeyDown);
    document.body.appendChild(backdrop);
    backdrop.querySelector('button.btn--primary').focus();
  });
}

function pageState(scope) {
  const key = `tournament_app.page-state.${scope}.${location.pathname}${location.search}`;
  let saved = {};
  try {
    saved = JSON.parse(sessionStorage.getItem(key) || '{}') || {};
  } catch {
    saved = {};
  }

  function save(patch = {}) {
    saved = { ...saved, ...patch, scrollY: window.scrollY };
    sessionStorage.setItem(key, JSON.stringify(saved));
  }

  const persistScroll = () => save();
  window.addEventListener('pagehide', persistScroll);

  return {
    get(name, fallback = null) {
      return saved[name] ?? fallback;
    },
    save,
    restoreScroll() {
      const scrollY = Number(saved.scrollY);
      if (!Number.isFinite(scrollY) || scrollY < 1) return;
      const restore = (attempt = 0) => {
        const maxScroll = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
        window.scrollTo({ top: Math.min(scrollY, maxScroll), behavior: 'auto' });
        if (attempt < 8 && maxScroll < scrollY) {
          requestAnimationFrame(() => restore(attempt + 1));
        }
      };
      requestAnimationFrame(() => restore());
    },
  };
}

window.UI = { el, clear, showBanner, friendlyErrorMessage, confirmAction, pageState };
