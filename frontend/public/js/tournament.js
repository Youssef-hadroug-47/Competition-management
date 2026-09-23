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
  const { el, clear, showBanner, friendlyErrorMessage, confirmAction } = UI;

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

  async function loadViewerRole(tournamentId) {
    const user = Session.getUser();
    if (!user?.id) return null;
    try {
      const data = await Api.tournaments.myRole(tournamentId);
      return data?.role || null;
    } catch (err) {
      if (err.status === 401 || err.status === 403 || err.status === 404) return null;
      throw err;
    }
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

  function isAdmin() {
    return Session.getUser()?.role === 'admin';
  }

  function simulationButton(label, simulate, disabled = false) {
    if (!isAdmin()) return null;
    const button = el('button', {
      class: 'btn btn--ghost simulation-button',
      type: 'button',
      text: disabled ? 'Already decided' : label,
      ...(disabled ? { disabled: 'disabled', title: 'All results in this scope are already decided.' } : {}),
    });
    if (disabled) return button;
    button.addEventListener('click', async () => {
      if (!await confirmAction('Confirm simulation', `Run ${label.toLowerCase()}?`, 'Run simulation')) return;
      button.disabled = true;
      try {
        await simulate();
        location.reload();
      } catch (err) {
        button.disabled = false;
        showBanner(banner, friendlyErrorMessage(err));
      }
    });
    return button;
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
    const navigationState = UI.pageState(`tournament-${tournamentId}`);

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

    const stages = Array.isArray(detail.stages) ? detail.stages : [];
    const [participantTeams, matches, viewerRole] = await Promise.all([
      loadParticipantTeams(tournamentId),
      loadMatches(tournamentId),
      loadViewerRole(tournamentId),
    ]);
    loadingPanel.hidden = true;
    renderHero(detail.tournament, tournamentId, stages, matches);

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
      tournament: detail.tournament,
      viewerRole,
      stages,
      matches,
      participantTeams,
      teamNameById,
      groupOrRoundNameById,
      stageNameById,
      activeStageId: stages[0]?.id || null,
      matchGroupMode: MATCH_GROUP_MODES.some((mode) => mode.id === navigationState.get('matchGroupMode'))
        ? navigationState.get('matchGroupMode')
        : 'all',
      activeTab: navigationState.get('activeTab', 'matches'),
      navigationState,
      leaders: { promise: null, data: null },
      catalog: { teams: null, players: null },
      rosters: new Map(),
    };
    const savedStageId = navigationState.get('activeStageId');
    if (stages.some((stage) => stage.id === savedStageId)) state.activeStageId = savedStageId;
    tabsPanel.hidden = false;
    renderContentTabs(state);
    navigationState.restoreScroll();
  }

  // ---------------------------------------------------------------
  // Hero
  // ---------------------------------------------------------------
  function renderHero(tournament, tournamentId, stages, matches) {
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
      const actionGroups = el('div', { class: 'tournament-hero__actions' });
      heroActions.appendChild(actionGroups);
      renderFollowButton(tournamentId, actionGroups);
      renderDrawButton(tournamentId, stages, matches, actionGroups);
      const tournamentFinished = ['completed', 'cancelled'].includes(tournament.status);
      const simulate = simulationButton(
        'Simulate tournament',
        () => Api.simulation.tournament(tournamentId),
        tournamentFinished
      );
      if (simulate) actionGroups.appendChild(simulate);
      if (Session.getUser()?.id === tournament.createdBy) {
        actionGroups.appendChild(ownerDeleteButton(tournamentId));
      }
    }
  }

  function ownerDeleteButton(tournamentId) {
    const button = el('button', {
      class: 'btn btn--danger',
      type: 'button',
      text: 'Delete tournament',
    });
    button.addEventListener('click', async () => {
      if (!await confirmAction(
        'Delete tournament',
        'This permanently deletes the tournament, stages, matches, teams, players, and follow data. This cannot be undone.',
        'Delete permanently'
      )) return;

      button.disabled = true;
      button.textContent = 'Deleting…';
      try {
        await Api.tournaments.remove(tournamentId);
        location.href = '/index';
      } catch (err) {
        button.disabled = false;
        button.textContent = 'Delete tournament';
        showBanner(banner, friendlyErrorMessage(err));
      }
    });
    return button;
  }

  function renderDrawButton(tournamentId, stages, matches, actionContainer) {
    const drawButton = el('button', {
      class: 'btn btn--ghost',
      type: 'button',
      text: 'Run draw',
    });
    const controls = [drawButton];
    let stageSelect = null;

    if (stages.length > 1) {
      stageSelect = el('select', {
        class: 'draw-stage-select',
        'aria-label': 'Stage to draw',
      }, stages.map((stage, index) => el('option', {
        value: stage.id,
        text: stageLabel(stage, index, stages.length),
      })));
      controls.unshift(stageSelect);
    }

    const controlGroup = el('div', { class: 'hero-action-group' }, controls);
    actionContainer.appendChild(controlGroup);
    const updateDrawState = () => {
      const stageId = stageSelect?.value || stages[0]?.id;
      const alreadyDrawn = matches.some((match) => match.stageId === stageId);
      drawButton.disabled = alreadyDrawn;
      drawButton.textContent = alreadyDrawn ? 'Already drawn' : 'Run draw';
      drawButton.title = alreadyDrawn ? 'This stage already has matches.' : '';
    };
    stageSelect?.addEventListener('change', updateDrawState);
    updateDrawState();
    drawButton.addEventListener('click', async () => {
      const stageId = stageSelect?.value || stages[0]?.id;
      if (!stageId) {
        showBanner(banner, 'Create at least one stage before running a draw.');
        return;
      }
      if (!await confirmAction(
        'Confirm draw',
        'Run the draw for this stage? A stage cannot be redrawn after matches are created.',
        'Run draw'
      )) return;

      drawButton.disabled = true;
      if (stageSelect) stageSelect.disabled = true;
      drawButton.textContent = 'Drawing…';
      try {
        await Api.draw.run(tournamentId, stageId);
        location.reload();
      } catch (err) {
        showBanner(banner, friendlyErrorMessage(err));
        drawButton.disabled = false;
        if (stageSelect) stageSelect.disabled = false;
        drawButton.textContent = 'Run draw';
      }
    });
  }

  async function renderFollowButton(tournamentId, actionContainer) {
    const btn = el('button', { class: 'btn btn--ghost', type: 'button', text: '…' });
    actionContainer.appendChild(el('div', { class: 'hero-action-group' }, [btn]));
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
      { id: 'teams', label: 'Teams & players', render: renderTeamsView },
    ];
    if (state.tournament.visibility === 'private' && state.viewerRole === 'moderator') {
      tabs.push({ id: 'followers', label: 'Followers', render: renderFollowersView });
    }
    if (Session.getUser()?.id === state.tournament.createdBy) {
      tabs.push({ id: 'staff', label: 'Staff management', render: renderStaffView });
    }

    clear(contentTabs);
    let activeTab = tabs.some((tab) => tab.id === state.activeTab) ? state.activeTab : 'matches';

    function selectTab(tabId) {
      activeTab = tabId;
      state.activeTab = tabId;
      state.navigationState.save({ activeTab: tabId });
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

  async function renderFollowersView(container, state) {
    clear(container);
    container.appendChild(el('p', { class: 'empty-state', text: 'Loading follower requests…' }));
    let followers;
    try {
      const data = await Api.follows.listFollowers(state.tournamentId);
      followers = Array.isArray(data?.followers) ? data.followers : [];
    } catch (err) {
      clear(container);
      container.appendChild(el('p', { class: 'empty-state', text: friendlyErrorMessage(err) }));
      return;
    }

    clear(container);
    const pending = followers.filter((item) => item.status === 'pending');
    container.appendChild(el('div', { class: 'content-section__heading' }, [
      el('h2', { text: 'Follower requests' }),
      el('p', {
        class: 'field__hint',
        text: pending.length
          ? `${pending.length} request${pending.length === 1 ? '' : 's'} waiting for review.`
          : 'No follower requests are waiting for review.',
      }),
    ]));

    if (!followers.length) {
      container.appendChild(el('p', { class: 'empty-state', text: 'Nobody has followed this tournament yet.' }));
      return;
    }

    const list = el('ul', { class: 'follower-list' });
    followers.forEach((item) => {
      const user = item.user || {};
      const name = user.name || user.email || 'Unnamed user';
      const status = item.status || 'unknown';
      const actions = [];
      if (status === 'pending') {
        ['accepted', 'rejected'].forEach((nextStatus) => {
          const button = el('button', {
            class: `btn ${nextStatus === 'accepted' ? 'btn--primary' : 'btn--ghost'}`,
            type: 'button',
            text: nextStatus === 'accepted' ? 'Accept' : 'Reject',
          });
          button.addEventListener('click', async () => {
            button.disabled = true;
            try {
              await Api.follows.moderate(state.tournamentId, item.userId, nextStatus);
              const scrollY = window.scrollY;
              renderFollowersView(container, state);
              requestAnimationFrame(() => window.scrollTo({ top: scrollY, behavior: 'auto' }));
            } catch (err) {
              button.disabled = false;
              showBanner(banner, friendlyErrorMessage(err));
            }
          });
          actions.push(button);
        });
      }
      list.appendChild(el('li', { class: 'follower-row' }, [
        el('div', {}, [
          el('strong', { text: name }),
          el('div', { class: 'follower-row__meta', text: user.email && user.name ? user.email : '' }),
        ]),
        el('div', { class: 'follower-row__actions' }, [
          el('span', { class: `status-pill status-pill--${status}`, text: status }),
          ...actions,
        ]),
      ]));
    });
    container.appendChild(list);
  }

  async function renderStaffView(container, state) {
    clear(container);
    container.appendChild(el('p', { class: 'empty-state', text: 'Loading staff assignments…' }));
    let roles;
    try {
      const data = await Api.tournaments.listRoles(state.tournamentId);
      roles = Array.isArray(data) ? data : data?.roles || [];
    } catch (err) {
      clear(container);
      container.appendChild(el('p', { class: 'empty-state', text: friendlyErrorMessage(err) }));
      return;
    }

    clear(container);
    let selectedUser = null;
    const selectedUserView = el('div', { class: 'staff-user-selection', hidden: 'hidden' });
    const emailInput = el('input', {
      name: 'email',
      type: 'email',
      required: 'required',
      placeholder: 'user@example.com',
      autocomplete: 'off',
    });
    const lookupButton = el('button', { class: 'btn btn--ghost', type: 'button', text: 'Find user' });
    lookupButton.addEventListener('click', async () => {
      const email = emailInput.value.trim();
      if (!email) {
        emailInput.focus();
        return;
      }
      selectedUser = null;
      selectedUserView.hidden = true;
      lookupButton.disabled = true;
      lookupButton.textContent = 'Finding…';
      try {
        const data = await Api.tournaments.findStaffUser(state.tournamentId, email);
        selectedUser = data?.user || null;
        if (!selectedUser) throw new Error('The server returned no user.');
        selectedUserView.hidden = false;
        clear(selectedUserView);
        selectedUserView.appendChild(el('span', { class: 'staff-user-selection__label', text: 'Selected user' }));
        selectedUserView.appendChild(el('strong', { text: `${selectedUser.name} · ${selectedUser.id}` }));
      } catch (err) {
        showBanner(banner, friendlyErrorMessage(err));
      } finally {
        lookupButton.disabled = false;
        lookupButton.textContent = 'Find user';
      }
    });
    const addForm = el('form', { class: 'staff-management-form' }, [
      el('div', { class: 'field' }, [
        el('label', { text: 'User email' }),
        el('div', { class: 'staff-user-lookup' }, [emailInput, lookupButton]),
      ]),
      el('div', { class: 'field' }, [
        el('label', { text: 'Assignment' }),
        el('select', { name: 'role' }, [
          el('option', { value: 'moderator', text: 'Moderator' }),
          el('option', { value: 'referee', text: 'Referee' }),
        ]),
      ]),
      el('button', { class: 'btn btn--primary', type: 'submit', text: 'Add assignment' }),
    ]);
    addForm.appendChild(selectedUserView);
    addForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (!selectedUser?.id) {
        showBanner(banner, 'Find and select a user before adding an assignment.');
        return;
      }
      const userId = selectedUser.id;
      const role = addForm.elements.role.value;
      if (!userId) return;
      const button = addForm.querySelector('button[type="submit"]');
      button.disabled = true;
      try {
        await Api.tournaments.addRole(state.tournamentId, userId, role);
        const scrollY = window.scrollY;
        renderStaffView(container, state);
        requestAnimationFrame(() => window.scrollTo({ top: scrollY, behavior: 'auto' }));
      } catch (err) {
        button.disabled = false;
        showBanner(banner, friendlyErrorMessage(err));
      }
    });
    container.appendChild(el('div', { class: 'staff-management__intro' }, [
      el('h2', { text: 'Tournament staff' }),
      el('p', { class: 'field__hint', text: 'Find a user by exact email, then assign them as a moderator or referee. User IDs are internal identifiers, not passwords or access credentials.' }),
    ]));
    container.appendChild(addForm);

    if (!roles.length) {
      container.appendChild(el('p', { class: 'empty-state', text: 'No staff assignments found.' }));
      return;
    }
    const list = el('ul', { class: 'staff-list' });
    roles.forEach((assignment) => {
      const isCreator = assignment.user_id === state.tournament.createdBy;
      const roleSelect = el('select', { class: 'staff-row__role', 'aria-label': `Role for ${assignment.user_id}` }, [
        el('option', { value: 'moderator', text: 'Moderator' }),
        el('option', { value: 'referee', text: 'Referee' }),
      ]);
      roleSelect.value = assignment.role;
      roleSelect.disabled = isCreator;
      roleSelect.addEventListener('change', async () => {
        roleSelect.disabled = true;
        try {
          await Api.tournaments.updateRole(state.tournamentId, assignment.user_id, roleSelect.value);
          const scrollY = window.scrollY;
          renderStaffView(container, state);
          requestAnimationFrame(() => window.scrollTo({ top: scrollY, behavior: 'auto' }));
        } catch (err) {
          roleSelect.disabled = false;
          showBanner(banner, friendlyErrorMessage(err));
        }
      });
      const removeButton = el('button', {
        class: 'btn btn--danger staff-row__remove',
        type: 'button',
        text: 'Remove',
        ...(isCreator ? { disabled: 'disabled', title: 'The tournament creator must remain a moderator.' } : {}),
      });
      removeButton.addEventListener('click', async () => {
        removeButton.disabled = true;
        try {
          await Api.tournaments.removeRole(state.tournamentId, assignment.user_id);
          const scrollY = window.scrollY;
          renderStaffView(container, state);
          requestAnimationFrame(() => window.scrollTo({ top: scrollY, behavior: 'auto' }));
        } catch (err) {
          removeButton.disabled = false;
          showBanner(banner, friendlyErrorMessage(err));
        }
      });
      list.appendChild(el('li', { class: 'staff-row' }, [
        el('div', { class: 'staff-row__identity' }, [
          el('strong', { text: assignment.user_id }),
          isCreator ? el('span', { class: 'badge', text: 'Creator' }) : null,
        ]),
        el('div', { class: 'staff-row__actions' }, [roleSelect, removeButton]),
      ]));
    });
    container.appendChild(list);
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

    const children = [
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
    ];
    const simulate = simulationButton('Simulate', () => Api.simulation.match(m.id), m.status === 'finished');
    if (simulate) children.push(simulate);
    return el('li', { class: 'match-row' }, children);
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
              state.navigationState.save({ matchGroupMode: mode.id });
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
    const stageActions = el('div', { class: 'simulation-section-heading simulation-section-heading--stage' });
    const body = el('div', {});
    container.appendChild(tabsRow);
    container.appendChild(stageActions);
    container.appendChild(body);

    function selectStage(stageId) {
      state.activeStageId = stageId;
      state.navigationState.save({ activeStageId: stageId });
      [...tabsRow.children].forEach((btn) => {
        btn.setAttribute('aria-selected', String(btn.dataset.stageId === stageId));
      });
      const stage = state.stages.find((s) => s.id === stageId);
      clear(stageActions);
      const stageMatches = state.matches.filter((match) => match.stageId === stage.id);
      const simulate = simulationButton(
        'Simulate stage',
        () => Api.simulation.stage(stage.id),
        stageMatches.length > 0 && stageMatches.every((match) => match.status === 'finished')
      );
      if (simulate) stageActions.appendChild(simulate);
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
  function standingsTable(teams, promotionByTeam = new Map()) {
    const rows = teams.map((t, i) =>
      el('tr', { class: promotionByTeam.get(t.id)?.className || '' }, [
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

  function promotionRulesFor(group) {
    try {
      const rules = group?.promotionRules;
      return Array.isArray(rules) ? rules : JSON.parse(rules || '[]');
    } catch {
      return [];
    }
  }

  function promotionInfo(stage, groups, stageNameById) {
    const targetIds = [];
    const promotionByTeam = new Map();
    let hasRankingPool = false;

    groups.forEach((group) => {
      const configured = stage.groups?.find((item) => item.id === group.groupId);
      promotionRulesFor(configured).forEach((rule) => {
        const from = Math.max(1, Number(rule.from) || 1);
        const to = Math.min(group.order.length, Number(rule.to) || 0);
        if (rule.rank) {
          hasRankingPool = true;
          for (let position = from; position <= to; position += 1) {
            const teamId = group.order[position - 1];
            if (teamId && !promotionByTeam.has(teamId)) {
              promotionByTeam.set(teamId, { className: 'promotion-row--ranking' });
            }
          }
          return;
        }
        if (!rule.stage) return;
        if (!targetIds.includes(rule.stage)) targetIds.push(rule.stage);
        const targetClass = `promotion-row--target-${targetIds.indexOf(rule.stage) % 4}`;
        for (let position = from; position <= to; position += 1) {
          const teamId = group.order[position - 1];
          if (teamId && !promotionByTeam.has(teamId)) {
            promotionByTeam.set(teamId, { className: targetClass });
          }
        }
      });
    });

    const legend = [];
    targetIds.forEach((targetId, index) => {
      legend.push(el('li', {}, [
        el('span', { class: `promotion-key promotion-key--target-${index % 4}`, 'aria-hidden': 'true' }),
        el('span', { text: `Promoted to ${stageNameById.get(targetId) || 'next stage'}` }),
      ]));
    });
    if (hasRankingPool) {
      legend.push(el('li', {}, [
        el('span', { class: 'promotion-key promotion-key--ranking', 'aria-hidden': 'true' }),
        el('span', { text: 'Ranking pool candidates' }),
      ]));
    }

    return { promotionByTeam, legend };
  }

  function rankingPoolView(stage, groups, teamById, stageNameById) {
    const candidates = [];
    const seen = new Set();
    groups.forEach((group) => {
      const configured = stage.groups?.find((item) => item.id === group.groupId);
      let rules = [];
      try {
        const parsed = configured?.promotionRules;
        rules = Array.isArray(parsed) ? parsed : JSON.parse(parsed || '[]');
      } catch {
        rules = [];
      }
      rules.filter((rule) => rule?.rank && rule.stage).forEach((rule) => {
        const from = Math.max(1, Number(rule.from) || 1);
        const to = Math.min(group.order.length, Number(rule.to) || 0);
        for (let position = from; position <= to; position += 1) {
          const participantTeamId = group.order[position - 1];
          if (!participantTeamId || seen.has(participantTeamId)) continue;
          const team = teamById.get(participantTeamId);
          if (!team) continue;
          seen.add(participantTeamId);
          candidates.push({
            team,
            groupName: configured?.name || 'Group',
            groupRank: position,
            target: stageNameById.get(rule.stage) || 'Next stage',
          });
        }
      });
    });
    if (!candidates.length) return null;

    candidates.sort((a, b) => {
      const statsA = a.team.stats || {};
      const statsB = b.team.stats || {};
      return (statsB.points ?? 0) - (statsA.points ?? 0)
        || ((statsB.goalsFor ?? 0) - (statsB.goalsAgainst ?? 0)) - ((statsA.goalsFor ?? 0) - (statsA.goalsAgainst ?? 0))
        || (statsB.goalsFor ?? 0) - (statsA.goalsFor ?? 0)
        || a.team.id.localeCompare(b.team.id);
    });
    const quota = Number(stage.settings?.advancingTeamsFromRanking) || 0;
    const rows = candidates.map((candidate, index) => el('li', {
      class: `ranking-pool__row${index < quota ? ' ranking-pool__row--qualifying' : ''}`,
    }, [
      el('span', { text: `${index + 1}. ${candidate.team.team?.name || candidate.team.nickname || 'TBD'}` }),
      el('span', { class: 'ranking-pool__meta', text: `${candidate.groupName} · ${candidate.groupRank}${candidate.groupRank === 1 ? 'st' : candidate.groupRank === 2 ? 'nd' : candidate.groupRank === 3 ? 'rd' : 'th'} · ${candidate.target}` }),
      el('strong', { text: `${candidate.team.stats?.points ?? 0} pts` }),
    ]));
    return el('section', { class: 'ranking-pool' }, [
      el('div', { class: 'simulation-section-heading' }, [
        el('h3', { text: 'Ranking pool' }),
        el('span', { class: 'field__hint', text: quota ? `Top ${Math.min(quota, candidates.length)} qualify` : 'Configured candidates' }),
      ]),
      el('p', { class: 'field__hint', text: 'Current cross-group order. Final qualification is decided when all group matches are finished.' }),
      el('ol', { class: 'ranking-pool__list' }, rows),
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
    const { promotionByTeam, legend } = promotionInfo(stage, groups, state.stageNameById);

    const pool = rankingPoolView(stage, groups, teamById, state.stageNameById);
    if (pool) container.appendChild(pool);
    if (legend.length) {
      container.appendChild(el('div', { class: 'promotion-legend' }, [
        el('strong', { text: 'Promotion key' }),
        el('ul', {}, legend),
      ]));
    }

    groups.forEach((group) => {
      // Missing ids (e.g. a team fetched after the standings response
      // was generated) are dropped rather than shown as broken rows —
      // order is preserved for everything we *can* resolve.
      const teams = (group.order || []).map((id) => teamById.get(id)).filter(Boolean);
      const groupPromotions = new Map(
        teams.map((team) => [team.id, promotionByTeam.get(team.id)]).filter(([, info]) => info)
      );
      const block = el('div', { class: 'group-block' }, [
        el('div', { class: 'simulation-section-heading' }, [
          el('h3', { text: stageGroupNames.get(group.groupId) || 'Group' }),
          simulationButton(
            'Simulate group',
            () => Api.simulation.group(group.groupId),
            (() => {
              const groupMatches = state.matches.filter((match) => match.groupId === group.groupId);
              return groupMatches.length > 0 && groupMatches.every((match) => match.status === 'finished');
            })()
          ),
        ]),
        teams.length ? standingsTable(teams, groupPromotions) : el('p', { class: 'empty-state', text: 'No teams assigned to this group yet.' }),
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

  function groupMatchesByMatchday(matches) {
    const groups = new Map();
    matches.forEach((match) => {
      if (!groups.has(match.matchday)) groups.set(match.matchday, []);
      groups.get(match.matchday).push(match);
    });
    return [...groups.entries()].sort((a, b) => Number(a[0]) - Number(b[0]));
  }

  function bracketTieCard(tieMatches, state) {
    const first = tieMatches[0];
    const teamIds = [first.homeParticipantTeamId, first.awayParticipantTeamId];
    const home = state.teamNameById.get(teamIds[0]) || 'TBD';
    const away = state.teamNameById.get(teamIds[1]) || 'TBD';
    const totals = new Map(teamIds.map((teamId) => [teamId, { goals: 0 }]));

    tieMatches.forEach((match) => {
      const homeTotal = totals.get(match.homeParticipantTeamId);
      const awayTotal = totals.get(match.awayParticipantTeamId);
      if (homeTotal) {
        homeTotal.goals += Number(match.score.home) || 0;
      }
      if (awayTotal) {
        awayTotal.goals += Number(match.score.away) || 0;
      }
    });

    const homeTotal = totals.get(teamIds[0]);
    const awayTotal = totals.get(teamIds[1]);
    const decider = tieMatches[tieMatches.length - 1];
    const deciderHomeIsFirst = decider.homeParticipantTeamId === teamIds[0];
    const deciderExtraTimeHome = Number(decider.score.extraTimeHome) || 0;
    const deciderExtraTimeAway = Number(decider.score.extraTimeAway) || 0;
    const homeExtraTime = deciderHomeIsFirst ? deciderExtraTimeHome : deciderExtraTimeAway;
    const awayExtraTime = deciderHomeIsFirst ? deciderExtraTimeAway : deciderExtraTimeHome;
    const homeAggregate = homeTotal.goals;
    const awayAggregate = awayTotal.goals;
    const winnerId = homeAggregate !== awayAggregate
      ? (homeAggregate > awayAggregate ? teamIds[0] : teamIds[1])
      : homeExtraTime !== awayExtraTime
        ? (homeExtraTime > awayExtraTime ? teamIds[0] : teamIds[1])
        : decider.score.penaltiesHome != null && decider.score.penaltiesAway != null &&
            decider.score.penaltiesHome !== decider.score.penaltiesAway
          ? (deciderHomeIsFirst
            ? (decider.score.penaltiesHome > decider.score.penaltiesAway ? teamIds[0] : teamIds[1])
            : (decider.score.penaltiesAway > decider.score.penaltiesHome ? teamIds[0] : teamIds[1]))
        : null;
    const winnerClass = (teamId) => teamId === winnerId ? ' bracket-match__team--winner' : '';
    const legRows = tieMatches.map((match, index) => el('li', { class: 'bracket-tie__leg' }, [
      el('span', { text: `Leg ${index + 1}` }),
      el('span', { text: `${state.teamNameById.get(match.homeParticipantTeamId) || 'TBD'} ${match.score.home ?? '–'}–${match.score.away ?? '–'} ${state.teamNameById.get(match.awayParticipantTeamId) || 'TBD'}` }),
      statusPill(match.status),
    ]));

    return el('div', { class: 'bracket-match bracket-match--tie' }, [
      el('div', { class: 'bracket-match__tie-label', text: `${tieMatches.length}-match pairing` }),
      el('div', { class: `bracket-match__team${winnerClass(teamIds[0])}` }, [
        el('span', { text: home }),
        el('span', { class: 'bracket-match__aggregate', text: `${homeAggregate}${homeExtraTime ? ` +${homeExtraTime} ET` : ''}${decider.score.penaltiesHome != null ? ` (${deciderHomeIsFirst ? decider.score.penaltiesHome : decider.score.penaltiesAway}p)` : ''}` }),
      ]),
      el('div', { class: `bracket-match__team${winnerClass(teamIds[1])}` }, [
        el('span', { text: away }),
        el('span', { class: 'bracket-match__aggregate', text: `${awayAggregate}${awayExtraTime ? ` +${awayExtraTime} ET` : ''}${decider.score.penaltiesAway != null ? ` (${deciderHomeIsFirst ? decider.score.penaltiesAway : decider.score.penaltiesHome}p)` : ''}` }),
      ]),
      el('div', { class: 'bracket-tie__details' }, [
        el('span', { class: 'bracket-tie__aggregate-label', text: winnerId ? 'Aggregate winner' : 'Aggregate tie' }),
        el('ul', { class: 'bracket-tie__legs' }, legRows),
      ]),
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
      const ties = groupMatchesByMatchday(roundMatches);
      return el('div', { class: 'bracket-round' }, [
        el('div', { class: 'simulation-section-heading' }, [
          el('div', { class: 'bracket-round__title', text: round.name }),
          simulationButton(
            'Simulate round',
            () => Api.simulation.round(round.id),
            roundMatches.length > 0 && roundMatches.every((match) => match.status === 'finished')
          ),
        ]),
        ...(roundMatches.length
          ? ties.map(([, tieMatches]) => tieMatches.length > 1
            ? bracketTieCard(tieMatches, state)
            : bracketMatchCard(tieMatches[0], state))
          : [el('p', { class: 'empty-state', text: 'No matches yet.' })]),
      ]);
    });
    container.appendChild(el('div', { class: 'bracket' }, columns));
  }

  // ---------------------------------------------------------------
  // View: registered teams and tournament rosters.
  // Catalog records are reusable; only moderators can attach them to
  // this tournament, while admins can also create new catalog records.
  // ---------------------------------------------------------------
  async function loadCatalog(state) {
    if (!state.catalog.teams) state.catalog.teams = Api.teams.list().then((d) => d?.teams || []);
    if (!state.catalog.players) state.catalog.players = Api.players.list().then((d) => d?.players || []);
    return Promise.all([state.catalog.teams, state.catalog.players]);
  }

  async function loadRoster(state, participantTeamId) {
    if (state.rosters.has(participantTeamId)) return state.rosters.get(participantTeamId);
    const promise = Api.participantPlayers
      .list(state.tournamentId, participantTeamId)
      .then((d) => d?.participantPlayers || [])
      .catch(() => []);
    state.rosters.set(participantTeamId, promise);
    return promise;
  }

  function catalogField(label, type, name, placeholder, required = false, extra = {}) {
    return el('div', { class: 'field' }, [
      el('label', { text: label }),
      el('input', {
        type,
        name,
        placeholder: placeholder || '',
        ...(required ? { required: 'required' } : {}),
        ...extra,
      }),
    ]);
  }

  function adminCatalogForms(container, state) {
    if (Session.getUser()?.role !== 'admin') return;
    const teamForm = el('form', { class: 'management-form' }, [
      el('h3', { text: 'Create catalog team' }),
      el('div', { class: 'management-form-grid' }, [
        catalogField('Name', 'text', 'name', 'Team name', true),
        catalogField('Slug', 'text', 'slug', 'Auto-generated if empty'),
        catalogField('Short name', 'text', 'shortName', 'Optional'),
        catalogField('Primary color', 'color', 'primaryColor', ''),
        catalogField('Secondary color', 'color', 'secondaryColor', ''),
        catalogField('City', 'text', 'city', 'Optional'),
        catalogField('Country', 'text', 'country', 'Optional'),
        catalogField('Founded year', 'number', 'foundedYear', 'YYYY', false, { min: 1800, max: 2100 }),
      ]),
      el('button', { class: 'btn btn--primary', type: 'submit', text: 'Create team' }),
    ]);
    const playerForm = el('form', { class: 'management-form' }, [
      el('h3', { text: 'Create catalog player' }),
      el('div', { class: 'management-form-grid' }, [
        catalogField('Name', 'text', 'name', 'Player name', true),
        catalogField('Slug', 'text', 'slug', 'Auto-generated if empty'),
        catalogField('Nickname', 'text', 'nickname', 'Optional'),
        catalogField('Date of birth', 'date', 'dateOfBirth', ''),
        catalogField('Nationality', 'text', 'nationality', 'Optional'),
        catalogField('Position', 'text', 'position', 'Optional'),
        catalogField('Preferred foot', 'text', 'preferredFoot', 'Left, right, both…'),
        catalogField('Height (cm)', 'number', 'heightCm', 'Optional', false, { min: 1, max: 300 }),
      ]),
      el('button', { class: 'btn btn--primary', type: 'submit', text: 'Create player' }),
    ]);
    teamForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const data = Object.fromEntries(new FormData(teamForm));
      try {
        await Api.teams.create(data);
        teamForm.reset();
        state.catalog.teams = null;
        renderTeamsView(container, state);
      } catch (err) { showBanner(banner, friendlyErrorMessage(err)); }
    });
    playerForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const data = Object.fromEntries(new FormData(playerForm));
      try {
        await Api.players.create(data);
        playerForm.reset();
        state.catalog.players = null;
        renderTeamsView(container, state);
      } catch (err) { showBanner(banner, friendlyErrorMessage(err)); }
    });
    container.appendChild(el('div', { class: 'management-forms' }, [teamForm, playerForm]));
  }

  function teamRegistrationForm(container, state, catalogTeams) {

    const canManageTeams = state.viewerRole === 'moderator';
    const canAutoFillTeams = isAdmin();
    if (!canManageTeams && !canAutoFillTeams) return;
    const available = catalogTeams.filter((team) => !state.participantTeams.some((pt) => pt.teamId === team.id));
    const forms = [];
    if (canManageTeams && available.length) {
      const select = el('select', { name: 'teamId', required: 'required', 'aria-label': 'Catalog team' },
        available.map((team) => el('option', { value: team.id, text: team.name })));
      const seed = el('input', { type: 'number', name: 'seed', min: 1, placeholder: 'Seed (optional)' });
      const nickname = el('input', { type: 'text', name: 'nickname', maxlength: 80, placeholder: 'Tournament nickname (optional)' });
      const form = el('form', { class: 'inline-form registration-form' }, [
        select, seed, nickname,
        el('button', { class: 'btn btn--primary', type: 'submit', text: 'Register team' }),
      ]);
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        try {
          const data = await Api.participantTeams.add(state.tournamentId, {
            teamId: select.value,
            seed: seed.value ? Number(seed.value) : undefined,
            nickname: nickname.value.trim() || undefined,
          });
          state.participantTeams.push(data.participantTeam);
          renderTeamsView(container, state);
        } catch (err) { showBanner(banner, friendlyErrorMessage(err)); }
      });
      forms.push(form);
    }
    if (canAutoFillTeams) {
      const autoForm = el('form', { class: 'inline-form registration-form' }, [
        el('button', { class: 'btn btn--secondary', type: 'submit', text: 'Add missing teams automatically' }),
      ]);
      autoForm.addEventListener('submit', async (event) => {
        event.preventDefault();
        try {
          const data = await Api.participantTeams.autoAdd(state.tournamentId, {});
          state.participantTeams = data.participantTeams || [];
          state.rosters.clear();
          renderTeamsView(container, state);
        } catch (err) { showBanner(banner, friendlyErrorMessage(err)); }
      });
      forms.push(autoForm);
    }
    container.appendChild(el('div', { class: 'management-toolbar' }, [
      el('div', {}, [
        el('h3', { text: 'Register tournament teams' }),
        el('p', { class: 'field__hint', text: 'The tournament team limit is used automatically. Existing catalog teams are reused before placeholders are created.' }),
      ]),
      el('div', { class: 'management-forms management-forms--compact' }, forms),
    ]));
  }

  function catalogDirectory(container, catalogTeams, catalogPlayers) {
    const teamItems = catalogTeams.length
      ? catalogTeams.map((team) => el('li', { text: [team.name, team.shortName].filter(Boolean).join(' · ') }))
      : [el('li', { class: 'empty-state', text: 'No catalog teams available.' })];
    const playerItems = catalogPlayers.length
      ? catalogPlayers.map((player) => el('li', { text: [player.name, player.position, player.nationality].filter(Boolean).join(' · ') }))
      : [el('li', { class: 'empty-state', text: 'No catalog players available.' })];
    container.appendChild(el('div', { class: 'catalog-directory' }, [
      el('div', {}, [el('h3', { text: 'Available teams' }), el('ul', { class: 'catalog-list' }, teamItems)]),
      el('div', {}, [el('h3', { text: 'Available players' }), el('ul', { class: 'catalog-list' }, playerItems)]),
    ]));
  }

  function rosterCard(container, state, participantTeam, players, catalogPlayers, assignedPlayerIds) {
    const teamName = participantTeam.team?.name || participantTeam.nickname || 'Unnamed team';
    const children = [el('h3', { text: teamName })];
    const list = el('ul', { class: 'roster-list' });
    if (!players.length) list.appendChild(el('li', { class: 'empty-state', text: 'No players assigned yet.' }));
    players.forEach((pp) => {
      const eventTotals = [
        ['G', pp.goals],
        ['A', pp.assists],
        ['YC', pp.yellowCards],
        ['RC', pp.redCards],
      ]
        .filter(([, value]) => Number(value) > 0)
        .map(([label, value]) => `${label} ${value}`);
      list.appendChild(el('li', {}, [
        el('span', { text: `${pp.player?.name || 'Unknown player'}${pp.shirtNumber != null ? ` · #${pp.shirtNumber}` : ''}` }),
        el('span', {
          class: 'roster-list__meta',
          text: [pp.role || 'player', ...eventTotals].join(' · '),
        }),
      ]));
    });
    children.push(list);
    if (state.viewerRole === 'moderator') {
      const currentTeamPlayers = new Set(players.map((pp) => pp.playerId));
      const available = catalogPlayers.filter((p) =>
        !assignedPlayerIds.has(p.id) || currentTeamPlayers.has(p.id)
      );
      if (available.length) {
        const select = el('select', { required: 'required', 'aria-label': `Player for ${teamName}` },
          available.map((p) => el('option', { value: p.id, text: p.name })));
        const shirtNumber = el('input', { type: 'number', name: 'shirtNumber', min: 1, max: 99, placeholder: 'Shirt #' });
        const role = el('select', { name: 'role', 'aria-label': `Role for ${teamName}` }, [
          el('option', { value: 'player', text: 'Player' }),
          el('option', { value: 'captain', text: 'Captain' }),
          el('option', { value: 'goalkeeper', text: 'Goalkeeper' }),
        ]);
        const status = el('select', { name: 'status', 'aria-label': `Status for ${teamName}` }, [
          el('option', { value: 'active', text: 'Active' }),
          el('option', { value: 'injured', text: 'Injured' }),
          el('option', { value: 'suspended', text: 'Suspended' }),
          el('option', { value: 'ineligible', text: 'Ineligible' }),
        ]);
        const form = el('form', { class: 'inline-form registration-form' }, [
          select, shirtNumber, role, status,
          el('button', { class: 'btn btn--ghost', type: 'submit', text: 'Register player' }),
        ]);
        form.addEventListener('submit', async (event) => {
          event.preventDefault();
          try {
            await Api.participantPlayers.add(state.tournamentId, participantTeam.id, {
              playerId: select.value,
              shirtNumber: shirtNumber.value ? Number(shirtNumber.value) : undefined,
              role: role.value,
              status: status.value,
            });
            state.rosters.delete(participantTeam.id);
            renderTeamsView(container, state);
          } catch (err) { showBanner(banner, friendlyErrorMessage(err)); }
        });
        children.push(form);
      }
    }
    if (isAdmin()) {
      const autoForm = el('form', { class: 'inline-form registration-form registration-form--auto' }, [
        el('input', { type: 'number', name: 'count', min: 0, value: '11', 'aria-label': `Players for ${teamName}` }),
        el('button', { class: 'btn btn--secondary', type: 'submit', text: 'Add missing players automatically' }),
      ]);
      autoForm.addEventListener('submit', async (event) => {
        event.preventDefault();
        try {
          await Api.participantPlayers.autoAdd(state.tournamentId, participantTeam.id, {
            count: Number(autoForm.elements.count.value),
          });
          state.rosters.delete(participantTeam.id);
          renderTeamsView(container, state);
        } catch (err) { showBanner(banner, friendlyErrorMessage(err)); }
      });
      children.push(autoForm);
    }
    return el('article', { class: 'participant-team-card' }, children);
  }

  async function renderTeamsView(container, state) {
    const scrollTop = window.scrollY;
    clear(container);
    container.appendChild(el('p', { class: 'empty-state', text: 'Loading teams and players…' }));
    let catalogTeams, catalogPlayers;
    try {
      [catalogTeams, catalogPlayers] = await loadCatalog(state);
    } catch (err) {
      clear(container);
      container.appendChild(el('p', { class: 'empty-state', text: friendlyErrorMessage(err) }));
      return;
    }
    clear(container);
    catalogDirectory(container, catalogTeams, catalogPlayers);
    adminCatalogForms(container, state);
    teamRegistrationForm(container, state, catalogTeams);
    if (!state.participantTeams.length) {
      container.appendChild(el('p', { class: 'empty-state', text: 'No teams registered yet.' }));
      return;
    }
    const grid = el('div', { class: 'participant-teams-grid' });
    container.appendChild(grid);
    const rosters = await Promise.all(
      state.participantTeams.map(async (pt) => [pt, await loadRoster(state, pt.id)])
    );
    const assignedPlayerIds = new Set(
      rosters.flatMap(([, players]) => players.map((player) => player.playerId))
    );
    const cards = rosters.map(([pt, players]) =>
      rosterCard(container, state, pt, players, catalogPlayers, assignedPlayerIds)
    );
    cards.forEach((card) => grid.appendChild(card));
    requestAnimationFrame(() => window.scrollTo({ top: scrollTop, behavior: 'auto' }));
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
            yellowCards: pp.yellowCards || 0,
            redCards: pp.redCards || 0,
          });
        });
      });

      const data = {
        scorers: players.filter((p) => p.goals > 0).sort((a, b) => b.goals - a.goals || b.assists - a.assists).slice(0, 10),
        assisters: players.filter((p) => p.assists > 0).sort((a, b) => b.assists - a.assists || b.goals - a.goals).slice(0, 10),
        yellowCards: players.filter((p) => p.yellowCards > 0)
          .sort((a, b) => b.yellowCards - a.yellowCards || b.redCards - a.redCards).slice(0, 10),
        redCards: players.filter((p) => p.redCards > 0)
          .sort((a, b) => b.redCards - a.redCards || b.yellowCards - a.yellowCards).slice(0, 10),
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
        el('div', {}, [el('h3', { text: 'Yellow cards' }), leaderboardList(data.yellowCards, 'yellowCards')]),
        el('div', {}, [el('h3', { text: 'Red cards' }), leaderboardList(data.redCards, 'redCards')]),
      ])
    );
  }

  init();
})();
