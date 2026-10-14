# Tournament API Reference

Base router mounts all routes below. Auth middleware legend:

| Symbol | Meaning |
|---|---|
| **Public** | No auth required |
| **Optional** | `authOptional` — works with or without a token; some handlers change behavior if `req.user` is present |
| **Auth** | `requireAuth` — valid JWT required |
| **Auth + admin** | `requireAuth` + `requireRole('admin')` |
| **Auth + tournament role** | `requireAuth` + `requireTournamentRole(...)` — user must hold one of the listed roles (`moderator`, `referee`) *for that tournament*, checked via the `tournament_role` table |

Unless noted, all bodies are JSON. Fields marked *(optional)* fall back to the existing DB value on PATCH.

---

## Health

### `GET /health` — Public
**Response `200`**
```json
{ "ok": true }
```

---

## Auth

### `POST /auth/register` — Public
**Body**: `{ "email": "valid email", "password": "at least 8 characters", "name": "1-120 characters" }`
**Response `201`**: `{ "message": "Account created. Check your email for a verification link." }`
No session is created until verification.
**Errors**: `400` invalid or missing fields, `409` email already registered, `503` verification email delivery failed.

### `POST /auth/verify-email` — Public
**Body**: `{ "token": "one-time token from verification email" }`
**Response `200`**: `{ "message": "Email verified. You can now sign in.", "email": "verified address" }`
**Errors**: `400` invalid, expired, or already-used token; response advises requesting a new verification email.

### `POST /auth/resend-verification` — Public
**Body**: `{ "email": "string" }`
**Response `202`**: generic troubleshooting guidance whether or not an unverified account exists, to avoid disclosing account state. Resends are limited to one per email address per minute.
**Errors**: `400` invalid email, `503` delivery/configuration guidance when email sending fails.

### `POST /auth/login` — Public
**Body**
```json
{ "email": "string (required)", "password": "string (required)" }
```
**Response `200`**: `{ "user": { "id", "email", "name", "role", "emailVerified", "createdAt" }, "token": "JWT (7d expiry)" }`
**Errors**: `400` missing fields, `401` invalid credentials, `403` email not verified.

### Google OAuth — Better Auth
The login and registration pages submit a top-level form to
`POST /oauth/google/start` with a same-origin `next` path. After Google
verification, `/oauth-callback.html` exchanges a short-lived one-time code at
`POST /oauth/google/exchange` and starts the existing application JWT session.
The exchange is bound to the configured frontend Origin, and the code is
consumed once. The API's Google callback URI is
`https://API_HOST/api/better-auth/callback/google`.

### `GET /auth/me` — Auth
**Response `200`**
```json
{ "user": { "id", "email", "name", "role", "emailVerified", "createdAt" } }
```

### `GET /users` — Auth + admin
**Response `200`**
```json
{ "users": [ { "id", "email", "name", "role", "emailVerified", "createdAt" } ] }
```

### `PATCH /users/:id/role` — Auth + admin
**Body**
```json
{ "role": "'admin' | 'referee' | 'user'" }
```
**Response `200`**: `{ "user": {...} }`
**Errors**: `400` invalid role, `404` user not found.

> ⚠️ `schema.sql` only allows `role IN ('admin', 'user')` on the `users` table, but the app code (`authController`, this route, `tournament_role`) treats `'referee'` as a valid user role too — the CHECK constraint looks out of sync with the code.

---

## Tournaments

### `GET /tournaments` — Optional
Lists all tournaments. Private tournaments are returned in a reduced/redacted shape (`restricted: true`) unless the requester can inspect them (admin, creator, or accepted follower).
**Response `200`**
```json
{ "tournaments": [ { "id", "name", "slug", "status", "visibility", "numberOfTeams", "place", "createdBy", "createdAt", "updatedAt" } ] }
```

