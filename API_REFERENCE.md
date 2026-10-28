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

## Mail

### `POST /mail/test` — Auth + admin
Sends a test message through the configured SMTP service.
**Body**
```json
{ "to": "recipient@example.com (optional, defaults to the signed-in admin's email)" }
```
**Response `200`**: `{ "ok": true, "to": "recipient@example.com", "messageId": "..." }`
**Errors**: `400` invalid recipient, `502` mail service rejected or unreachable, `503` email delivery is not configured.

---

## Auth

### `POST /auth/register` — Public
**Body**
`{ "email": "valid email", "password": "at least 8 characters", "name": "1-120 characters" }`

**Response `201`**: `{ "message": "Account created. Check your email for a verification link." }`
No session is created until the address has been verified.
**Errors**: `400` invalid or missing fields; `409` an account with that email already exists (`details.code = "EMAIL_TAKEN"`, regardless of verification state); `503` the account was created but the verification email delivery failed (`details.code = "EMAIL_DELIVERY_FAILED"`, instructs the user to sign in to resend). Registration never offers a resend action; resending is exposed from sign-in only after a correct password.

### `POST /auth/verify-email` — Public
**Body**: `{ "token": "one-time token from verification email" }`
**Response `200`**: `{ "message": "Email verified. You can now sign in.", "email": "verified address" }`
**Errors**: `400` invalid, expired, or already-used token; response advises requesting a new verification email.

### `POST /auth/resend-verification` — Public
**Body**: `{ "email": "string" }`
**Response `202`**: generic troubleshooting guidance whether or not an unverified account exists, to avoid disclosing account state. Resends are limited to one email per address each minute. The web UI exposes this action from the sign-in page only after the password check succeeds.
**Errors**: `400` invalid email; `429` cooldown still active (`details.code = "VERIFICATION_COOLDOWN"`, `details.retryAfterSeconds`, plus a `Retry-After` header); `503` delivery/configuration guidance when email sending fails (`details.code = "EMAIL_DELIVERY_FAILED"`).

### `POST /auth/forgot-password` — Public
**Body**: `{ "email": "string" }`
**Response `202`**: always the same generic guidance (`"If an account exists for that address, a password reset link has been sent…"`), whether or not the account exists, is cooling down, or email delivery failed — this prevents account enumeration. Tokens are single-use, expire after 30 minutes, and are replaced by each new request.
**Errors**: `400` invalid email format only; delivery failures are logged server-side and never exposed.

### `POST /auth/reset-password` — Public
**Body**: `{ "token": "one-time token from the reset email", "password": "at least 8 characters (max 72 bytes)" }`
**Response `200`**: `{ "message": "Password updated. Sign in with your new password." }`
A successful reset consumes the token, verifies the email address, and revokes every existing session by incrementing `users.token_version`.
**Errors**: `400` invalid/expired/used token (`details.code = "INVALID_RESET_TOKEN"`), invalid password (`details.code = "INVALID_PASSWORD"`); responses never distinguish a missing token from an expired one.

### `POST /auth/login` — Public
**Body**
```json
{ "email": "string (required)", "password": "string (required)" }
```
**Response `200`**: `{ "user": { "id", "email", "name", "role", "emailVerified", "canCreateTournament", "createdAt" }, "token": "JWT (7d expiry)" }`
**Errors**: `400` missing fields, `401` invalid credentials, `403` email not verified (`details.code = "EMAIL_NOT_VERIFIED"`; the client can offer the resend-verification form). Tokens embed the account's `token_version`; completing a password reset invalidates all previously issued tokens.

### `GET /auth/providers` — Public
**Response `200`**: `{ "google": "boolean" }`

### `POST /oauth/google/start` — Public, browser top-level form post
**Body**: URL-encoded `{ "next": "same-origin application path (optional)" }`
The server validates the request origin and destination, starts Better Auth,
sets OAuth state cookies on the API origin, then redirects to Google.
**Errors**: `403` untrusted origin, `400` invalid destination, `503` Google OAuth is not configured.

Register this Google authorized redirect URI:
`https://API_HOST/api/better-auth/callback/google`.
Better Auth verifies the Google email and redirects to the API's internal
`GET /oauth/google/complete` callback. The callback links the identity only
when Google verified the same email, preserves an existing application role,
and redirects to the frontend with a short-lived one-time code in the URL
fragment.

### `POST /oauth/google/exchange` — Public, configured application Origin required
**Body**: `{ "code": "one-time OAuth exchange code" }`
**Response `200`**: same `{ "user": ..., "token": "JWT (7d expiry)" }` contract as password login. Codes expire after two minutes and are consumed once.
**Errors**: `400` invalid code, `401` expired/used code, `403` untrusted Origin.

