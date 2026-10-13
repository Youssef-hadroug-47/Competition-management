# Tournament Manager API

Express REST API for creating and managing sports tournaments. Roles, private/public visibility, multi-stage formats, automatic draws, and tournament-scoped team/player entries.

Requires **Node.js 22.5+** and a PostgreSQL database.

## Setup

```bash
npm install
cp .env.example .env
# Set DATABASE_URL in .env before running the application.
npm run seed
npm start
```

API base URL: `http://localhost:3000/api`

The server initializes the PostgreSQL schema from `src/db/schema.sql` before
accepting requests. `DATABASE_SSL=true` enables TLS; set
`DATABASE_SSL_REJECT_UNAUTHORIZED=false` only when your PostgreSQL provider
requires a certificate that is not locally trusted. `DATABASE_POOL_MAX`
controls the connection-pool size.

For temporary latency diagnostics, set `PERFORMANCE_LOGGING=true`. The API
will log each request and database statement duration without logging query
parameters. Disable it after profiling because verbose request/query logging
adds overhead.

For browser-side timing on the tournament page, open DevTools and run:

```js
localStorage.setItem('apiDebug', 'true');
location.reload();
```

The browser console will show each API duration, the server
`X-Request-Id`, and tournament-page phases. Match the request ID with the API
server log to separate browser/network time from backend/database time. Disable
it with `localStorage.removeItem('apiDebug')`.

### Read-only load test

With the API running, the built-in load test sends randomized read-only
requests and reports aggregate and per-route latency:

```bash
LOAD_TEST_REQUESTS=200 \
LOAD_TEST_CONCURRENCY=20 \
npm run load-test
```

Optional variables are `LOAD_TEST_BASE_URL` (defaults to
`http://127.0.0.1:3000/api`) and `LOAD_TEST_TOKEN` for testing authenticated
read routes. The script never creates, updates, deletes, or draws data.

### Email verification

Public registrations require clicking a one-time verification link before
sign-in is allowed. Configure SMTP delivery and the browser-visible frontend
origin on the API host:

```text
SMTP_HOST
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER
SMTP_PASSWORD
SMTP_FROM
PUBLIC_APP_URL=https://your-frontend.example.com
```

Set `SMTP_SECURE=true` for implicit TLS (commonly port 465); port 587 uses
STARTTLS. SMTP authentication is optional for relays that do not require it.
`PUBLIC_APP_URL` is the frontend origin used to construct verification links.
Verification links expire after 24 hours and keep their token in the URL
fragment until the user explicitly confirms it. Unverified users can request
another email from the registration or sign-in page; resends are limited to
one per minute. Existing accounts are marked verified when the schema adds the
new column, so deployment does not lock out current users.

### Google OAuth (Better Auth)

Google sign-in is an additional login path; existing email/password
registration, verification, and JWT-protected API requests remain unchanged.
Better Auth persists provider accounts and short-lived OAuth sessions in
PostgreSQL; stored provider tokens are encrypted with `BETTER_AUTH_SECRET`.
After Google confirms a verified email, the callback links the
Google identity to an existing Tournly account with the same email or creates
a normal `user` account. Existing roles are preserved, and OAuth-only users
cannot sign in with a password until a password is set through a separate
password-management flow.

Create a **Web application** OAuth client in Google Cloud Console. Add this
authorized redirect URI exactly:

```text
https://YOUR_API_HOST/api/better-auth/callback/google
```

For local development, use
`http://localhost:3000/api/better-auth/callback/google`. Configure these
variables only on the API host (never in frontend config):

```text
BETTER_AUTH_SECRET=<at least 32 random characters>
BETTER_AUTH_URL=https://YOUR_API_HOST
GOOGLE_CLIENT_ID=<Google OAuth client ID>
GOOGLE_CLIENT_SECRET=<Google OAuth client secret>
FRONTEND_ORIGIN=https://YOUR_FRONTEND_ORIGIN
CORS_ORIGINS=https://YOUR_FRONTEND_ORIGIN
```

`BETTER_AUTH_URL` is the API origin without `/api`; Better Auth adds its
`/api/better-auth` base path. In production it must use HTTPS, and
`CORS_ORIGINS` must include the frontend origin for the one-time code exchange.
The callback session remains on the API origin; the frontend does not need to
send Better Auth cookies cross-site. Local development defaults to
`http://localhost:5173` and `http://127.0.0.1:5173`. The application creates
Better Auth's dedicated PostgreSQL tables on startup and maps Better Auth
identities to application user IDs in `oauth_user_links`. OAuth exchange codes
are hashed at rest, expire in two minutes, and can be redeemed only once.

### Docker deployment

Build and run the production container:

```bash
docker build -t tournament-manager .
docker run --rm -p 3000:3000 --env-file .env tournament-manager
```

### Fly.io API deployment