### `GET /tournaments/:tournamentId` — Optional
**Response `200`**
```json
{ "tournament": {...}, "stages": [ { "id", "tournamentId", "type", "sequenceOrder", "settings", "groups"?, "rounds"? } ] }
```
**Errors**: `404` not found, `403` private and not inspectable.

### `POST /tournaments` — Auth
**Body**
```json
{
  "name": "string (required)",
  "visibility": "'public' | 'private' (default 'public')",
  "status": "string (default 'draft')",
  "numberOfTeams": "number",
  "place": "string",
  "slug": "string (optional, auto-slugified from name)",
  "settings": {
    "maxPlayersPerTeam": "integer from 1 to 99 (default 11; applies to team leaders)",
    "playerRegistrationMode": "'direct'|'invite_code'|'both' (default 'direct'; applies to moderators and team leaders)",
    "suspensionSystem": { "enabled": "boolean", "yellowCardsForSuspension": "integer" }
  },
  "stages": [ { "type": "'league'|'knockout'", "sequenceOrder": "number", "settings": {}, "groups": [ { "name", "sequenceOrder", "number_teams" } ] } ]
}
```
**Response `201`**
```json
{ "tournament": {...}, "stages": [...] }
```
**Errors**: `400` missing name, player cap outside 1–99, invalid player-registration mode, or invalid stage type.

Tournament responses include `maxPlayersPerTeam` (default `11` for older
tournaments) and `playerRegistrationMode`. `direct` allows moderators and team
leaders to add players using the player form; `invite_code` requires a
single-use code; `both` enables either method. Existing tournaments default to
`direct`. Administrator auto-fill remains admin-only, and active invite codes
reserve roster slots. Global administrators retain their existing direct
management access in addition to auto-fill.

### `PATCH /tournaments/:tournamentId` — Auth + tournament role `moderator`
**Body** *(all optional)*
```json
{ "name", "status", "visibility", "numberOfTeams", "place", "settings": { "maxPlayersPerTeam": "integer from 1 to 99", "playerRegistrationMode": "'direct'|'invite_code'|'both'" } }
```
**Response `200`**: `{ "tournament": {...} }`

### `DELETE /tournaments/:tournamentId` — Auth + tournament role `moderator`
**Response `204`**

---

## Stages

### `GET /tournaments/:tournamentId/stages/:id` — Optional
**Response `200`**: the stage object directly (not wrapped)
```json
{ "id", "tournamentId", "type", "sequenceOrder", "settings" }
```
> Note: unlike most GET-by-id routes, this doesn't 404 — a missing stage returns `map.stage(undefined)` → `null`.

### `POST /tournaments/:tournamentId/stages/:id/stages` *(actual path: `/tournaments/:tournamentId/stages`)* — Auth + tournament role `moderator`
**Body**
```json
{ "type": "'league' | 'knockout' (required)", "sequenceOrder": "number", "settings": {}, "groups": [ { "name", "sequenceOrder", "number_teams" (for league) } ] }
```
For `knockout` stages, entries in `groups` are inserted as **rounds** (using `name`/`sequenceOrder`) instead of groups.
**Response `201`**
```json
{ "stages": [...] }
```
**Errors**: `400` invalid stage type.

### `GET /tournaments/:tournamentId/stages/:id/standing` — Optional
Added after the initial reference. Returns each group's final ranking — as an ordered list of `participantTeamId`s only — computed server-side by the standings service against the stage's own configured tiebreakers (`stage.settings.tiebreakers`). The frontend resolves those IDs against the `participant-teams` data it already has (team name, nickname, running stats) and renders them in the order given; it does not recompute or re-sort anything itself, and the service never has to re-fetch or re-serialize team rows the client already holds.

**Response `200`**
```json
{
  "stageId": "string",
  "groups": [
    { "groupId": "string", "order": ["participantTeamId1", "participantTeamId2", "..."] }
  ]
}
```
`order` is expected to already be in final ranked order (index 0 = 1st place).