### `GET /auth/me` — Auth
**Response `200`**
```json
{ "user": { "id", "email", "name", "role", "emailVerified", "canCreateTournament", "createdAt" } }
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

### `POST /tournaments` — Auth + tournament-creation policy
Access is controlled by `TOURNAMENT_CREATION`: `*` allows any authenticated
user; `admin` allows only administrators. Login and `GET /auth/me` responses
include `user.canCreateTournament` so clients can hide the action, but the API
remains the enforcement point.
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
**Errors**: `400` missing name, player cap outside 1–99, invalid player-registration mode, or invalid stage type; `401` authentication required (`details.code = "AUTH_REQUIRED"`); `403` account not allowed to create tournaments (`details.code = "TOURNAMENT_CREATION_FORBIDDEN"`); `503` tournament-creation policy is misconfigured (`details.code = "TOURNAMENT_CREATION_MISCONFIGURED"`).

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

## Tournament players

Player identity/profile, roster membership, and statistics live together in
the team-scoped `participant_players` row. There is no global `/players`
catalog. The row ID is the player ID used by match events, suspensions, and
votes; `creatorId` identifies the authenticated user who created it.

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
Creates a new player directly on the selected team. The server sets `creatorId`
from the authenticated user; slugs are unique within the team. The tournament's
`maxPlayersPerTeam` cap is checked under a team-row lock before insertion.
**Response `201`**: `{ "participantPlayer": {...} }`
**Errors**: `400` missing name, `404` participant team not found, `409` duplicate team-local slug or configured roster limit reached.
**Errors** also include `403` when direct player entry is disabled by tournament settings.

### Player invite codes — Auth + tournament moderator/admin or owning team leader

The moderator routes below manage any team in the tournament. Team leaders use
the equivalent `/team-leader/teams/:id/player-invite-codes` paths and can only
manage their own team. These operations are available only when
`playerRegistrationMode` is `invite_code` or `both`.

- `GET /tournaments/:tournamentId/participant-teams/:id/player-invite-codes`
  returns active code metadata, never the code itself.
- `POST /tournaments/:tournamentId/participant-teams/:id/player-invite-codes`
  creates one code. Its response contains a 16-character hexadecimal code
  exactly once; store/share it before leaving the response. Codes are hashed
  at rest, expire after seven days, and reserve one roster slot.
- `DELETE /tournaments/:tournamentId/participant-teams/:id/player-invite-codes/:codeId`
  revokes an unused code and releases its reserved slot.
- Team leaders use `GET|POST /tournaments/:tournamentId/team-leader/teams/:id/player-invite-codes`
  and `DELETE /tournaments/:tournamentId/team-leader/teams/:id/player-invite-codes/:codeId`.

Issuance is limited to 100 attempts per hour per account. Code validation and
redemption are limited to 10 attempts per 15 minutes per account.
**Errors**: `403` mode/ownership restriction, `404` team/code not found,
`409` no unreserved roster capacity, `429` rate limit exceeded.

### `GET /player-invite-codes/membership` — Authenticated user

Returns the account's invite-code registration, or `{ "membership": null }`
when it has not joined a team. An account can redeem a code for one team only;
the database enforces this even if concurrent requests use different codes.

### `POST /player-invite-codes/validate` — Authenticated user

**Body**: `{ "code": "16 hex characters" }`

Checks an unexpired unused code without consuming it, then returns its team and
tournament names plus `participantTeamId`. The user can then complete the
player form. It returns `409` if this account has already joined a team. This
check does not replace redemption-time validation.

### `POST /player-invite-codes/redeem` — Authenticated user

**Body**: `{ "code": "16 hex characters", "player": { "name": "required", "...": "player fields" } }`

Validates player fields and roster capacity and creates the player in the same
transaction that deletes the code. Invalid submissions leave the code
available; concurrent redemption can succeed only once. Successful redemption
binds the account to that one team and hides further code entry in the UI.
**Response `201`**: `{ "participantPlayer": {...} }`
**Errors**: `400` invalid/expired/used code or invalid player data, `409`
already joined a team, duplicate team-local slug, or full roster, `429` rate
limit exceeded.

### `POST /tournaments/:tournamentId/participant-teams/:id/players/auto` — Auth + admin
**Body**: `{ "count": "number (required)" }`

Creates enough new team-scoped player rows to reach the requested roster size;
the administrator is recorded as their creator. The requested total must not
exceed `maxPlayersPerTeam` after accounting for active invite-code reservations,
which are checked atomically before adding any players.
**Errors**: `400` invalid count, `404` participant team not found, `409` configured roster limit exceeded.

### `PATCH /tournaments/:tournamentId/participant-players/:id` — Auth + tournament role `moderator`
**Body** *(all optional)*
```json
{ "name", "slug", "nickname", "dateOfBirth", "nationality", "position", "preferredFoot", "heightCm", "shirtNumber", "role", "status", "yellowCards", "redCards", "goals", "assists" }
```
**Response `200`**: `{ "participantPlayer": {...} }`
The existing roster size is checked against the tournament cap before update.
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
divides the common configured group size; each destination group receives
exactly `groupSize / potCount` teams from each pot. Send `"potDraw": null` to
redraw without pots and clear saved assignments. If omitted, a valid saved
pot assignment is reused.
**Response `201`**: `{ "draw": { ... } }`
**Errors**: `400` invalid group/pot configuration, `404` tournament or stage
not found, `409` wrong number of teams or started stage.

### `GET /tournaments/:tournamentId/stages/:id/draw-pots` — Auth + tournament role `moderator`

Returns the selected stage's configured group capacities, current draw teams,
eligible pot counts (only when group sizes are equal and the team count matches
capacity), and previously saved pot assignments. This supplies the manual pot
editor in the draw dialog.
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

### `POST /tournaments/:tournamentId/votes/:voteId/nominees/team` — Auth + tournament role `moderator`
Adds every player of one team to the vote in a single query, skipping players already nominated.
**Body**
```json
{ "teamId": "string (required)" }
```
**Response `201`**: `{ "nominees": [ ...nominee objects ] }`
**Errors**: `400` missing teamId or team has no players, `404` vote or team not found, `409` vote finished.

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