The repository includes `fly.toml` for the persistent API deployment. It
keeps one machine running because referee Server-Sent Events require a
long-lived process. Change the `app` value in `fly.toml` to a globally unique
Fly app name, then run these commands from the repository root:

```bash
fly auth login
fly launch --no-deploy
fly secrets set \
  DATABASE_URL='your-supabase-session-pooler-url' \
  JWT_SECRET='your-long-random-secret' \
  SMTP_HOST='your-smtp-host' \
  SMTP_USER='your-smtp-user' \
  SMTP_PASSWORD='your-smtp-password' \
  SMTP_FROM='Tournly <noreply@example.com>' \
  PUBLIC_APP_URL='https://your-frontend.vercel.app' \
  FRONTEND_ORIGIN='https://your-frontend.vercel.app' \
  BETTER_AUTH_URL='https://YOUR_APP_NAME.fly.dev' \
  BETTER_AUTH_SECRET='your-long-random-better-auth-secret' \
  GOOGLE_CLIENT_ID='your-google-client-id' \
  GOOGLE_CLIENT_SECRET='your-google-client-secret' \
  CORS_ORIGINS='https://your-frontend.vercel.app'
fly deploy
```

Do not commit `.env` or database credentials. `fly secrets list` shows names
and metadata, not secret values. Check startup and deployment status with:

```bash
fly status
fly logs
curl -i https://YOUR_APP_NAME.fly.dev/api/health
```

The API URL for the static Vercel frontend is:

```text
https://YOUR_APP_NAME.fly.dev/api
```

Set that value as the Vercel frontend's `API_BASE_URL`. Keep the Fly machine
running for SSE; do not enable scale-to-zero for this API.

The container serves the static frontend and `/api` from port `3000`. Use a
hosted PostgreSQL `DATABASE_URL`; the container does not include a database.

### Production deployment with SSE

The referee live timeline uses Server-Sent Events and requires a long-lived
Node process. Do not deploy the API as a Vercel serverless function if SSE is
required. Deploy the repository on a persistent Node host, VPS, or container
host instead.

Configure the service with:

```text
Start command: npm start
Root directory: repository root
Health check: /api/health
```

For a container host, use the included Dockerfile:

```bash
docker build -t tournament-manager .
docker run --rm -p 3000:3000 --env-file .env tournament-manager
```

Add these variables to the persistent API host:

```text
DATABASE_URL
DATABASE_SSL=true
DATABASE_SSL_REJECT_UNAUTHORIZED=true
DATABASE_POOL_MAX=5
JWT_SECRET
```

Use the Supabase Session Pooler connection string for `DATABASE_URL` when the
host does not have reliable IPv6 connectivity. Never add `DATABASE_URL` or
`JWT_SECRET` to frontend environment variables.

Test the API host before deploying the frontend:

```bash
curl -i https://API_HOST.example.com/api/health
curl -i https://API_HOST.example.com/api/tournaments
```

If Vercel is used only for static frontend files, set the API URL in
`frontend/public/js/config.js` before deployment:

```js
window.__APP_CONFIG__ = Object.freeze({
  API_BASE_URL: 'https://API_HOST.example.com/api',
});
```

Then deploy the `frontend` directory as a separate Vercel project. The
frontend's API origin must be allowed by the API's CORS policy. The current
API allows cross-origin requests, but restrict that policy to the Vercel
domain before production.

Vercel can still be used for a frontend-only project, but its serverless API
function is not suitable for the required SSE connection. If the frontend and
API use the same persistent host, keep `API_BASE_URL` as `/api` and do not use
the Vercel API function.


### Seed accounts

| Role    | Email                      | Password    |
|---------|----------------------------|-------------|
| admin   | admin@tournament.local     | admin123    |
| referee | referee@tournament.local   | referee123  |
| user    | user@tournament.local      | user123     |

Send the JWT returned by login in the Authorization header.

## Roles

- **admin** — create/maintain tournaments, stages, groups, tournament teams/players, participant entries, draw, follow approvals.
- **referee** — start a match, update score, finish a match (league table is updated on finish).
- **user** — register, follow tournaments, inspect as read-only. Private tournaments behave like Instagram private accounts: follow request must be accepted before details are visible.

## Domain

- **Tournament** — name, slug, status, `public`/`private`, format (`stages`, `groups`, `division`, `league`, `knockout`, `custom`), number of teams, place.
- **Tournament settings** — Stored in `tournaments.settings` JSON. Includes `maxPlayersPerTeam` (default 11, configurable 1–99, enforced for team leaders) and the suspension system.
- **Stage** — `league` or `knockout`, `sequenceOrder` (World Cup: groups = 1, knockout = 2), JSON `settings` (`headToHeadMatches`, `extraTime`, `penalties`, points, teams advancing).
- **Group** — instance of a stage (`Group A`, `Playoffs`, `Round of 16`).
- **Team** — one tournament-scoped row containing profile fields, `creator_id`, seed/group/status, cards, and tournament statistics. A team cannot be reused across tournaments.
- **ParticipantPlayer** — the tournament-team-scoped player identity, roster entry, profile, and statistics.

