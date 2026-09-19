/**
 * tournament.js — one tournament, loaded from ?id=<tournamentId>.
 *
 * Page shell: a hero info block, then a single tabbed panel with three
 * views — Matches, Standings & bracket, Top scorers — of which only one
 * is ever in the DOM's "active" state at a time (#content-tabs drives
 * #content-body). "Standings & bracket" has its own secondary,
 * stage-scoped toggle nested inside it (pill-style, visually distinct
 * from the primary tabs — see .pill-tabs in styles.css) since a
 * tournament can have more than one stage and only one is shown at once.
 *
 * SECURITY NOTES SPECIFIC TO THIS PAGE:
 *  - The id comes straight from the URL, i.e. from the user (or from
 *    whatever page linked here). It's validated with a strict allow-list
 *    pattern before it's used for anything, and every place it (or any
 *    other id) reaches api.js it's run through `enc()` there, which
 *    URL-encodes it so it can only ever occupy a single path segment.
 *  - Private tournaments are enforced entirely server-side
 *    (`access.requireTournamentInspect` in the backend). This page does
 *    not try to duplicate that logic or infer visibility on its own —
 *    it just surfaces whatever the server decides (200, 403, 404) and
 *    never renders tournament content the server didn't actually send.
 *  - All rendering goes through UI.el()/textContent (see ui.js) so
 *    tournament/team/player names from the API can't be interpreted as
 *    markup.
 */