> Deliberately **does not** accept a `tiebreakers` parameter from the client. The stage already persists its own tiebreak order; letting a request override it would mean two viewers of the same public standings could see different orderings, or a client could omit/substitute its own. If an admin-facing "preview a different tiebreak order" tool is ever needed, it should be a distinct, authenticated action rather than a parameter on this read.

### `PATCH /tournaments/:tournamentId/stages/:id` — Auth + tournament role `moderator`
**Body** *(all optional)*
```json
{ "type", "sequenceOrder", "settings" }
```
Settings are merged: `defaultStageSettings(type) + existing settings + body.settings`.
**Response `200`**: `{ "stage": {...} }`
**Errors**: `404` stage not found.

### `DELETE /tournaments/:tournamentId/stages/:id` — Auth + tournament role `moderator`
**Response `204`**
**Errors**: `404` stage not found.

---

## Groups (league stages)

### `POST /tournaments/:tournamentId/stages/:id/groups` — Auth + tournament role `moderator`
**Body**
```json
{ "name": "string (required)", "sequenceOrder": "number", "number_teams": "number (required)", "promotion_rules": "JSON string (optional)" }
```
**Response `201`**: `{ "group": { "id", "stageId", "name", "sequenceOrder", "numberOfTeams", "promotionRules" } }`
**Errors**: `400` missing name/number_teams, `404` stage not found.

> ⚠️ `mappers.group()` reads `row.promtion_rules` (typo) instead of `row.promotion_rules`, so `promotionRules` will always serialize as `undefined`.

### `PATCH /tournaments/:tournamentId/groups/:id` — Auth + tournament role `moderator`
**Body** *(all optional)*
```json
{ "name", "sequence_order", "number_teams", "promotion_rules" }
```
**Response `200`**: `{ "group": {...} }`
**Errors**: `404` group not found.

### `DELETE /tournaments/:tournamentId/groups/:id` — Auth + tournament role `moderator`
Also nulls `group_id` on any matches referencing this group.
**Response `204`**
**Errors**: `404` group not found.

---

## Rounds (knockout stages)

### `POST /tournaments/:tournamentId/stages/:id/rounds` — Auth + tournament role `moderator`
**Body**
```json
{ "name": "string (required)", "sequenceOrder": "number" }
```
**Response `201`**: `{ "round": { "id", "stageId", "name", "sequenceOrder" } }`
**Errors**: `400` missing name, `404` stage not found.

### `PATCH /tournaments/:tournamentId/rounds/:id` — Auth + tournament role `moderator`
**Body** *(all optional)*
```json
{ "name", "sequenceOrder" }
```
**Response `200`**: `{ "round": {...} }`
**Errors**: `404` round not found.

### `DELETE /tournaments/:tournamentId/rounds/:id` — Auth + tournament role `moderator`
Also nulls `group_id` on any matches referencing this round.
**Response `204`**
**Errors**: `404` round not found.

---

## Teams

### `GET /tournaments/:tournamentId/teams` — Optional
Returns teams belonging to the requested tournament only. Teams are not
global catalog records and cannot be reused across tournaments.
**Response `200`**: `{ "teams": [ { "id", "tournamentId", "creatorId", "name", "slug", "shortName", "colors": {"primary","secondary"}, "city", "country", "foundedYear", "status", "stats" } ] }`

### `GET /tournaments/:tournamentId/teams/:id` — Optional
**Response `200`**: `{ "team": {...} }`
**Errors**: `404`

### `POST /tournaments/:tournamentId/teams` — Auth + tournament moderator/admin
**Body**
```json
{ "name": "string (required)", "slug": "string (optional)", "shortName", "primaryColor" | "colors.primary", "secondaryColor" | "colors.secondary", "city", "country", "foundedYear" }
```
**Response `201`**: `{ "team": {...} }`
`creatorId` is set from the authenticated user.
**Errors**: `400` missing name, `403` insufficient tournament access.

