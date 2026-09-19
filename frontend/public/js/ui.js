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

window.UI = { el, clear, showBanner, friendlyErrorMessage };
