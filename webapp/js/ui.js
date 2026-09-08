/* ---------------------------------------------------------------------
 * ui.js — tiny DOM helpers. No virtual DOM, no framework: views just
 * build HTML strings, set them via innerHTML, then wire up listeners.
 * ------------------------------------------------------------------- */
const UI = (() => {
  function esc(str) {
    if (str === null || str === undefined) return '';
    return String(str)
      .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;');
  }

  function toast(message, type = 'error') {
    const host = document.getElementById('toasts');
    const div = document.createElement('div');
    div.className = `toast ${type}`;
    div.textContent = message;
    host.appendChild(div);
    setTimeout(() => div.remove(), 4500);
  }

  function errorMessage(err) {
    return err && err.message ? err.message : 'Something went wrong';
  }

  // Wrap an async click/submit handler: disables the button, shows a
  // spinner-ish label, surfaces errors as toasts.
  function guard(btn, fn) {
    return async (...args) => {
      const original = btn ? btn.textContent : null;
      if (btn) { btn.disabled = true; btn.dataset.busy = '1'; btn.textContent = '…'; }
      try {
        await fn(...args);
      } catch (err) {
        toast(UI.errorMessage(err));
      } finally {
        if (btn && btn.isConnected) { btn.disabled = false; btn.textContent = original; }
      }
    };
  }

  function fmtDate(iso) {
    if (!iso) return '—';
    try {
      const d = new Date(iso);
      if (isNaN(d.getTime())) return iso;
      return d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    } catch { return iso; }
  }

  function statusBadge(status) {
    return `<span class="badge status-${esc(status)}">${esc(status || 'unknown')}</span>`;
  }
  function roleBadge(role) {
    return `<span class="badge role-${esc(role)}">${esc(role)}</span>`;
  }

  function slugify(s) {
    return String(s || '')
      .toLowerCase().trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '');
  }

  function qs(sel, root = document) { return root.querySelector(sel); }
  function qsa(sel, root = document) { return [...root.querySelectorAll(sel)]; }

  return { esc, toast, errorMessage, guard, fmtDate, statusBadge, roleBadge, slugify, qs, qsa };
})();