### `PATCH /tournaments/:tournamentId/teams/:id` — Auth + tournament moderator/admin
**Body** *(all optional, same fields as create)*
**Response `200`**: `{ "team": {...} }`
**Errors**: `404`

### `DELETE /tournaments/:tournamentId/teams/:id` — Auth + tournament moderator/admin
**Response `204`**
**Errors**: `404`

---

## Tournament players

Players are team-scoped rows in `participant_players`; there is no global
player catalog or player-reuse endpoint. Each row contains identity/profile,
roster, and statistic fields. Its `id` is the identity referenced by match
events, suspensions, and voting. `creatorId` is the user who created the row.

---

## Participant Teams (a team's entry into a specific tournament)

### `GET /tournaments/:tournamentId/participant-teams` — Optional
Requires tournament to be inspectable (private tournaments enforce `requireTournamentInspect`).
**Response `200`**: `{ "participantTeams": [ { "id", "tournamentId", "teamId", "groupId", "seed", "nickname", "status", "stats": {"played","won","drawn","lost","goalsFor","goalsAgainst","goalDifference","points"}, "team": {"id","name","slug","colors"} } ] }`
**Errors**: `403` private tournament, `404` tournament not found.

### `POST /tournaments/:tournamentId/participant-teams` — Auth + tournament role `moderator`
**Body**
```json
{ "teamId": "string (required)", "seed": "number", "nickname": "string" }
```
**Response `201`**: `{ "participantTeam": {...} }`
**Errors**: `400` missing teamId, `404` tournament/team not found.

### `PATCH /tournaments/:tournamentId/participant-teams/:id` — Auth + tournament role `moderator`
**Body** *(all optional)*
```json
{ "seed", "nickname", "status", "groupId" }
```
**Response `200`**: `{ "participantTeam": {...} }`
**Errors**: `404`

### `DELETE /tournaments/:tournamentId/participant-teams/:id` — Auth + tournament role `moderator`
**Response `204`**
**Errors**: `404`

---

## Participant Players (a tournament-scoped player on a team)

### `GET /tournaments/:tournamentId/participant-teams/:id/players` — Optional
**Response `200`**: `{ "participantPlayers": [ { "id", "participantTeamId", "creatorId", "name", "slug", "nickname", "dateOfBirth", "nationality", "position", "preferredFoot", "heightCm", "shirtNumber", "role", "status", "yellowCards", "redCards", "goals", "assists", "player": {"id","name","slug","position"} } ], "reservedInviteCodes": 0 }`
**Errors**: `403` private tournament, `404` participant team not found.

### `POST /tournaments/:tournamentId/participant-teams/:id/players` — Auth + tournament moderator/admin
**Body**
```json
{ "name": "string (required)", "slug": "string (optional)", "nickname": "string", "dateOfBirth": "date", "nationality": "string", "position": "string", "preferredFoot": "string", "heightCm": "number", "shirtNumber": "number", "role": "'player'|'captain'|'goalkeeper' (default 'player')", "status": "'active'|'injured'|'suspended'|'ineligible' (default 'active')" }
```
Creates a new player row for this team. The server sets `creatorId` from the
authenticated user; slugs must be unique within this team. The tournament
roster cap is checked under a team-row lock before insertion.
**Errors**: `400` missing name, `404` participant team not found, `409` duplicate team-local slug or configured roster limit reached.
**Errors** also include `403` when direct player entry is disabled by tournament settings.

### Player invite codes — Auth + tournament moderator/admin or owning team leader

The moderator routes manage any team in the tournament. Team leaders use the
equivalent `/team-leader/teams/:id/player-invite-codes` paths and can only
manage their own team. These operations are available only when
`playerRegistrationMode` is `invite_code` or `both`.

- `GET /tournaments/:tournamentId/participant-teams/:id/player-invite-codes`
  returns active code metadata, never the code itself.
