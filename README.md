# Tournament Manager API

Express REST API for creating and managing sports tournaments. Roles, private/public visibility, multi-stage formats, automatic draws, and a split between catalog entities (`Team`, `Player`) and tournament entries (`ParticipantTeam`, `ParticipantPlayer`).

Requires **Node.js 22.5+** (uses the built-in `node:sqlite` driver).

## Setup

```bash
npm install
cp .env.example .env
npm run seed
npm start
```

API base URL: `http://localhost:3000/api`

SQLite database file: `data/tournament.db`

### Seed accounts

| Role    | Email                      | Password    |
|---------|----------------------------|-------------|
| admin   | admin@tournament.local     | admin123    |
| referee | referee@tournament.local   | referee123  |
| user    | user@tournament.local      | user123     |

Send JWT as `Authorization: Bearer <token>`.

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