## Main endpoints

### Auth
- `POST /api/auth/register` `{ email, password, name, role? }` role: `user` or `referee`
- `POST /api/auth/login`
- `GET /api/auth/me`

### Tournaments
- `POST /api/tournaments` (admin) — create with nested stages and groups
- `GET /api/tournaments`
- `GET /api/tournaments/:id`
- `PATCH /api/tournaments/:id`
- `DELETE /api/tournaments/:id`
- `POST /api/tournaments/:id/stages`
- `PATCH /api/stages/:id`
- `DELETE /api/stages/:id`
- `POST /api/stages/:id/groups`
- `PATCH /api/groups/:id`
- `DELETE /api/groups/:id`

### Catalog
- `GET /api/tournaments/:id/teams`
- `POST|PATCH|DELETE /api/tournaments/:id/teams` — tournament-scoped team management
- Player identity and roster data are created directly through each tournament team's player endpoint.

### Participants
- `POST /api/tournaments/:id/participant-teams` `{ name, slug, seed, nickname, ...profileFields }`
- `GET /api/tournaments/:id/participant-teams`
- `PATCH|DELETE /api/participant-teams/:id`
- `POST /api/tournaments/:id/participant-teams/:teamId/players` `{ name, position, shirtNumber, role, ...profileFields }`
- `GET /api/tournaments/:id/participant-teams/:teamId/players`
- `POST /api/tournaments/:id/participant-teams/:teamId/player-invite-codes` — moderator issues a one-time player invite code
- `POST /api/player-invite-codes/validate` and `/api/player-invite-codes/redeem` — signed-in players validate and redeem codes
- `PATCH|DELETE /api/participant-players/:id`

Tournament creators choose `playerRegistrationMode` when setting up a
tournament: `direct` (the backward-compatible default), `invite_code`, or
`both`. Invite codes are 16-character hex tokens, hashed at rest, single-use,
and expire after seven days. Each active code reserves a roster slot; invalid
player details do not consume the code. Team leaders can manage codes only for
their assigned team, and all redemptions require a signed-in account.
The frontend exposes redemption on `frontend/public/join-team.html` so invitees
can join without first opening a tournament page, including private tournaments.
An account can redeem an invite code to join one team only; that membership is
stored against the account and further code entry is hidden and rejected.

Player rows are tournament-team-scoped in `participant_players`; there is no
reusable global player catalog. Each unified player row records its creator.

### Draw and matches
- `POST /api/draw` `{ tournamentId, stageId? }` (also `POST /api/tournaments/:id/draw`)
- `GET /api/tournaments/:id/matches`
- `POST /api/matches/:id/start` (referee/admin)
- `PATCH /api/matches/:id`
- `POST /api/matches/:id/finish` `{ homeScore, awayScore }`

### Follow 
- `POST /api/tournaments/:id/follow`
- `DELETE /api/tournaments/:id/follow`
- `GET /api/tournaments/:id/followers` (admin)
- `PATCH /api/tournaments/:id/follow-requests/:userId` `{ status: "accepted" | "rejected" }`

### Vote
- `GET /api/tournaments/:tournamentId/votes`
- `GET /api/votes/:id` : list votes
- `POST /api/tournaments/:tournamentId/votes : {name, award}`
- `PATCH /api/votes/:id : {name, award}`
- `DELETE /api/votes/:id`
- `GET /api/votes/:voteId/nominees`
- `POST /api/votes/:voteId/nominees : {nomineeId}`
- `POST /api/votes/:voteId/nominees/:nomineeId : {votes}`
- `POST /api/votes/:voteId/nominees/:nomineeId`

## Example: create a World Cup-style tournament

```json
POST /api/tournaments
{
  "name": "World Cup Demo",
  "visibility": "public",
  "format": "stages",
  "numberOfTeams": 8,
  "place": "Qatar",
  "stages": [
    {
      "type": "league",
      "sequenceOrder": 1,
      "settings": {
        "headToHeadMatches": 1,
        "extraTime": false,
        "penalties": false,
        "teamsAdvancePerGroup": 2
      },
      "groups": [
        { "name": "Group A" },
        { "name": "Group B" }
      ]
    },
    {
      "type": "knockout",
      "sequenceOrder": 2,
      "settings": { "headToHeadMatches": 1, "extraTime": true, "penalties": true },
      "groups": [
        { "name": "Semi-finals" },
        { "name": "Final" }
      ]
    }
  ]
}
```

Then create tournament-scoped teams with `POST /api/tournaments/:id/teams` or
`POST /api/tournaments/:id/participant-teams`, and run `POST /api/draw` with
`{ "tournamentId": "..." }`.

The draw shuffles participant teams into groups (league) or pairs them (knockout) and generates fixtures. Double round-robin uses `settings.headToHeadMatches: 2`.