- `POST /tournaments/:tournamentId/participant-teams/:id/player-invite-codes`
  creates one code. The response contains a 16-character hexadecimal code
  exactly once. Codes are hashed at rest, expire after seven days, and reserve
  one roster slot.
- `DELETE /tournaments/:tournamentId/participant-teams/:id/player-invite-codes/:codeId`
  revokes an unused code and releases its slot.
- Team leaders use `GET|POST /tournaments/:tournamentId/team-leader/teams/:id/player-invite-codes`
  and `DELETE /tournaments/:tournamentId/team-leader/teams/:id/player-invite-codes/:codeId`.

Issuance is limited to 100 attempts per hour per account; validation and
redemption are limited to 10 attempts per 15 minutes per account.
**Errors**: `403` mode/ownership restriction, `404` team/code not found,
`409` no unreserved roster capacity, `429` rate limit exceeded.

### `GET /player-invite-codes/membership` — Authenticated user

Returns the account's invite-code registration or `{ "membership": null }`.
Each account can use invite codes to join one team only; the rule is enforced
by a database uniqueness constraint as well as during validation.

### `POST /player-invite-codes/validate` — Authenticated user

**Body**: `{ "code": "16 hex characters" }`

Checks an unexpired unused code without consuming it, and returns the
participant team ID, team name, and tournament name before the player form is
shown. Returns `409` if the account has already joined a team. Redemption
validates both the code and the account's membership again.

### `POST /player-invite-codes/redeem` — Authenticated user

**Body**: `{ "code": "16 hex characters", "player": { "name": "required", "...": "player fields" } }`

Creates the player and deletes the code in one transaction. Invalid player
details do not consume the code; concurrent redemption can succeed only once.
The account is linked to the created team and is no longer offered another
invite-code form.
**Response `201`**: `{ "participantPlayer": {...} }`
**Errors**: `400` invalid/expired/used code or invalid player fields, `409`
already joined a team, duplicate team-local slug, or full roster, `429` rate
limit exceeded.

### `POST /tournaments/:tournamentId/participant-teams/:id/players/auto` — Auth + admin
**Body**: `{ "count": "number (required)" }`

Creates enough team-scoped player rows to reach the requested roster size.
New rows record the administrator as `creatorId`. The requested total cannot
exceed `maxPlayersPerTeam` after accounting for active invite-code reservations.
The cap is verified atomically before insertion.
**Errors**: `400` invalid count, `404` participant team not found, `409` configured roster limit exceeded.

### Team leader workflow

Tournament owners can assign the `team_leader` role. A team leader uses the
same Teams & players form as an administrator and can create one
tournament-scoped team:

```http
POST /tournaments/:tournamentId/team-leader/team
Authorization: Bearer <token>
Content-Type: application/json

{ "name": "North Stars", "shortName": "NS" }
```

The same role can retrieve its owned team and roster with
`GET /tournaments/:tournamentId/team-leader/team`, then add a player directly
to that team's unified roster:

```http
POST /tournaments/:tournamentId/team-leader/teams/:participantTeamId/players
Authorization: Bearer <token>
Content-Type: application/json

{ "name": "Alex Morgan", "position": "Forward" }
```

The backend permits only the owning team leader to use these endpoints and
enforces one team per tournament plus the tournament's `maxPlayersPerTeam`
limit (default 11, configurable from 1 to 99). Players cannot be selected from
another team or reused from another tournament.
**Response `201`**: `{ "participantPlayer": {...} }`
**Errors**: `400` missing name, `403` not the owning team leader, `404` team not found, `409` duplicate team-local slug or configured roster limit reached.

### `PATCH /tournaments/:tournamentId/participant-players/:id` — Auth + tournament role `moderator`
**Body** *(all optional)*
```json
{ "name", "slug", "nickname", "dateOfBirth", "nationality", "position", "preferredFoot", "heightCm", "shirtNumber", "role", "status", "yellowCards", "redCards", "goals", "assists" }
```
**Response `200`**: `{ "participantPlayer": {...} }`
The existing roster count is checked against the tournament cap before update.
**Errors**: `404` participant player not found, `409` configured roster limit exceeded.

