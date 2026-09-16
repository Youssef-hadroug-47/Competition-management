/* ---------------------------------------------------------------------
 * api.js — talks to the Tournament Manager backend (see /src/routes).
 * No frameworks, just fetch(). Every function returns a Promise that
 * resolves to the parsed JSON body, or throws an Error with .status.
 * ------------------------------------------------------------------- */
const API = (() => {
  const DEFAULT_BASE = 'http://localhost:3000/api';

  function getBaseUrl() {
    return localStorage.getItem('tm_base_url') || DEFAULT_BASE;
  }
  function setBaseUrl(url) {
    localStorage.setItem('tm_base_url', url.replace(/\/+$/, ''));
  }
  function getToken() {
    return localStorage.getItem('tm_token') || null;
  }
  function setToken(token) {
    if (token) localStorage.setItem('tm_token', token);
    else localStorage.removeItem('tm_token');
  }
  function getUser() {
    try { return JSON.parse(localStorage.getItem('tm_user')); } catch { return null; }
  }
  function setUser(user) {
    if (user) localStorage.setItem('tm_user', JSON.stringify(user));
    else localStorage.removeItem('tm_user');
  }
  function isLoggedIn() {
    return !!getToken();
  }
  function hasRole(...roles) {
    const u = getUser();
    return !!u && roles.includes(u.role);
  }

  async function request(path, { method = 'GET', body, auth = true } = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (auth && getToken()) headers.Authorization = 'Bearer ' + getToken();

    let res;
    try {
      res = await fetch(getBaseUrl() + path, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (networkErr) {
      const err = new Error(
        `Could not reach the API at ${getBaseUrl()}. Is the server running and is the base URL correct?`
      );
      err.status = 0;
      throw err;
    }

    if (res.status === 204) return null;

    const text = await res.text();
    let data = null;
    if (text) {
      try { data = JSON.parse(text); } catch { data = { raw: text }; }
    }

    if (!res.ok) {
      const msg = (data && (data.error || data.message)) || res.statusText || `HTTP ${res.status}`;
      const err = new Error(msg);
      err.status = res.status;
      err.data = data;
      if (res.status === 401) { setToken(null); setUser(null); }
      throw err;
    }
    return data;
  }

  /* ---- Auth ---- */
  const auth = {
    register: (body) => request('/auth/register', { method: 'POST', body, auth: false }),
    login: (body) => request('/auth/login', { method: 'POST', body, auth: false }),
    me: () => request('/auth/me'),
    listUsers: () => request('/users'),
    updateRole: (id, role) => request(`/users/${id}/role`, { method: 'PATCH', body: { role } }),
  };

  /* ---- Tournaments & format (stages/groups) ---- */
  const tournaments = {
    list: () => request('/tournaments'),
    get: (id) => request(`/tournaments/${id}`),
    create: (body) => request('/tournaments', { method: 'POST', body }),
    update: (id, body) => request(`/tournaments/${id}`, { method: 'PATCH', body }),
    remove: (id) => request(`/tournaments/${id}`, { method: 'DELETE' }),

    getStage: (stageId) => request(`/stages/${stageId}`),
    addStage: (tournamentId, body) => request(`/tournaments/${tournamentId}/stages`, { method: 'POST', body }),
    updateStage: (stageId, body) => request(`/stages/${stageId}`, { method: 'PATCH', body }),
    removeStage: (stageId) => request(`/stages/${stageId}`, { method: 'DELETE' }),

    addGroup: (stageId, body) => request(`/stages/${stageId}/groups`, { method: 'POST', body }),
    updateGroup: (groupId, body) => request(`/groups/${groupId}`, { method: 'PATCH', body }),
    removeGroup: (groupId) => request(`/groups/${groupId}`, { method: 'DELETE' }),

    addRound: (stageId, body) => request(`/stages/${stageId}/rounds`, { method: 'POST', body }),
    updateRound: (roundId, body) => request(`/rounds/${roundId}`, { method: 'PATCH', body }),
    removeRound: (roundId) => request(`/rounds/${roundId}`, { method: 'DELETE' }),

    follow: (id) => request(`/tournaments/${id}/follow`, { method: 'POST' }),
    unfollow: (id) => request(`/tournaments/${id}/follow`, { method: 'DELETE' }),
    listFollowers: (id) => request(`/tournaments/${id}/followers`),
    moderateFollow: (id, userId, status) =>
      request(`/tournaments/${id}/follow-requests/${userId}`, { method: 'PATCH', body: { status } }),
  };

  /* ---- Catalog: teams & players ---- */
  const teams = {
    list: () => request('/teams'),
    get: (id) => request(`/teams/${id}`),
    create: (body) => request('/teams', { method: 'POST', body }),
    update: (id, body) => request(`/teams/${id}`, { method: 'PATCH', body }),
    remove: (id) => request(`/teams/${id}`, { method: 'DELETE' }),
  };
  const players = {
    list: () => request('/players'),
    get: (id) => request(`/players/${id}`),
    create: (body) => request('/players', { method: 'POST', body }),
    update: (id, body) => request(`/players/${id}`, { method: 'PATCH', body }),
    remove: (id) => request(`/players/${id}`, { method: 'DELETE' }),
  };

  /* ---- Participants (teams/players registered into a tournament) ---- */
  const participants = {
    listTeams: (tournamentId) => request(`/tournaments/${tournamentId}/participant-teams`),
    addTeam: (tournamentId, body) =>
      request(`/tournaments/${tournamentId}/participant-teams`, { method: 'POST', body }),
    updateTeam: (participantTeamId, body) =>
      request(`/participant-teams/${participantTeamId}`, { method: 'PATCH', body }),
    removeTeam: (participantTeamId) =>
      request(`/participant-teams/${participantTeamId}`, { method: 'DELETE' }),

    listPlayers: (participantTeamId) => request(`/participant-teams/${participantTeamId}/players`),
    addPlayer: (participantTeamId, body) =>
      request(`/participant-teams/${participantTeamId}/players`, { method: 'POST', body }),
    updatePlayer: (participantPlayerId, body) =>
      request(`/participant-players/${participantPlayerId}`, { method: 'PATCH', body }),
    removePlayer: (participantPlayerId) =>
      request(`/participant-players/${participantPlayerId}`, { method: 'DELETE' }),
  };

  /* ---- Draw & matches ---- */
  const matches = {
    draw: (tournamentId, stageId) =>
      request(`/tournaments/${tournamentId}/draw`, { method: 'POST', body: stageId ? { stageId } : {} }),
    list: (tournamentId) => request(`/tournaments/${tournamentId}/matches`),
    get: (id) => request(`/matches/${id}`),
    start: (id, venue) => request(`/matches/${id}/start`, { method: 'POST', body: venue ? { venue } : {} }),
    update: (id, body) => request(`/matches/${id}`, { method: 'PATCH', body }),
    finish: (id, body) => request(`/matches/${id}/finish`, { method: 'POST', body }),
    simulate: (id) => request(`/matches/${id}/simulate`, { method: 'POST' }),
  };

  const simulate = {
    match: (matchId) => request(`/matches/${matchId}/simulate`, { method: 'POST' }),
    stage: (stageId) => request(`/stages/${stageId}/simulate`, { method: 'POST' }),
    tournament: (tournamentId) => request(`/tournaments/${tournamentId}/simulate`, { method: 'POST' }),
  };

  const vote = {
    getAll: (tournamentId) => request(`/tournaments/${tournamentId}/votes`) ,
    get: (id) => request(`/votes/${id}`),
    create: (tournamentId) => request(`/tournaments/${tournamentId}/votes`, {method: 'POST', body}),
    update: (id) => request(`/votes/${id}`, { method: 'PATCH', body}),
    delete: (id) => request(`/votes/${id}`, {method: 'DELETE'}),
  };

  const nominees = {
    get: (voteId) => request(`/votes/${voteId}/nominees`),
    create: (voteId) => request(`/votes/${voteId}/nominees`, { method: 'POST', body}),
    setVotes: (voteId, nomineeId) => request(`/votes/${voteId}/nominees/${nomineeId}`, { method: 'POST', body}),
    delete: (voteId, nomineeId) => request(`/votes/${voteId}/nominees/${nomineeId}`, {method: 'DELETE'}),
  };

  return {
    getBaseUrl, setBaseUrl, getToken, setToken, getUser, setUser, isLoggedIn, hasRole,
    request, auth, tournaments, teams, players, participants, matches, simulate, vote, nominees,
  };
})();
