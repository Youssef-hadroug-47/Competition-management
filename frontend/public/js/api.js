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
 *  - on a 401, clears the local session and redirects to /login.html,
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

async function request(method, path, { body, auth = true, query } = {}) {
  const url = new URL(apiBaseUrl() + path);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, v);
    }
  }

  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (auth) {
    const token = window.Session.getToken();
    if (token) headers.Authorization = `Bearer ${token}`;
  }

  let res;
  try {
    res = await fetch(url.toString(), {
      method,
      headers,
      credentials: 'omit',
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    console.log(`${method} ${url.toString()}`);
  } catch (networkErr) {
    throw new ApiError('Unable to reach the server.', 0);
  }

  if (res.status === 401) {
    window.Session.end();
    if (!location.pathname.endsWith('/login.html')) {
      const next = encodeURIComponent(location.pathname + location.search);
      location.href = `/login.html?next=${next}`;
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

  console.log(data)
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
    updateRole: (id, role) => request('PATCH', `/users/${id}/role`, { body: { role } }),
  },

  // ---- Tournaments ----
  tournaments: {
    list: () => request('GET', '/tournaments', { auth: false }),
    get: (tournamentId) => request('GET', `/tournaments/${tournamentId}`, { auth: false }),
    create: (payload) => request('POST', '/tournaments', { body: payload }),
    update: (tournamentId, payload) => request('PATCH', `/tournaments/${tournamentId}`, { body: payload }),
    remove: (tournamentId) => request('DELETE', `/tournaments/${tournamentId}`),
  },

  stages: {
    get: (tournamentId, stageId) => request('GET', `/tournaments/${tournamentId}/stages/${stageId}`, { auth: false }),
    add: (tournamentId, payload) => request('POST', `/tournaments/${tournamentId}/stages`, { body: payload }),
    update: (tournamentId, stageId, payload) =>
      request('PATCH', `/tournaments/${tournamentId}/stages/${stageId}`, { body: payload }),
    remove: (tournamentId, stageId) => request('DELETE', `/tournaments/${tournamentId}/stages/${stageId}`),
  },

  groups: {
    add: (tournamentId, stageId, payload) =>
      request('POST', `/tournaments/${tournamentId}/stages/${stageId}/groups`, { body: payload }),
    update: (tournamentId, groupId, payload) =>
      request('PATCH', `/tournaments/${tournamentId}/groups/${groupId}`, { body: payload }),
    remove: (tournamentId, groupId) => request('DELETE', `/tournaments/${tournamentId}/groups/${groupId}`),
  },

  rounds: {
    add: (tournamentId, stageId, payload) =>
      request('POST', `/tournaments/${tournamentId}/stages/${stageId}/rounds`, { body: payload }),
    update: (tournamentId, roundId, payload) =>
      request('PATCH', `/tournaments/${tournamentId}/rounds/${roundId}`, { body: payload }),
    remove: (tournamentId, roundId) => request('DELETE', `/tournaments/${tournamentId}/rounds/${roundId}`),
  },

  // ---- Catalog: teams & players ----
  teams: {
    list: () => request('GET', '/teams', { auth: false }),
    get: (id) => request('GET', `/teams/${id}`, { auth: false }),
    create: (payload) => request('POST', '/teams', { body: payload }),
    update: (id, payload) => request('PATCH', `/teams/${id}`, { body: payload }),
    remove: (id) => request('DELETE', `/teams/${id}`),
  },

  players: {
    list: () => request('GET', '/players', { auth: false }),
    get: (id) => request('GET', `/players/${id}`, { auth: false }),
    create: (payload) => request('POST', '/players', { body: payload }),
    update: (id, payload) => request('PATCH', `/players/${id}`, { body: payload }),
    remove: (id) => request('DELETE', `/players/${id}`),
  },

  participantTeams: {
    list: (tournamentId) => request('GET', `/tournaments/${tournamentId}/participant-teams`, { auth: false }),
    add: (tournamentId, payload) =>
      request('POST', `/tournaments/${tournamentId}/participant-teams`, { body: payload }),
    update: (tournamentId, id, payload) =>
      request('PATCH', `/tournaments/${tournamentId}/participant-teams/${id}`, { body: payload }),
    remove: (tournamentId, id) => request('DELETE', `/tournaments/${tournamentId}/participant-teams/${id}`),
  },

  participantPlayers: {
    list: (tournamentId, participantTeamId) =>
      request('GET', `/tournaments/${tournamentId}/participant-teams/${participantTeamId}/players`, { auth: false }),
    add: (tournamentId, participantTeamId, payload) =>
      request('POST', `/tournaments/${tournamentId}/participant-teams/${participantTeamId}/players`, {
        body: payload,
      }),
    update: (tournamentId, id, payload) =>
      request('PATCH', `/tournaments/${tournamentId}/participant-players/${id}`, { body: payload }),
    remove: (tournamentId, id) => request('DELETE', `/tournaments/${tournamentId}/participant-players/${id}`),
  },

  // ---- Draw / matches / simulation ----
  draw: {
    run: (tournamentId, stageId) => request('POST', `/tournaments/${tournamentId}/draw`, { body: { stageId } }),
  },

  matches: {
    list: (tournamentId) => request('GET', `/tournaments/${tournamentId}/matches`, { auth: false }),
    get: (tournamentId, id) => request('GET', `/tournaments/${tournamentId}/matches/${id}`, { auth: false }),
    start: (tournamentId, id, payload) =>
      request('POST', `/tournaments/${tournamentId}/matches/${id}/start`, { body: payload }),
    update: (tournamentId, id, payload) =>
      request('PATCH', `/tournaments/${tournamentId}/matches/${id}`, { body: payload }),
    finish: (tournamentId, id, payload) =>
      request('POST', `/tournaments/${tournamentId}/matches/${id}/finish`, { body: payload }),
  },

  simulation: {
    match: (matchId) => request('POST', `/matches/${matchId}/simulate`),
    stage: (stageId) => request('POST', `/stages/${stageId}/simulate`),
    tournament: (tournamentId) => request('POST', `/tournaments/${tournamentId}/simulate`),
  },

  // ---- Follows ----
  follows: {
    // Must be requested with a real session — the backend keys this off
    // the caller's own user id, there's no other way to scope it.
    listFollowed: () => request('GET', '/tournaments/followed'),
    follow: (tournamentId) => request('POST', `/tournaments/${tournamentId}/follow`),
    unfollow: (tournamentId) => request('DELETE', `/tournaments/${tournamentId}/follow`),
    listFollowers: (tournamentId) => request('GET', `/tournaments/${tournamentId}/followers`),
    moderate: (tournamentId, userId, status) =>
      request('PATCH', `/tournaments/${tournamentId}/follow-requests/${userId}`, { body: { status } }),
  },

  // ---- Votes / nominees ----
  votes: {
    list: (tournamentId) => request('GET', `/tournaments/${tournamentId}/votes`, { auth: false }),
    get: (tournamentId, id) => request('GET', `/tournaments/${tournamentId}/votes/${id}`, { auth: false }),
    create: (tournamentId, payload) => request('POST', `/tournaments/${tournamentId}/votes`, { body: payload }),
    update: (tournamentId, id, payload) =>
      request('PATCH', `/tournaments/${tournamentId}/votes/${id}`, { body: payload }),
    remove: (tournamentId, id) => request('DELETE', `/tournaments/${tournamentId}/votes/${id}`),
  },

  nominees: {
    list: (tournamentId, voteId) =>
      request('GET', `/tournaments/${tournamentId}/votes/${voteId}/nominees`, { auth: false }),
    add: (tournamentId, voteId, nomineeId) =>
      request('POST', `/tournaments/${tournamentId}/votes/${voteId}/nominees`, { body: { nomineeId } }),
    castVote: (tournamentId, voteId, nomineeId, userId) =>
      request('POST', `/tournaments/${tournamentId}/votes/${voteId}/nominees/${nomineeId}`, { body: { userId } }),
    remove: (tournamentId, voteId, nomineeId) =>
      request('DELETE', `/tournaments/${tournamentId}/votes/${voteId}/nominees/${nomineeId}`),
  },
};

window.Api = Api;
window.ApiError = ApiError;