### `DELETE /tournaments/:tournamentId/participant-players/:id` — Auth + tournament role `moderator`
**Response `204`**
**Errors**: `404`

---

## Draw

### `POST /tournaments/:tournamentId/draw` — Auth + tournament role `moderator`
**Body**
```json
{
  "stageId": "string (optional — draws the tournament's current stage if omitted)",
  "potDraw": {
    "potCount": 4,
    "mode": "manual",
    "assignments": [
      { "participantTeamId": "team-1", "potNumber": 1 },
      { "participantTeamId": "team-2", "potNumber": 2 },
      { "participantTeamId": "team-3", "potNumber": 3 },
      { "participantTeamId": "team-4", "potNumber": 4 },
      { "participantTeamId": "team-5", "potNumber": 1 },
      { "participantTeamId": "team-6", "potNumber": 2 },
      { "participantTeamId": "team-7", "potNumber": 3 },
      { "participantTeamId": "team-8", "potNumber": 4 }
    ]
  }
}
```
`potDraw` is optional and applies only to league stages. `{ "potCount": 4,
"mode": "random" }` asks the server to fill balanced pots randomly. Manual
assignments must include every drawn team exactly once and each pot must have
the same number of teams. The selected pot count must be a power of two that
divides the common configured group size; every destination group receives
exactly `groupSize / potCount` teams from each pot. Send `"potDraw": null` to
redraw without pots and clear saved assignments. If omitted, valid saved pot
assignments are reused.
**Response `201`**: `{ "draw": { ... } }`
**Errors**: `400` invalid group/pot configuration, `404` tournament or stage
not found, `409` wrong number of teams or started stage.

### `GET /tournaments/:tournamentId/stages/:id/draw-pots` — Auth + tournament role `moderator`

Returns the selected stage's configured group capacities, draw teams, eligible
pot counts (only when all group sizes are equal and team capacity is met), and
saved assignments for the moderator draw dialog.
**Response `200`**
```json
{
  "stageType": "league",
  "eligible": true,
  "groupSize": 4,
  "expectedTeamCount": 8,
  "potCounts": [2, 4],
  "groups": [
    { "id": "group-1", "name": "Group 1", "numberOfTeams": 4 },
    { "id": "group-2", "name": "Group 2", "numberOfTeams": 4 }
  ],
  "teams": [{ "id": "team-id", "name": "Team name" }],
  "savedPotDraw": null
}
```
**Errors**: `400` registered team count does not match tournament setup,
`404` tournament or stage not found, `409` draw participants are not available
yet.

---

## Matches

### `GET /tournaments/:tournamentId/matches` — Optional
Requires tournament to be inspectable.
**Response `200`**: `{ "matches": [ Match ] }` — see `Match` shape below.
**Errors**: `403`, `404`

### `GET /tournaments/:tournamentId/matches/:id` — Optional
**Response `200`**: `{ "match": Match }`
**Errors**: `403`, `404`

**`Match` shape**
```json
{
  "id", "tournamentId", "stageId", "groupId", "matchday",
  "homeParticipantTeamId", "awayParticipantTeamId",
  "venue", "scheduledAt", "status",
  "score": { "home", "away", "extraTimeHome", "extraTimeAway", "penaltiesHome", "penaltiesAway" },
  "refereeId", "startedAt", "finishedAt", "createdAt"
}
```

### `POST /tournaments/:tournamentId/matches/:id/start` — Auth + tournament role `moderator, referee`
**Body**
```json
{ "venue": "string (optional)" }
```
Sets the match to `live`, assigns `referee_id` to the caller, and flips the parent tournament's status to `in_progress`.
**Response `200`**: `{ "match": Match }`
**Errors**: `404` match not found, `400` match already finished.

