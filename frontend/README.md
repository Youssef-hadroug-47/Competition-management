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
| `public/index.html` | Home — left wireframe (logged out: logo, login/register buttons, exact-name tournament search, "création des tournois" CTA, public tournaments) or right wireframe (logged in: logo, profile circle with a menu, "My tournaments", "les tournois favoris", exact-name tournament search, "création des tournois", public tournaments) depending on session state. Private tournaments are excluded from the normal list, but exact-name search can reveal a locked private result. |
| `public/tournament.html` | One tournament — info, role-protected draw control, matches, standings/bracket (stage-scoped toggle), top scorers/assisters, registered teams/rosters, private-tournament follower moderation, and creator-only staff management. Reachable from every tournament row/card on the site. |
| `public/create-tournament.html` | Authenticated two-phase tournament builder. Collects general information, then uses a stage navigator with balanced team-count presets, league points, responsive group cards, direct advancement defaults for ranks 1–2, optional best-ranking places and knockout rounds before submitting through the existing API helpers. |
| `public/login.html` | Sign in |
| `public/register.html` | Create account |

## Tournament detail page (`tournament.html?id=<tournamentId>`)

Linked from every tournament reference on the site — public list rows and
favorite cards both wrap the tournament name in a link built by
`tournamentHref()` in `home.js`, so there's exactly one place that owns
the URL shape.

- **Info**: name, visibility, place, status, team count, created date,
  plus a Follow/Unfollow toggle when signed in. The tournament creator also
  gets a permanent-delete action protected by the in-app confirmation modal;
  moderators do not get this control.
- **Private followers**: private tournaments expose a Followers tab to the
  creator and tournament moderators. It lists follower statuses and lets
  moderators accept or reject pending requests through the protected API.
- **Staff management**: the creator gets a Staff management tab backed by the
  tournament role endpoints. It finds users by exact email through a
  creator-only lookup that returns minimal profile data, then assigns a user
  as a moderator or referee, changes assignments, and removes assignments.
  User IDs remain internal identifiers rather than credentials, and the
  creator's own moderator assignment is protected in the UI and backend.
- **Navigation state**: page views persist their scroll position in the
  current browser tab. The tournament page also persists the selected primary
  tab, standings stage, and match grouping filter, so refreshes and
  simulation/actions return to the same browsing context without moving
  keyboard focus.
- **Matches**: a flat, sorted list — every match in the tournament,
  independent of the stage toggle below.
- **Standings / bracket**: one tab per stage; only the selected stage's
  content is ever rendered. A `league` stage shows a standings table per
  group (computed client-side from `participant_teams`' running stats —
  there's no dedicated standings endpoint). A `knockout` stage shows a
  round-by-round bracket built from `rounds` + the matches whose
  `groupId` points at that round. See the comment above
  `standingsSort()` in `tournament.js` for the (deliberately simplified —
  no head-to-head) tiebreak order.
  Knockout pairings with multiple legs are shown as one aggregate card with
  the combined regulation score and each leg listed beneath it. Extra time
  and penalties are treated as deciders from the final leg only.
- **Top scorers / assisters**: there's no aggregate endpoint for this
  either, so the page fetches every participant team's roster in
  parallel (`Promise.allSettled`, so one team's failure doesn't blank the
  whole list) and ranks client-side. Fine for normal tournament sizes;
  would want a real backend aggregate if rosters get very large.
- **Teams & players**: all viewers who can inspect a tournament can see
  the available catalog plus registered teams and rosters. Tournament
  moderators can register catalog teams and assign catalog players, including
  seed, nickname, shirt number, role, and status. Global admins can use the
  reuse-first automatic filling actions for the tournament team count and a
  selected roster size; placeholder catalog records are created only when
  necessary.
  Admins also get forms on this tab to create reusable catalog teams and
  players.

**Security specifics for this page** (in addition to the app-wide notes
below): the `?id=` value is checked against a strict allow-list pattern
before any request is made, and — like every other id anywhere in this
app — is passed through `enc()` in `api.js`, which `encodeURIComponent`s
it so it can only ever fill one path segment. Private-tournament access
is enforced entirely server-side; creators and users with an accepted follow
can inspect private tournaments, while other users need approval. This page just relays whatever the API decides (200
renders it, 403 shows the server's own message, 404 says so) rather than
guessing at visibility itself.

## Code layout

- `public/js/config.js` — generated, browser-safe (`API_BASE_URL` only)
- `public/js/session.js` — all JWT/session storage and expiry logic
- `public/js/api.js` — the only file that calls `fetch`; one function per
  backend endpoint in `API_REFERENCE.md`, grouped by resource. Every ID
  interpolated into a URL goes through `enc()` (`encodeURIComponent`).
- `public/js/ui.js` — safe DOM helpers (`textContent`, never `innerHTML`,
  for anything that touches API or user data)
- `public/js/header.js` — the shared topbar/profile-menu, used by every
  page so the auth-state UI only exists in one place
- `public/js/home.js`, `login.js`, `register.js`, `tournament.js` — one
  controller per page

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
then re-fetch the favorites panel. Public tournaments appear in the normal
home list; private tournaments are discoverable only by exact-name search and
create a pending request until a moderator accepts it. An inaccessible
private search result is visibly locked, while its detail page still enforces
the server-side inspection check.

⚠️ If you register the new route in `index.js`, put it **before**
`router.get('/tournaments/:tournamentId', ...)`. Express matches routes
in declaration order, so `GET /tournaments/followed` registered after
the `:tournamentId` route will never be reached — `followed` will be
captured as a `tournamentId` value instead. See the note in
`API_REFERENCE.md` under **Follows**.
