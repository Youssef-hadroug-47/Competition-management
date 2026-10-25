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
  const booleanAttributes = new Set([
    'allowfullscreen', 'async', 'autofocus', 'autoplay', 'checked', 'controls',
    'defer', 'disabled', 'formnovalidate', 'hidden', 'inert', 'ismap', 'loop',
    'multiple', 'muted', 'nomodule', 'novalidate', 'open', 'playsinline',
    'readonly', 'required', 'reversed', 'selected',
  ]);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
    else if (booleanAttributes.has(key.toLowerCase())) {
      if (value) node.setAttribute(key, '');
    }
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

let flashTimer = null;

function showBanner(node, message, kind = 'error') {
  if (!message) {
    if (node) {
      clear(node);
      node.hidden = true;
    }
    return;
  }
  flashMessage(message, kind);
  if (node) {
    clear(node);
    node.hidden = true;
  }
}

function flashMessage(message, kind = 'error', duration = 3600) {
  const text = String(message || '');
  const readingDuration = Math.ceil(text.length / 15) * 1000;
  const displayDuration = Math.max(duration, Math.min(12000, 3600 + readingDuration));
  let node = document.getElementById('app-flash-message');
  if (!node) {
    node = el('div', {
      id: 'app-flash-message',
      class: 'flash-message',
      role: 'status',
      'aria-live': 'polite',
    });
    document.body.appendChild(node);
  }
  clearTimeout(flashTimer);
  node.className = `flash-message flash-message--${kind}`;
  node.textContent = text;
  node.hidden = !text;
  if (!text) return;
  requestAnimationFrame(() => node.classList.add('flash-message--visible'));
  flashTimer = setTimeout(() => {
    hideFlash();
  }, displayDuration);
}

function hideFlash() {
  const node = document.getElementById('app-flash-message');
  if (!node) return;
  node.classList.remove('flash-message--visible');
  setTimeout(() => {
    if (!node.classList.contains('flash-message--visible')) node.hidden = true;
  }, 220);
}

/** Generic, non-leaky error text for anything unexpected from the network layer. */
function friendlyErrorMessage(err) {
  console.log(err);
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

/**
 * Wires an "email verification resend" form: shows it on demand, submits the
 * address, and keeps the button disabled during the server-side cooldown.
 * Returns `{ show(email), cooldown(seconds) }` so the login/register pages can
 * surface the form at the exact moment the API says verification is missing.
 */
function wireVerificationResend(form, emailInput, banner) {
  const button = form.querySelector('button[type="submit"]');
  const idleLabel = button.textContent;
  let countdown = null;

  function stopCountdown() {
    if (countdown) clearInterval(countdown);
    countdown = null;
  }

  function setIdle() {
    stopCountdown();
    button.disabled = false;
    button.textContent = idleLabel;
  }

  function startCooldown(seconds) {
    stopCountdown();
    let remaining = Math.max(0, Math.ceil(Number(seconds) || 0));
    if (remaining <= 0) {
      setIdle();
      return;
    }
    button.disabled = true;
    const render = () => {
      button.textContent = `Resend in ${remaining}s`;
    };
    render();
    countdown = setInterval(() => {
      remaining -= 1;
      if (remaining <= 0) setIdle();
      else render();
    }, 1000);
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    UI.showBanner(banner, '');
    const email = emailInput.value.trim();
    if (!email) {
      UI.showBanner(banner, 'Enter your email address.');
      return;
    }
    stopCountdown();
    button.disabled = true;
    button.textContent = 'Sending…';
    try {
      const result = await Api.auth.resendVerification(email);
      UI.flashMessage(result.message, 'success');
      startCooldown(60);
    } catch (err) {
      UI.showBanner(banner, UI.friendlyErrorMessage(err));
      if (err.status === 429) startCooldown(err.details?.retryAfterSeconds || 60);
      else setIdle();
    }
  });

  return {
    show(email) {
      form.hidden = false;
      if (typeof email === 'string' && email) emailInput.value = email;
      requestAnimationFrame(() => {
        emailInput.focus();
        form.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      });
    },
    cooldown(seconds) {
      startCooldown(seconds);
    },
  };
}

window.UI = { el, clear, showBanner, flashMessage, friendlyErrorMessage, confirmAction, pageState, wireVerificationResend };
