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
**Body**
```json
{ "email": "string (required)", "password": "string (required)", "name": "string (required)", "role": "'user' | 'referee' (optional, defaults to 'user')" }
```
**Response `201`**
```json
{ "user": { "id", "email", "name", "role", "createdAt" }, "token": "JWT (7d expiry)" }
```
**Errors**: `400` missing fields.

### `POST /auth/login` — Public
**Body**
```json
{ "email": "string (required)", "password": "string (required)" }
```
**Response `200`**: same shape as register.
**Errors**: `400` missing fields, `401` invalid credentials.

### `GET /auth/me` — Auth
**Response `200`**
```json
{ "user": { "id", "email", "name", "role", "createdAt" } }
```

### `GET /users` — Auth + admin
**Response `200`**
```json
{ "users": [ { "id", "email", "name", "role", "createdAt" } ] }
```

### `PATCH /users/:id/role` — Auth + admin
**Body**
```json
{ "role": "'admin' | 'referee' | 'user'" }
```
**Response `200`**: `{ "user": {...} }`
**Errors**: `400` invalid role, `404` user not found.


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
  "stages": [ { "type": "'league'|'knockout'", "sequenceOrder": "number", "settings": {}, "groups": [ { "name", "sequenceOrder", "number_teams" } ] } ]
}
```
**Response `201`**
```json
{ "tournament": {...}, "stages": [...] }
```
**Errors**: `400` missing name / invalid stage type.

### `PATCH /tournaments/:tournamentId` — Auth + tournament role `moderator`
**Body** *(all optional)*
```json
{ "name", "status", "visibility", "numberOfTeams", "place" }
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

### `GET /teams` — Optional
**Response `200`**: `{ "teams": [ { "id", "name", "slug", "shortName", "colors": {"primary","secondary"}, "city", "country", "foundedYear", "createdAt" } ] }`

### `GET /teams/:id` — Optional
**Response `200`**: `{ "team": {...} }`
**Errors**: `404`

### `POST /teams` — Auth + admin
**Body**
```json
{ "name": "string (required)", "slug": "string (optional)", "shortName", "primaryColor" | "colors.primary", "secondaryColor" | "colors.secondary", "city", "country", "foundedYear" }
```
**Response `201`**: `{ "team": {...} }`
**Errors**: `400` missing name.

### `PATCH /teams/:id` — Auth + admin
**Body** *(all optional, same fields as create)*
**Response `200`**: `{ "team": {...} }`
**Errors**: `404`

### `DELETE /teams/:id` — Auth + admin
**Response `204`**
**Errors**: `404`

---

## Players

### `GET /players` — Optional
**Response `200`**: `{ "players": [ { "id", "name", "slug", "nickname", "dateOfBirth", "nationality", "position", "preferredFoot", "heightCm", "createdAt" } ] }`

### `GET /players/:id` — Optional
**Response `200`**: `{ "player": {...} }`
**Errors**: `404`

### `POST /players` — Auth + admin
**Body**
```json
{ "name": "string (required)", "slug": "string (optional)", "nickname", "dateOfBirth", "nationality", "position", "preferredFoot", "heightCm" }
```
**Response `201`**: `{ "player": {...} }`
**Errors**: `400` missing name.

### `PATCH /players/:id` — Auth + admin
**Body** *(all optional)*
**Response `200`**: `{ "player": {...} }`
**Errors**: `404`

### `DELETE /players/:id` — Auth + admin
**Response `204`**
**Errors**: `404`

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

## Participant Players (a player's roster spot on a participant team)

### `GET /tournaments/:tournamentId/participant-teams/:id/players` — Optional
**Response `200`**: `{ "participantPlayers": [ { "id", "participantTeamId", "playerId", "shirtNumber", "role", "status", "yellowCards", "redCards", "goals", "assists", "player": {"id","name","slug","position"} } ] }`
**Errors**: `403` private tournament, `404` participant team not found.

### `POST /tournaments/:tournamentId/participant-teams/:id/players` — Auth + tournament role `moderator`
**Body**
```json
{ "playerId": "string (required)", "shirtNumber": "number", "role": "'player'|'captain'|'goalkeeper' (default 'player')", "status": "'active'|'injured'|'suspended'|'ineligible' (default 'active')" }
```
**Response `201`**: `{ "participantPlayer": {...} }`
**Errors**: `400` missing playerId, `404` participant team / player not found.

### `PATCH /tournaments/:tournamentId/participant-players/:id` — Auth + tournament role `moderator`
**Body** *(all optional)*
```json
{ "shirtNumber", "role", "status", "yellowCards", "redCards", "goals", "assists" }
```
**Response `200`**: `{ "participantPlayer": {...} }`
**Errors**: `404`

### `DELETE /tournaments/:tournamentId/participant-players/:id` — Auth + tournament role `moderator`
**Response `204`**
**Errors**: `404`

---

## Draw

### `POST /tournaments/:tournamentId/draw` — Auth + tournament role `moderator`
**Body**
```json
{ "stageId": "string (optional — draws the tournament's current stage if omitted)" }
```
**Response `201`**
```json
{ "draw": { /* result of runDraw() — shape defined in drawService.js (not provided) */ } }
```
**Errors**: `400` missing tournamentId, `404` tournament not found.

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


### `DELETE /tournaments/:tournamentId/votes/:voteId/nominees/:nomineeId` — Auth + tournament role `moderator`
**Response `204`**
**Errors**: `404`

---


### `GET    /tournaments/:tournamentId/roles` - Auth + tournament owner
**Response `{[role: 'moderator' | 'referee', userId: '...'], ...}`**
**Errors**: `404`: tournament not found or roles are not set


### `GET    /tournaments/:tournamentId/roles/:userId` - Auth + tournament owner
**Response `{role: '...'}`**
**Errors**: `404` : tournament / user not found

### `POST   /tournaments/:tournamentId/roles/:userId      { role: 'referee' | 'moderator' }`
**Response**: `201`
**Errors**: `404`: tournament / user not found
            `400` : this user already have a role

### `PATCH  /tournaments/:tournamentId/roles/:userId      { role: 'referee' | 'moderator' }`
**Response**: `204`
**Errors**: `404`: tournament / user not found
            `400`: only referee and moderator roles are available | 


### `DELETE /tournaments/:tournamentId/roles/:userId`
**Response**: `204`
**Errors**: `404`: tournament / user not found


---