(function () {
  const { el, clear, showBanner, friendlyErrorMessage } = UI;

  const topbarActions = document.getElementById('topbar-actions');
  const banner = document.getElementById('banner');
  const loadingPanel = document.getElementById('loading-panel');
  const heroPanel = document.getElementById('hero-panel');
  const heroName = document.getElementById('hero-name');
  const heroVisibility = document.getElementById('hero-visibility');
  const heroMeta = document.getElementById('hero-meta');
  const heroActions = document.getElementById('hero-actions');
  const tabsPanel = document.getElementById('tabs-panel');
  const contentTabs = document.getElementById('content-tabs');
  const contentBody = document.getElementById('content-body');

  // A tournament id is an opaque token from `utils/ids.js` on the
  // backend — we don't know its exact shape, so we allow-list generously
  // (letters, digits, - and _, a sane length) rather than trying to
  // guess the precise format. Anything else is rejected before it ever
  // reaches fetch().
  const ID_PATTERN = /^[A-Za-z0-9_-]{1,100}$/;

  function getTournamentId() {
    const raw = new URLSearchParams(location.search).get('id') || '';
    return ID_PATTERN.test(raw) ? raw : null;
  }

  function formatDate(iso) {
    if (!iso) return null;
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return null;
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  }

  function formatDateTime(iso) {
    if (!iso) return null;
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return null;
    return d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  function statusPill(status) {
    return el('span', { class: `status-pill status-pill--${status}`, text: status });
  }

  function stageKind(stage) {
    return stage.type === 'league' ? 'League' : 'Knockout';
  }

  function stageLabel(stage, index, total) {
    return total > 1 ? `${stageKind(stage)} · Stage ${index + 1}` : stageKind(stage);
  }

  // ---------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------
  async function init() {
    Header.render(topbarActions);
    Session.scheduleExpiryLogout(() => {
      showBanner(banner, 'You were signed out because your session expired.', 'error');
      Header.render(topbarActions);
    });

    const tournamentId = getTournamentId();
    if (!tournamentId) {
      loadingPanel.hidden = true;
      showBanner(banner, 'This tournament link looks invalid.');
      return;
    }

    let detail;
    try {
      detail = await Api.tournaments.get(tournamentId);
    } catch (err) {
      loadingPanel.hidden = true;
      if (err.status === 404) {
        showBanner(banner, 'Tournament not found. It may have been removed.');
      } else {
        // For 403 the server's own message ("This tournament is
        // private...") is written for end users — show it as-is.
        showBanner(banner, friendlyErrorMessage(err));
      }
      return;
    }

    loadingPanel.hidden = true;
    renderHero(detail.tournament, tournamentId);

    const stages = Array.isArray(detail.stages) ? detail.stages : [];

    const [participantTeams, matches] = await Promise.all([
      loadParticipantTeams(tournamentId),
      loadMatches(tournamentId),
    ]);

    const teamNameById = new Map(
      participantTeams.map((pt) => [pt.id, pt.team?.name || pt.nickname || `Seed ${pt.seed ?? '?'}`])
    );

    // Every group/round across every stage, by id -> display name. Used
    // by the "group by group" match view, which doesn't know ahead of
    // time whether a given match's groupId points at a league group or
    // a knockout round.
    const groupOrRoundNameById = new Map();
    const stageNameById = new Map();
    stages.forEach((stage, index) => {
      stageNameById.set(stage.id, stageLabel(stage, index, stages.length));
      (stage.groups || []).forEach((g) => groupOrRoundNameById.set(g.id, g.name));
      (stage.rounds || []).forEach((r) => groupOrRoundNameById.set(r.id, r.name));
    });

    // Shared, mutable page state — kept in one place so switching tabs
    // back and forth doesn't lose the user's stage selection or
    // re-trigger the top-scorers fetch.
    const state = {
      tournamentId,
      stages,
      matches,
      participantTeams,
      teamNameById,
      groupOrRoundNameById,
      stageNameById,
      activeStageId: stages[0]?.id || null,
      matchGroupMode: 'all',
      leaders: { promise: null, data: null },
    };

    tabsPanel.hidden = false;
    renderContentTabs(state);
  }

  // ---------------------------------------------------------------
  // Hero
  // ---------------------------------------------------------------
  function renderHero(tournament, tournamentId) {
    heroPanel.hidden = false;
    heroName.textContent = tournament.name;
    const isPrivate = tournament.visibility === 'private';
    heroVisibility.textContent = isPrivate ? 'Private' : 'Public';
    heroVisibility.className = `badge ${isPrivate ? 'badge--private' : ''}`;

    clear(heroMeta);
    const items = [
      tournament.place,
      tournament.status,
      tournament.numberOfTeams ? `${tournament.numberOfTeams} teams` : null,
      formatDate(tournament.createdAt) ? `Created ${formatDate(tournament.createdAt)}` : null,
    ].filter(Boolean);
    items.forEach((text) => heroMeta.appendChild(el('span', { class: 'tournament-hero__meta-item', text })));

    clear(heroActions);
    if (Session.isAuthenticated()) {
      renderFollowButton(tournamentId);
    }
  }

  async function renderFollowButton(tournamentId) {
    const btn = el('button', { class: 'btn btn--ghost', type: 'button', text: '…' });
    heroActions.appendChild(btn);
    btn.disabled = true;

    let following = false;
    try {
      const followed = await Api.follows.listFollowed();
      const items = Array.isArray(followed) ? followed : followed?.tournaments || [];
      following = items.some((t) => t.id === tournamentId);
    } catch {
      following = false; // worst case a click is a no-op 200
    }

    function paint() {
      btn.textContent = following ? 'Following' : 'Follow';
      btn.className = following ? 'btn btn--ghost' : 'btn btn--primary';
      btn.disabled = false;
    }
    paint();

    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        if (following) {
          await Api.follows.unfollow(tournamentId);
          following = false;
        } else {
          await Api.follows.follow(tournamentId);
          following = true;
        }
        paint();
      } catch (err) {
        showBanner(banner, friendlyErrorMessage(err));
        btn.disabled = false;
      }
    });
  }

  // ---------------------------------------------------------------
  // Data loading (matches, participant teams)
  // ---------------------------------------------------------------
  async function loadMatches(tournamentId) {
    try {
      const data = await Api.matches.list(tournamentId);
      return data?.matches || [];
    } catch (err) {
      showBanner(banner, friendlyErrorMessage(err));
      return [];
    }
  }

  async function loadParticipantTeams(tournamentId) {
    try {
      const data = await Api.participantTeams.list(tournamentId);
      return data?.participantTeams || [];
    } catch {
      return []; // team-name lookups just degrade to "TBD"
    }
  }

  // ---------------------------------------------------------------
  // Top-level tab shell: Matches / Standings & bracket / Top scorers
  // ---------------------------------------------------------------
  function renderContentTabs(state) {
    const tabs = [
      { id: 'matches', label: 'Matches', render: renderMatchesView },
      { id: 'standings', label: 'Standings & bracket', render: renderStandingsView },
      { id: 'leaders', label: 'Top scorers', render: renderLeadersView },
    ];

    clear(contentTabs);
    let activeTab = 'matches';

    function selectTab(tabId) {
      activeTab = tabId;
      [...contentTabs.children].forEach((btn) => {
        btn.setAttribute('aria-selected', String(btn.dataset.tabId === tabId));
      });
      clear(contentBody);
      tabs.find((t) => t.id === tabId).render(contentBody, state);
    }

    tabs.forEach((t) => {
      const btn = el('button', {
        class: 'tab',
        type: 'button',
        role: 'tab',
        'aria-selected': String(t.id === activeTab),
        text: t.label,
        onclick: () => selectTab(t.id),
      });
      btn.dataset.tabId = t.id;
      contentTabs.appendChild(btn);
    });

    selectTab(activeTab);
  }

  // ---------------------------------------------------------------
  // View: Matches — grouped by All / Stage / Matchday / Group
  // ---------------------------------------------------------------
  const MATCH_GROUP_MODES = [
    { id: 'all', label: 'All' },
    { id: 'stage', label: 'Stage' },
    { id: 'matchday', label: 'Matchday' },
    { id: 'group', label: 'Group' },
  ];

  function matchRow(m, state) {
    const home = state.teamNameById.get(m.homeParticipantTeamId) || 'TBD';
    const away = state.teamNameById.get(m.awayParticipantTeamId) || 'TBD';
    const hasScore = m.score && m.score.home != null && m.score.away != null;
    const metaParts = [formatDateTime(m.scheduledAt), m.venue].filter(Boolean);

    return el('li', { class: 'match-row' }, [
      el('div', { class: 'match-row__teams' }, [
        el('span', { text: home }),
        el('span', { text: 'vs', style: 'color: var(--text-muted); font-size:0.78rem;' }),
        el('span', { text: away }),
      ]),
      hasScore
        ? el('span', { class: 'match-row__score', text: `${m.score.home} \u2013 ${m.score.away}` })
        : el('span', { class: 'match-row__meta', text: '\u2014' }),
      statusPill(m.status),
      metaParts.length ? el('span', { class: 'match-row__meta', text: metaParts.join(' · ') }) : null,
    ]);
  }

  /** Returns an ordered array of { label, matches } buckets for the given grouping mode. */
  function groupMatches(mode, matches, state) {
    const sorted = [...matches].sort((a, b) => (a.matchday ?? 0) - (b.matchday ?? 0));

    if (mode === 'all') {
      return [{ label: null, matches: sorted }];
    }

    if (mode === 'stage') {
      const order = state.stages.map((s) => s.id);
      const buckets = new Map();
      sorted.forEach((m) => {
        const key = m.stageId || 'unknown';
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push(m);
      });
      const known = order.filter((id) => buckets.has(id)).map((id) => ({
        label: state.stageNameById.get(id) || 'Stage',
        matches: buckets.get(id),
      }));
      const unknown = buckets.has('unknown') ? [{ label: 'Unassigned', matches: buckets.get('unknown') }] : [];
      return [...known, ...unknown];
    }

    if (mode === 'matchday') {
      const buckets = new Map();
      sorted.forEach((m) => {
        const key = m.matchday ?? 'unscheduled';
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push(m);
      });
      const numeric = [...buckets.keys()].filter((k) => k !== 'unscheduled').sort((a, b) => a - b);
      const result = numeric.map((k) => ({ label: `Matchday ${k}`, matches: buckets.get(k) }));
      if (buckets.has('unscheduled')) result.push({ label: 'Unscheduled', matches: buckets.get('unscheduled') });
      return result;
    }

    if (mode === 'group') {
      const buckets = new Map();
      sorted.forEach((m) => {
        const key = m.groupId || 'unassigned';
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push(m);
      });
      const named = [...buckets.entries()]
        .filter(([key]) => key !== 'unassigned')
        .map(([key, ms]) => ({ label: state.groupOrRoundNameById.get(key) || 'Group', matches: ms }));
      const unassigned = buckets.has('unassigned') ? [{ label: 'Unassigned', matches: buckets.get('unassigned') }] : [];
      return [...named, ...unassigned];
    }

    return [{ label: null, matches: sorted }];
  }

  function renderMatchesView(container, state) {
    const toggle = el('div', { class: 'segmented-row' }, [
      el('span', { class: 'segmented-row__label', text: 'Group by' }),
      el(
        'div',
        { class: 'segmented', role: 'group', 'aria-label': 'Group matches by' },
        MATCH_GROUP_MODES.map((mode) =>
          el('button', {
            class: 'segmented__btn',
            type: 'button',
            'aria-pressed': String(state.matchGroupMode === mode.id),
            text: mode.label,
            onclick: () => {
              state.matchGroupMode = mode.id;
              clear(container);
              renderMatchesView(container, state);
            },
          })
        )
      ),
    ]);
    container.appendChild(toggle);

    const list = el('div', {});
    container.appendChild(list);

    if (!state.matches.length) {
      list.appendChild(el('p', { class: 'empty-state', text: 'No matches scheduled yet.' }));
      return;
    }

    const groups = groupMatches(state.matchGroupMode, state.matches, state);
    groups.forEach((group) => {
      if (group.label) list.appendChild(el('h3', { class: 'content-section__title', text: group.label }));
      list.appendChild(
        el(
          'ul',
          { class: 'match-list', style: group.label ? 'margin-bottom:22px;' : '' },
          group.matches.map((m) => matchRow(m, state))
        )
      );
    });
  }

  // ---------------------------------------------------------------
  // View: Standings & bracket — secondary, stage-scoped pill toggle.
  // Only the active stage's content is ever in the DOM at once.
  // ---------------------------------------------------------------
  function renderStandingsView(container, state) {
    if (!state.stages.length) {
      container.appendChild(el('p', { class: 'empty-state', text: 'No stages defined for this tournament yet.' }));
      return;
    }

    const tabsRow = el('div', { class: 'pill-tabs', role: 'tablist' });
    const body = el('div', {});
    container.appendChild(tabsRow);
    container.appendChild(body);

    function selectStage(stageId) {
      state.activeStageId = stageId;
      [...tabsRow.children].forEach((btn) => {
        btn.setAttribute('aria-selected', String(btn.dataset.stageId === stageId));
      });
      const stage = state.stages.find((s) => s.id === stageId);
      clear(body);
      if (stage.type === 'league') {
        renderStandings(body, state, stage);
      } else {
        renderBracket(body, state, stage);
      }
    }

    state.stages.forEach((stage, index) => {
      const btn = el('button', {
        class: 'pill-tab',
        type: 'button',
        role: 'tab',
        'aria-selected': String(stage.id === state.activeStageId),
        text: stageLabel(stage, index, state.stages.length),
        onclick: () => selectStage(stage.id),
      });
      btn.dataset.stageId = stage.id;
      tabsRow.appendChild(btn);
    });

    selectStage(state.activeStageId || state.stages[0].id);
  }

  // --- Standings ---------------------------------------------------
  //
  // Ranking is computed server-side by the standings service
  // (GET /tournaments/:tournamentId/stages/:stageId/standing) — this
  // is deliberately NOT recomputed here. The endpoint reads the stage's
  // own configured tiebreakers (points → goal difference → goals for →
  // head-to-head → sportsmanlike, per defaultStageSettings) and returns
  // each group as an already-final-order list of participantTeamIds
  // only. We resolve those IDs against the participant-teams data this
  // page already loaded, in the order the service gave them — this file
  // never re-sorts anything itself.
  function standingsTable(teams) {
    const rows = teams.map((t, i) =>
      el('tr', {}, [
        el('td', { text: `${i + 1}. ${t.team?.name || t.nickname || 'TBD'}` }),
        el('td', { text: String(t.stats?.played ?? 0) }),
        el('td', { text: String(t.stats?.won ?? 0) }),
        el('td', { text: String(t.stats?.drawn ?? 0) }),
        el('td', { text: String(t.stats?.lost ?? 0) }),
        el('td', { text: String(t.stats?.goalsFor ?? 0) }),
        el('td', { text: String(t.stats?.goalsAgainst ?? 0) }),
        el('td', { text: String(t.stats?.goalDifference ?? 0) }),
        el('td', { text: String(t.stats?.points ?? 0) }),
      ])
    );
    return el('table', { class: 'standings-table' }, [
      el('thead', {}, [
        el('tr', {}, ['Team', 'P', 'W', 'D', 'L', 'GF', 'GA', 'GD', 'Pts'].map((h) => el('th', { text: h }))),
      ]),
      el('tbody', {}, rows),
    ]);
  }

  async function renderStandings(container, state, stage) {
    container.appendChild(el('p', { class: 'empty-state', text: 'Loading standings…' }));
    let data;
    try {
      data = await Api.stages.standings(state.tournamentId, stage.id);
    } catch (err) {
      clear(container);
      container.appendChild(el('p', { class: 'empty-state', text: friendlyErrorMessage(err) }));
      return;
    }

    clear(container);
    const groups = data?.groups || [];
    if (!groups.length) {
      container.appendChild(el('p', { class: 'empty-state', text: 'No groups defined for this stage yet.' }));
      return;
    }

    const teamById = new Map(state.participantTeams.map((t) => [t.id, t]));
    const stageGroupNames = new Map((stage.groups || []).map((g) => [g.id, g.name]));

    groups.forEach((group) => {
      // Missing ids (e.g. a team fetched after the standings response
      // was generated) are dropped rather than shown as broken rows —
      // order is preserved for everything we *can* resolve.
      const teams = (group.order || []).map((id) => teamById.get(id)).filter(Boolean);
      const block = el('div', { class: 'group-block' }, [
        el('h3', { text: stageGroupNames.get(group.groupId) || 'Group' }),
        teams.length ? standingsTable(teams) : el('p', { class: 'empty-state', text: 'No teams assigned to this group yet.' }),
      ]);
      container.appendChild(block);
    });
  }

  // --- Knockout bracket --------------------------------------------
  function bracketMatchCard(m, state) {
    const home = state.teamNameById.get(m.homeParticipantTeamId) || 'TBD';
    const away = state.teamNameById.get(m.awayParticipantTeamId) || 'TBD';
    const finished = m.status === 'finished';
    const homeWon = finished && m.score.home != null && m.score.home > m.score.away;
    const awayWon = finished && m.score.away != null && m.score.away > m.score.home;

    const extras = [];
    if (m.score.extraTimeHome != null || m.score.extraTimeAway != null) {
      extras.push(`ET ${m.score.extraTimeHome ?? '\u2013'}-${m.score.extraTimeAway ?? '\u2013'}`);
    }
    if (m.score.penaltiesHome != null || m.score.penaltiesAway != null) {
      extras.push(`Pens ${m.score.penaltiesHome ?? '\u2013'}-${m.score.penaltiesAway ?? '\u2013'}`);
    }

    return el('div', { class: 'bracket-match' }, [
      el('div', { class: `bracket-match__team ${homeWon ? 'bracket-match__team--winner' : ''}` }, [
        el('span', { text: home }),
        el('span', { class: 'bracket-match__score', text: m.score.home ?? '\u2013' }),
      ]),
      el('div', { class: `bracket-match__team ${awayWon ? 'bracket-match__team--winner' : ''}` }, [
        el('span', { text: away }),
        el('span', { class: 'bracket-match__score', text: m.score.away ?? '\u2013' }),
      ]),
      extras.length ? el('div', { class: 'bracket-match__extra', text: extras.join(' · ') }) : null,
    ]);
  }

  function renderBracket(container, state, stage) {
    const rounds = [...(stage.rounds || [])].sort((a, b) => a.sequenceOrder - b.sequenceOrder);
    if (!rounds.length) {
      container.appendChild(el('p', { class: 'empty-state', text: 'No rounds defined for this stage yet.' }));
      return;
    }
    const columns = rounds.map((round) => {
      const roundMatches = state.matches
        .filter((m) => m.groupId === round.id)
        .sort((a, b) => (a.matchday ?? 0) - (b.matchday ?? 0));
      return el('div', { class: 'bracket-round' }, [
        el('div', { class: 'bracket-round__title', text: round.name }),
        ...(roundMatches.length
          ? roundMatches.map((m) => bracketMatchCard(m, state))
          : [el('p', { class: 'empty-state', text: 'No matches yet.' })]),
      ]);
    });
    container.appendChild(el('div', { class: 'bracket' }, columns));
  }

  // ---------------------------------------------------------------
  // View: Top scorers / assisters.
  //
  // There's no aggregate endpoint for this — participant_players'
  // goals/assists are only reachable per participant team
  // (GET /tournaments/:id/participant-teams/:teamId/players). Fetched
  // lazily (only when this tab is first opened) and cached on `state`
  // for the rest of the page's lifetime, since it's an N+1 fan-out
  // across every team's roster.
  // ---------------------------------------------------------------
  async function loadLeaders(state) {
    if (state.leaders.data) return state.leaders.data;
    if (state.leaders.promise) return state.leaders.promise;

    state.leaders.promise = (async () => {
      const results = await Promise.allSettled(
        state.participantTeams.map((pt) => Api.participantPlayers.list(state.tournamentId, pt.id))
      );

      const players = [];
      results.forEach((result, i) => {
        if (result.status !== 'fulfilled') return;
        const teamName = state.participantTeams[i].team?.name || state.participantTeams[i].nickname || 'Unknown team';
        const list = result.value?.participantPlayers || [];
        list.forEach((pp) => {
          players.push({
            name: pp.player?.name || 'Unknown player',
            team: teamName,
            goals: pp.goals || 0,
            assists: pp.assists || 0,
          });
        });
      });

      const data = {
        scorers: players.filter((p) => p.goals > 0).sort((a, b) => b.goals - a.goals || b.assists - a.assists).slice(0, 10),
        assisters: players.filter((p) => p.assists > 0).sort((a, b) => b.assists - a.assists || b.goals - a.goals).slice(0, 10),
      };
      state.leaders.data = data;
      return data;
    })();

    return state.leaders.promise;
  }

  function leaderboardList(items, valueKey) {
    if (!items.length) return el('p', { class: 'empty-state', text: 'No data recorded yet.' });
    return el(
      'ul',
      { class: 'leaderboard-list' },
      items.map((p) =>
        el('li', {}, [
          el('div', {}, [
            el('div', { class: 'leaderboard-list__name', text: p.name }),
            el('div', { class: 'leaderboard-list__team', text: p.team }),
          ]),
          el('span', { class: 'leaderboard-list__value', text: String(p[valueKey]) }),
        ])
      )
    );
  }

  async function renderLeadersView(container, state) {
    if (!state.participantTeams.length) {
      container.appendChild(el('p', { class: 'empty-state', text: 'No teams registered yet.' }));
      return;
    }
    container.appendChild(el('p', { class: 'empty-state', text: 'Loading…' }));
    let data;
    try {
      data = await loadLeaders(state);
    } catch (err) {
      clear(container);
      container.appendChild(el('p', { class: 'empty-state', text: friendlyErrorMessage(err) }));
      return;
    }
    clear(container);
    container.appendChild(
      el('div', { class: 'leaderboard' }, [
        el('div', {}, [el('h3', { text: 'Top scorers' }), leaderboardList(data.scorers, 'goals')]),
        el('div', {}, [el('h3', { text: 'Top assisters' }), leaderboardList(data.assisters, 'assists')]),
      ])
    );
  }

  init();
})();
