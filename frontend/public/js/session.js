/**
 * session.js — owns everything about "am I logged in and as whom".
 *
 * SECURITY NOTES (read before changing storage strategy):
 *
 * 1. The backend (authController.js) issues a stateless JWT and has no
 *    server-side session store and no cookie support — the client MUST
 *    hold the token and send it as `Authorization: Bearer <token>`.
 *    That means there is no way to avoid *some* client-side storage of
 *    the token with this backend as written.
 *
 * 2. We use sessionStorage, not localStorage:
 *      - it's cleared when the tab/window closes (shorter exposure window)
 *      - it's per-tab, so a token from one tab isn't silently reused by
 *        code running in another
 *    localStorage would persist indefinitely and is a strictly worse
 *    default for a bearer token.
 *
 * 3. Both are readable by any JS running on the page, i.e. vulnerable to
 *    XSS. We reduce that risk elsewhere (never using innerHTML with
 *    unescaped data — see ui.js) but the strongest fix is out of the
 *    frontend's hands: the backend would need to switch to an httpOnly,
 *    Secure, SameSite=Strict cookie + CSRF token, which a script on the
 *    page can't read at all. That's called out in the README as the
 *    recommended next step for production.
 *
 * 4. We never persist the password, ever — not even transiently in a
 *    variable longer than the fetch call needs it for.
 *
 * 5. The JWT's own `exp` claim is decoded client-side purely for UX
 *    (proactively signing the user out / hiding the token before it's
 *    even sent). The server is the real enforcer of expiry — the client
 *    check is a convenience, not a security boundary.
 */

const STORAGE_KEY = 'tournament_app.session.v1';

function base64UrlDecode(str) {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/').padEnd(str.length + ((4 - (str.length % 4)) % 4), '=');
  try {
    return decodeURIComponent(
      atob(padded)
        .split('')
        .map((c) => '%' + c.charCodeAt(0).toString(16).padStart(2, '0'))
        .join('')
    );
  } catch {
    return null;
  }
}

function decodeJwt(token) {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const payloadRaw = base64UrlDecode(parts[1]);
  if (!payloadRaw) return null;
  try {
    return JSON.parse(payloadRaw);
  } catch {
    return null;
  }
}

function isExpired(payload) {
  if (!payload || typeof payload.exp !== 'number') return false; // can't tell — let the server decide
  const nowSeconds = Date.now() / 1000;
  return payload.exp <= nowSeconds;
}

function read() {
  const raw = sessionStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    sessionStorage.removeItem(STORAGE_KEY);
    return null;
  }
}

function write(session) {
  sessionStorage.setItem(STORAGE_KEY, JSON.stringify(session));
}

const Session = {
  /** Store a fresh token + the user object the API returned alongside it. */
  start(token, user) {
    const payload = decodeJwt(token);
    write({
      token,
      user,
      expiresAt: payload?.exp ? payload.exp * 1000 : null,
    });
  },

  /** Clear everything. Call on logout, on 401 responses, and on expiry. */
  end() {
    sessionStorage.removeItem(STORAGE_KEY);
  },

  getToken() {
    const s = read();
    if (!s) return null;
    if (s.expiresAt && Date.now() >= s.expiresAt) {
      this.end();
      return null;
    }
    return s.token;
  },

  getUser() {
    const s = read();
    if (!s) return null;
    if (s.expiresAt && Date.now() >= s.expiresAt) {
      this.end();
      return null;
    }
    return s.user || null;
  },

  isAuthenticated() {
    return Boolean(this.getToken());
  },

  /**
   * Schedules an automatic logout right when the token expires, so a
   * user sitting on the page doesn't keep acting as "logged in" in the
   * UI after their token has silently gone stale server-side.
   * Returns a cancel function.
   */
  scheduleExpiryLogout(onExpire) {
    const s = read();
    if (!s?.expiresAt) return () => {};
    const ms = s.expiresAt - Date.now();
    if (ms <= 0) {
      this.end();
      onExpire?.();
      return () => {};
    }
    const timer = setTimeout(() => {
      Session.end();
      onExpire?.();
    }, ms);
    return () => clearTimeout(timer);
  },
};

window.Session = Session;
