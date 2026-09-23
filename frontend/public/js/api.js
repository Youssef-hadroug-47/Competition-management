/**
 * api.js — the only file in this app that calls `fetch()`.
 *
 * Every request goes through `request()`, which:
 *  - builds the URL from config.js's API_BASE_URL (itself derived from .env)
 *  - attaches `Authorization: Bearer <token>` automatically when a session exists
 *  - sends/expects JSON only (no HTML forms, no reflected content types)
 *  - never sends cookies (`credentials: 'omit'`) — this API is bearer-token
 *    only, so there's nothing for the browser to attach, and this also
 *    means CSRF (which relies on ambient cookie auth) isn't a meaningful
 *    attack surface for these requests
 *  - on a 401, clears the local session and redirects to /login,
 *    since a 401 means the server has already stopped trusting the token
 *  - throws a typed ApiError with the server's own message when available,
 *    and a generic one otherwise (never leaks raw response bodies/stack
 *    traces into the UI)
 */

class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.isApiError = true;
    this.status = status;
  }
}

function apiBaseUrl() {
  const base = window.__APP_CONFIG__?.API_BASE_URL;
  if (!base) throw new Error('API_BASE_URL is not configured — run `npm run build:config`.');
  return base;
}


/**
 * Encodes a value used as a path segment. Every ID we pass into a URL is
 * either something the API itself gave us back, or something a user
 * typed into a query string (e.g. ?id=...) — either way, encoding it
 * here means it can only ever occupy exactly one path segment, so it
 * can't smuggle in a "/" to redirect the request to a different route,
 * a "?" to inject extra query params, or any other URL-structural
 * character.
 */
function enc(value) {
  return encodeURIComponent(String(value));
}

async function request(method, path, { body, query } = {}) {
  const url = new URL(apiBaseUrl() + path);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, v);
    }
  }

  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const token = window.Session.getToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  let res;
  try {
    res = await fetch(url.toString(), {
      method,
      headers,
      credentials: 'omit',
      cache: 'no-store',
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (networkErr) {
    throw new ApiError('Unable to reach the server.', 0);
  }

  if (res.status === 401) {
    window.Session.end();
    if (!location.pathname.endsWith('/login')) {
      const next = encodeURIComponent(location.pathname + location.search);
      location.href = `/login?next=${next}`;
    }
    throw new ApiError('Your session has expired. Please sign in again.', 401);
  }

  if (res.status === 204) return null;

  const text = await res.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      // Non-JSON response body — treat as opaque failure rather than
      // guessing at its shape.
      data = null;
    }
  }

  if (!res.ok) {
    const message = (data && typeof data.error === 'string' && data.error) || `Request failed (${res.status}).`;
    throw new ApiError(message, res.status);
  }

  return data;
}

