# Tournament Manager API

Express REST API for creating and managing sports tournaments. Roles, private/public visibility, multi-stage formats, automatic draws, and a split between catalog entities (`Team`, `Player`) and tournament entries (`ParticipantTeam`, `ParticipantPlayer`).

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

### Docker deployment

Build and run the production container:

```bash
docker build -t tournament-manager .
docker run --rm -p 3000:3000 --env-file .env tournament-manager
```

The container serves the static frontend and `/api` from port `3000`. Use a
hosted PostgreSQL `DATABASE_URL`; the container does not include a database.

### Vercel deployment

Vercel does not run the `Dockerfile` as a long-lived container. The repository
also includes `vercel.json`, which deploys `api/index.js` as a Node function
and serves `frontend/public` as static files.

From the repository root:

```bash
npx vercel
```

Add these variables in the Vercel project settings for Production:

```text
DATABASE_URL
DATABASE_SSL=true
DATABASE_SSL_REJECT_UNAUTHORIZED=true
DATABASE_POOL_MAX=5
JWT_SECRET
```

The frontend uses the same-origin `/api` path on Vercel. Never add
`DATABASE_URL` or `JWT_SECRET` to frontend environment variables.

The current SSE stream is designed for a long-lived Express process and may
not be reliable through serverless function time limits. Use the Docker
deployment or another long-lived Node host for referee live timelines unless
the realtime path is migrated to a serverless-compatible service.

### Seed accounts

| Role    | Email                      | Password    |
|---------|----------------------------|-------------|
| admin   | admin@tournament.local     | admin123    |
| referee | referee@tournament.local   | referee123  |
| user    | user@tournament.local      | user123     |

Send the JWT returned by login in the Authorization header.

## Roles

- **admin** — create/maintain tournaments, stages, groups, catalog teams/players, participant entries, draw, follow approvals.
- **referee** — start a match, update score, finish a match (league table is updated on finish).
- **user** — register, follow tournaments, inspect as read-only. Private tournaments behave like Instagram private accounts: follow request must be accepted before details are visible.

## Domain

- **Tournament** — name, slug, status, `public`/`private`, format (`stages`, `groups`, `division`, `league`, `knockout`, `custom`), number of teams, place.
- **Stage** — `league` or `knockout`, `sequenceOrder` (World Cup: groups = 1, knockout = 2), JSON `settings` (`headToHeadMatches`, `extraTime`, `penalties`, `suspensionSystem`, points, teams advancing).
- **Group** — instance of a stage (`Group A`, `Playoffs`, `Round of 16`).
- **Team / Player** — global catalog (slug, name, colors, etc.).
- **ParticipantTeam / ParticipantPlayer** — that catalog entity inside a tournament (seed, group, cards, shirt number, tournament stats).

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
- `GET|POST /api/teams`, `GET|PATCH|DELETE /api/teams/:id`
- `GET|POST /api/players`, `GET|PATCH|DELETE /api/players/:id`

### Participants
- `POST /api/tournaments/:id/participant-teams` `{ teamId, seed, nickname }`
- `GET /api/tournaments/:id/participant-teams`
- `PATCH|DELETE /api/participant-teams/:id`
- `POST /api/participant-teams/:id/players` `{ playerId, shirtNumber, role }`
- `GET /api/participant-teams/:id/players`
- `PATCH|DELETE /api/participant-players/:id`

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

Then add catalog teams, attach them with `POST /api/tournaments/:id/participant-teams`, and run `POST /api/draw` with `{ "tournamentId": "..." }`.

The draw shuffles participant teams into groups (league) or pairs them (knockout) and generates fixtures. Double round-robin uses `settings.headToHeadMatches: 2`.
