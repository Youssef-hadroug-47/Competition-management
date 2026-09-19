# Tournly frontend

A small static frontend (no build tool, no framework) for the Tournament
API documented in `API_REFERENCE.md`: a home page that changes shape
depending on whether you're signed in, plus login/register pages.

## Setup

```bash
cp .env.example .env
# edit .env: point API_HOST / API_PORT at your running backend
npm start
```

`npm start` runs `scripts/generate-config.js` (turns your `.env` into
`public/js/config.js`, the only place the API's base URL is read from
in the browser) and then serves `public/` on `APP_PORT` (default 5173)
via `npx serve`.

Run `npm run build:config` on its own any time you change `.env` while
the static server is still running — refresh the browser afterwards.

## Pages

| File | Maps to |
|---|---|
| `public/index.html` | Home — left wireframe (logged out: logo, login/register buttons, "création des tournois" CTA, public tournaments) or right wireframe (logged in: logo, profile circle with a menu, "les tournois favoris", "création des tournois", public tournaments) depending on session state |
| `public/login.html` | Sign in |
| `public/register.html` | Create account |

## Code layout

- `public/js/config.js` — generated, browser-safe (`API_BASE_URL` only)
- `public/js/session.js` — all JWT/session storage and expiry logic
- `public/js/api.js` — the only file that calls `fetch`; one function per
  backend endpoint in `API_REFERENCE.md`, grouped by resource
- `public/js/ui.js` — safe DOM helpers (`textContent`, never `innerHTML`,
  for anything that touches API or user data)
- `public/js/home.js`, `login.js`, `register.js` — one controller per page

## Security decisions, and their limits

This backend (`authController.js`) issues a **stateless JWT** with no
server-side session store and no cookie support. That constrains what a
frontend can responsibly do:

- **Storage**: the token lives in `sessionStorage`, not `localStorage`.
  It disappears when the tab closes and isn't shared across tabs. This
  is *not* immune to XSS (nothing purely client-side is) — see below.
- **XSS surface reduction**: every place API/user data reaches the DOM
  goes through `UI.el()`/`textContent`, never `innerHTML`. There is no
  `eval`, no `dangerouslySetInnerHTML`-equivalent, anywhere in this app.
- **CSP**: each page sets a restrictive `Content-Security-Policy` meta
  tag (self + Google Fonts only, no inline scripts, no plugins, no
  framing). A real deployment should also set this as a response
  header, which can't be stripped by a proxy the way a meta tag can.
- **CSRF**: not a meaningful risk *for this app* — requests carry an
  `Authorization` header the browser never attaches automatically
  (unlike cookies), and `credentials: 'omit'` in `api.js` means no
  ambient cookie auth is sent either.
- **Expiry handling**: the JWT's `exp` claim is decoded client-side to
  proactively sign the user out and to attach a same-tab timer
  (`Session.scheduleExpiryLogout`). This is a UX nicety, not enforcement
  — the server is always the real authority, and every `api.js` call
  reacts to a `401` by clearing the session and redirecting to
  `/login.html`.
- **Open-redirect guard**: `login.html?next=` only ever redirects to a
  same-origin path (`login.js#safeNextPath`), rejecting absolute URLs
  and protocol-relative (`//evil.com`) values.
- **No password persistence**: password fields are cleared immediately
  after a successful submit and are never written to storage, only held
  in a form field long enough to be sent once.
- **Generic auth errors**: the login form shows the backend's own
  message verbatim ("Invalid credentials") rather than a more specific
  one, so the frontend doesn't accidentally start revealing whether an
  email exists.
- **Debounced submits**: every form disables its submit button for the
  duration of the request, so a double-click can't fire the request
  twice.

### What this *can't* fix from the frontend alone

Bearer-token-in-JS-storage is fundamentally weaker than an httpOnly
cookie, because any successful XSS on the page can read
`sessionStorage`. If/when the backend can be changed, the stronger
setup is:

1. `/auth/login` and `/auth/register` set an `httpOnly`, `Secure`,
   `SameSite=Strict` cookie instead of returning the JWT in the response
   body.
2. The server issues and checks a separate CSRF token (double-submit
   cookie or synchronizer token) on state-changing requests, since
   cookie auth *is* attached automatically by the browser.
3. `api.js` switches `credentials: 'omit'` → `'include'` and drops the
   `Authorization` header entirely.

That's a backend change, so it's out of scope here, but the frontend is
structured (all requests behind `api.js`, all session logic behind
`session.js`) so that swap would only touch those two files.

## "Favorite" tournaments

The wireframe's authenticated home page's "les tournois favoris" panel
is backed by `GET /tournaments/followed` (`Api.follows.listFollowed` in
`api.js`), which returns the current user's followed tournaments
directly. Each public-list row also gets a **Follow** button once
signed in, and each favorite card gets an **Unfollow** button — both
call the existing `POST`/`DELETE /tournaments/:id/follow` endpoints and
then re-fetch the favorites panel.

⚠️ If you register the new route in `index.js`, put it **before**
`router.get('/tournaments/:tournamentId', ...)`. Express matches routes
in declaration order, so `GET /tournaments/followed` registered after
the `:tournamentId` route will never be reached — `followed` will be
captured as a `tournamentId` value instead. See the note in
`API_REFERENCE.md` under **Follows**.