const Api = {
  // ---- Auth ----
  auth: {
    register: (payload) => request('POST', '/auth/register', { body: payload, auth: false }),
    login: (payload) => request('POST', '/auth/login', { body: payload, auth: false }),
    me: () => request('GET', '/auth/me'),
  },

  users: {
    list: () => request('GET', '/users'),
    updateRole: (id, role) => request('PATCH', `/users/${enc(id)}/role`, { body: { role } }),
  },

  // ---- Tournaments ----
  tournaments: {
    list: () => request('GET', '/tournaments'),
    mine: () => request('GET', '/tournaments/mine'),
    searchByName: (name) => request('GET', '/tournaments/search', { query: { name } }),
    get: (tournamentId) => request('GET', `/tournaments/${enc(tournamentId)}`),
    create: (payload) => request('POST', '/tournaments', { body: payload }),
    update: (tournamentId, payload) => request('PATCH', `/tournaments/${enc(tournamentId)}`, { body: payload }),
    remove: (tournamentId) => request('DELETE', `/tournaments/${enc(tournamentId)}`),
    myRole: (tournamentId) =>
      request('GET', `/tournaments/${enc(tournamentId)}/roles/me`),
    listRoles: (tournamentId) => request('GET', `/tournaments/${enc(tournamentId)}/roles`),
    findStaffUser: (tournamentId, email) =>
      request('GET', `/tournaments/${enc(tournamentId)}/staff-users`, { query: { email } }),
    addRole: (tournamentId, userId, role) =>
      request('POST', `/tournaments/${enc(tournamentId)}/roles/${enc(userId)}`, { body: { role } }),
    updateRole: (tournamentId, userId, role) =>
      request('PATCH', `/tournaments/${enc(tournamentId)}/roles/${enc(userId)}`, { body: { role } }),
    removeRole: (tournamentId, userId) =>
      request('DELETE', `/tournaments/${enc(tournamentId)}/roles/${enc(userId)}`),
  },

  stages: {
    get: (tournamentId, stageId) => request('GET', `/tournaments/${enc(tournamentId)}/stages/${enc(stageId)}`),
    standings: (tournamentId, stageId) =>
      request('GET', `/tournaments/${enc(tournamentId)}/stages/${enc(stageId)}/standing`),
    add: (tournamentId, payload) => request('POST', `/tournaments/${enc(tournamentId)}/stages`, { body: payload }),
    update: (tournamentId, stageId, payload) =>
      request('PATCH', `/tournaments/${enc(tournamentId)}/stages/${enc(stageId)}`, { body: payload }),
    remove: (tournamentId, stageId) => request('DELETE', `/tournaments/${enc(tournamentId)}/stages/${enc(stageId)}`),
  },

  groups: {
    add: (tournamentId, stageId, payload) =>
      request('POST', `/tournaments/${enc(tournamentId)}/stages/${enc(stageId)}/groups`, { body: payload }),
    update: (tournamentId, groupId, payload) =>
      request('PATCH', `/tournaments/${enc(tournamentId)}/groups/${enc(groupId)}`, { body: payload }),
    remove: (tournamentId, groupId) => request('DELETE', `/tournaments/${enc(tournamentId)}/groups/${enc(groupId)}`),
  },

  rounds: {
    add: (tournamentId, stageId, payload) =>
      request('POST', `/tournaments/${enc(tournamentId)}/stages/${enc(stageId)}/rounds`, { body: payload }),
    update: (tournamentId, roundId, payload) =>
      request('PATCH', `/tournaments/${enc(tournamentId)}/rounds/${enc(roundId)}`, { body: payload }),
    remove: (tournamentId, roundId) => request('DELETE', `/tournaments/${enc(tournamentId)}/rounds/${enc(roundId)}`),
  },

  // ---- Catalog: teams & players ----
  teams: {
    list: () => request('GET', '/teams'),
    get: (id) => request('GET', `/teams/${enc(id)}`),
    create: (payload) => request('POST', '/teams', { body: payload }),
    update: (id, payload) => request('PATCH', `/teams/${enc(id)}`, { body: payload }),
    remove: (id) => request('DELETE', `/teams/${enc(id)}`),
  },

  players: {
    list: () => request('GET', '/players'),
    get: (id) => request('GET', `/players/${enc(id)}`),
    create: (payload) => request('POST', '/players', { body: payload }),
    update: (id, payload) => request('PATCH', `/players/${enc(id)}`, { body: payload }),
    remove: (id) => request('DELETE', `/players/${enc(id)}`),
  },

  participantTeams: {
    list: (tournamentId) => request('GET', `/tournaments/${enc(tournamentId)}/participant-teams`),
    add: (tournamentId, payload) =>
      request('POST', `/tournaments/${enc(tournamentId)}/participant-teams`, { body: payload }),
    autoAdd: (tournamentId, payload) =>
      request('POST', `/tournaments/${enc(tournamentId)}/participant-teams/auto`, { body: payload }),
    update: (tournamentId, id, payload) =>
      request('PATCH', `/tournaments/${enc(tournamentId)}/participant-teams/${enc(id)}`, { body: payload }),
    remove: (tournamentId, id) => request('DELETE', `/tournaments/${enc(tournamentId)}/participant-teams/${enc(id)}`),
  },

  participantPlayers: {
    list: (tournamentId, participantTeamId) =>
      request('GET', `/tournaments/${enc(tournamentId)}/participant-teams/${enc(participantTeamId)}/players`),
    add: (tournamentId, participantTeamId, payload) =>
      request('POST', `/tournaments/${enc(tournamentId)}/participant-teams/${enc(participantTeamId)}/players`, {
        body: payload,
      }),
    autoAdd: (tournamentId, participantTeamId, payload) =>
      request('POST', `/tournaments/${enc(tournamentId)}/participant-teams/${enc(participantTeamId)}/players/auto`, {
        body: payload,
      }),
    update: (tournamentId, id, payload) =>
      request('PATCH', `/tournaments/${enc(tournamentId)}/participant-players/${enc(id)}`, { body: payload }),
    remove: (tournamentId, id) => request('DELETE', `/tournaments/${enc(tournamentId)}/participant-players/${enc(id)}`),
  },

  // ---- Draw / matches / simulation ----
  draw: {
    run: (tournamentId, stageId) => request('POST', `/tournaments/${enc(tournamentId)}/draw`, { body: { stageId } }),
  },

  matches: {
    list: (tournamentId) => request('GET', `/tournaments/${enc(tournamentId)}/matches`),
    get: (tournamentId, id) => request('GET', `/tournaments/${enc(tournamentId)}/matches/${enc(id)}`),
    start: (tournamentId, id, payload) =>
      request('POST', `/tournaments/${enc(tournamentId)}/matches/${enc(id)}/start`, { body: payload }),
    update: (tournamentId, id, payload) =>
      request('PATCH', `/tournaments/${enc(tournamentId)}/matches/${enc(id)}`, { body: payload }),
    finish: (tournamentId, id, payload) =>
      request('POST', `/tournaments/${enc(tournamentId)}/matches/${enc(id)}/finish`, { body: payload }),
  },

  simulation: {
    match: (matchId) => request('POST', `/matches/${enc(matchId)}/simulate`),
    group: (groupId) => request('POST', `/groups/${enc(groupId)}/simulate`),
    round: (roundId) => request('POST', `/rounds/${enc(roundId)}/simulate`),
    stage: (stageId) => request('POST', `/stages/${enc(stageId)}/simulate`),
    tournament: (tournamentId) => request('POST', `/tournaments/${enc(tournamentId)}/simulate`),
  },

  // ---- Follows ----
  follows: {
    // Must be requested with a real session — the backend keys this off
    // the caller's own user id, there's no other way to scope it.
    listFollowed: () => request('GET', '/tournaments/followed'),
    follow: (tournamentId) => request('POST', `/tournaments/${enc(tournamentId)}/follow`),
    unfollow: (tournamentId) => request('DELETE', `/tournaments/${enc(tournamentId)}/follow`),
    listFollowers: (tournamentId) => request('GET', `/tournaments/${enc(tournamentId)}/followers`),
    moderate: (tournamentId, userId, status) =>
      request('PATCH', `/tournaments/${enc(tournamentId)}/follow-requests/${enc(userId)}`, { body: { status } }),
  },

  // ---- Votes / nominees ----
  votes: {
    list: (tournamentId) => request('GET', `/tournaments/${enc(tournamentId)}/votes`),
    get: (tournamentId, id) => request('GET', `/tournaments/${enc(tournamentId)}/votes/${enc(id)}`),
    create: (tournamentId, payload) => request('POST', `/tournaments/${enc(tournamentId)}/votes`, { body: payload }),
    update: (tournamentId, id, payload) =>
      request('PATCH', `/tournaments/${enc(tournamentId)}/votes/${enc(id)}`, { body: payload }),
    remove: (tournamentId, id) => request('DELETE', `/tournaments/${enc(tournamentId)}/votes/${enc(id)}`),
  },

  nominees: {
    list: (tournamentId, voteId) =>
      request('GET', `/tournaments/${enc(tournamentId)}/votes/${enc(voteId)}/nominees`),
    add: (tournamentId, voteId, nomineeId) =>
      request('POST', `/tournaments/${enc(tournamentId)}/votes/${enc(voteId)}/nominees`, { body: { nomineeId } }),
    castVote: (tournamentId, voteId, nomineeId, userId) =>
      request('POST', `/tournaments/${enc(tournamentId)}/votes/${enc(voteId)}/nominees/${enc(nomineeId)}`, { body: { userId } }),
    remove: (tournamentId, voteId, nomineeId) =>
      request('DELETE', `/tournaments/${enc(tournamentId)}/votes/${enc(voteId)}/nominees/${enc(nomineeId)}`),
  },
};

window.Api = Api;
window.ApiError = ApiError;