### `PATCH /tournaments/:tournamentId/matches/:id` — Auth + tournament role `moderator, referee`
**Body** *(all optional — free-form score/schedule edit, does not affect standings or knockout progression)*
```json
{ "homeScore", "awayScore", "extraTimeHome", "extraTimeAway", "penaltiesHome", "penaltiesAway", "venue", "scheduledAt" }
```
**Response `200`**: `{ "match": Match }`
**Errors**: `404` match not found.

### `POST /tournaments/:tournamentId/matches/:id/finish` — Auth + tournament role `moderator, referee`
**Body**
```json
{ "homeScore": "number (required unless already set)", "awayScore": "number (required unless already set)", "extraTimeHome", "extraTimeAway", "penaltiesHome", "penaltiesAway" }
```
Marks the match `finished`, updates the league table (league stages) or advances the bracket (knockout stages).
**Response `200`**
```json
{ "match": Match, "advance": "/* knockout advance result, or null for league stages */" }
```
**Errors**: `404` match not found, `400` already finished / missing scores.

---

## Simulation

### `POST /matches/:id/simulate` — Auth + admin
Randomly generates a scoreline for one match and finishes it (cascading through extra time / penalties for knockout ties per stage settings).
**Response `200`**
```json
{ "match": Match, "advance": "...", "skipped": "true if match was already finished" }
```
**Errors**: `404` match not found.

### `POST /stages/:id/simulate` — Auth + admin
Draws the stage if undrawn, then simulates every remaining match round by round until complete.
**Response `200`**
```json
{ "stageId", "stageType", "sequenceOrder", "drew": "boolean", "matchesSimulated": "number", "advance": "..." }
```
**Errors**: `404` stage not found.

### `POST /tournaments/:tournamentId/simulate` — Auth + admin
Simulates every stage of the tournament in sequence order (draw + play each stage).
**Response `200`**
```json
{ "tournamentId", "status", "stages": [ /* one simulateStage() result per stage */ ] }
```
**Errors**: `404` tournament not found, `400` no stages to simulate.

---

## Follows

### `GET /tournaments/followed` — Auth
Returns the tournaments the **current user** follows (i.e. their own `tournament_follows` rows), regardless of status. Added after the initial reference — not covered by the original route walkthrough below.
**Response `200`**
```json
[ { "id", "name", "slug", "status", "visibility", "numberOfTeams", "place", "createdBy", "createdAt", "updatedAt" } ]
```
> ⚠️ **Route ordering matters here.** Express matches routes top-to-bottom, and `index.js` already declares `router.get('/tournaments/:tournamentId', ...)` earlier in the file. If `GET /tournaments/followed` is registered *after* that line, Express will treat `followed` as a `:tournamentId` value and this route will never be reached — it must be declared **before** the `:tournamentId` route (same rule that already applies to `/tournaments/followed` vs. `/tournaments/:tournamentId`, and mirrors how `/auth/me` is declared ahead of any `/auth/:id`-shaped route).

### `POST /tournaments/:tournamentId/follow` — Auth
Creates (or returns existing) follow record. Status is auto-`accepted` for public tournaments, `pending` for private ones.
**Response `201`** (or `200` if already following): `{ "follow": { "id", "tournamentId", "userId", "status", "createdAt" } }`
**Errors**: `404` tournament not found.

### `DELETE /tournaments/:tournamentId/follow` — Auth
**Response `204`**

### `GET /tournaments/:tournamentId/followers` — Auth + tournament role `moderator`
**Response `200`**
```json
{ "followers": [ { "id", "tournamentId", "userId", "status", "createdAt", "user": { "id", "email", "name", "role" } } ] }
```
**Errors**: `404` tournament not found.

### `PATCH /tournaments/:tournamentId/follow-requests/:userId` — Auth + tournament role `moderator`
**Body**
```json
{ "status": "'accepted' | 'rejected'" }
```
**Response `200`**: `{ "follow": {...} }`
**Errors**: `400` invalid status, `404` follow request not found.

---

## Votes (awards)

### `GET /tournaments/:tournamentId/votes` — Optional
**Response `200`**: array directly (not wrapped)
```json
[ { "id", "tournamentId", "name", "award" } ]
```

### `GET /tournaments/:tournamentId/votes/:id` — Optional
**Response `200`**: `{ "id", "tournamentId", "name", "award" }`
**Errors**: `404`

### `POST /tournaments/:tournamentId/votes` — Auth + tournament role `moderator`
**Body**
```json
{ "name": "string (required)", "award": "string (required)" }
```
**Response `201`**: vote object
**Errors**: `400` missing name/award.

### `PATCH /tournaments/:tournamentId/votes/:id` — Auth + tournament role `moderator`
**Body** *(all optional)*
```json
{ "name", "award" }
```
**Response `200`**: vote object
**Errors**: `404`

> ⚠️ **Bug**: `voteController.js`'s `updateVote` handler has a stray `z` token right after the arrow function opening (`(req, res, next) => {z`), which is a syntax error — this route will fail to load/run as written.

### `DELETE /tournaments/:tournamentId/votes/:id` — Auth + tournament role `moderator`
**Response `204`**
**Errors**: `404`

---

## Vote Nominees

### `GET /tournaments/:tournamentId/votes/:voteId/nominees` — Optional
**Response `200`**: array directly
```json
[ { "voteId", "nomineeId", "userId" } ]
```

### `POST /tournaments/:tournamentId/votes/:voteId/nominees` — Auth + tournament role `moderator`
**Body**
```json
{ "nomineeId": "string (required)" }
```
**Response `201`**: nominee object
**Errors**: `400` missing nomineeId.

### `POST /tournaments/:tournamentId/votes/:voteId/nominees/:nomineeId` — Auth (any authenticated user, no role required)
Casts a vote for a nominee.
**Body**
```json
{ "userId": "string" }
```
**Response `200`**: nominee object
**Errors**: `404` nominee not found, `400` user already voted.

> ⚠️ `voteService.setNomineeVoter` updates `vote_nominees.user_id` directly rather than inserting a new row — since `vote_nominees`' primary key is `(user_id, vote_id)`, this design can only ever record **one voter total per vote-nominee pair**, and switching a vote overwrites who gets credit rather than tallying multiple voters. The `votes` integer column defined in `schema.sql` is never incremented anywhere in the service layer.

### `DELETE /tournaments/:tournamentId/votes/:voteId/nominees/:nomineeId` — Auth + tournament role `moderator`
**Response `204`**
**Errors**: `404`

---

## Endpoints defined in code but **not mounted** in `index.js`

`tournamentController.js` exports full CRUD for tournament-scoped user roles (`getAllTournamentRole`, `getTournamentRole`, `addTournamentRole`, `updateTournamentRole`, `deleteTournamentRole`), backed by `tournamentRolesService.js` and the `tournament_role` table — but no routes in `index.js` wire them up. As written, there is no HTTP-reachable way to grant a user the `moderator`/`referee` role for a tournament, even though nearly every write endpoint above depends on that role existing.

Likely intended routes (inferred from handler signatures, `:userId`/`:tournamentId` params):
```
GET    /tournaments/:tournamentId/roles
GET    /tournaments/:tournamentId/roles/:userId
POST   /tournaments/:tournamentId/roles/:userId      { role: 'referee' | 'moderator' }
PATCH  /tournaments/:tournamentId/roles/:userId      { role: 'referee' | 'moderator' }
DELETE /tournaments/:tournamentId/roles/:userId
```

---

## Database notes

The backend uses PostgreSQL through the shared `pg` pool. The schema is
initialized from `src/db/schema.sql` at startup, and all database operations
are asynchronous. Multi-step operations such as team-leader registration,
voting, draws, and projections use PostgreSQL transactions where their
dependent services share a transaction client.
