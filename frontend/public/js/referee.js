(() => {
  const params = new URLSearchParams(location.search);
  const tournamentId = params.get('tournamentId');
  const matchId = params.get('matchId');
  const root = document.getElementById('referee-app');
  const banner = document.getElementById('banner');
  let state = null;
  let timer = null;
  let pendingAssist = null;
  const isAdministrator = () => String(Session.getUser()?.role || '').toLowerCase() === 'admin';

  if (!Session.isAuthenticated() || !tournamentId || !matchId) {
    location.href = `/login?next=${encodeURIComponent(location.pathname + location.search)}`;
    return;
  }

  const notify = (message, kind = 'error') => UI.showBanner(banner, message, kind);
  const call = async (action) => {
    try { await action(); await load(); }
    catch (error) { notify(UI.friendlyErrorMessage(error)); }
  };

  function timestampMilliseconds(value) {
    if (!value) return NaN;
    const text = String(value);
    return Date.parse(/[zZ]|[+-]\d{2}:?\d{2}$/.test(text) ? text : `${text.replace(' ', 'T')}Z`);
  }

  function elapsedSeconds(match) {
    if (!match.phaseStartedAt || !['live', 'paused'].includes(match.status)) return 0;
    const start = timestampMilliseconds(match.phaseStartedAt);
    if (!Number.isFinite(start)) return Number(match.phaseElapsedSeconds || 0);
    const seconds = Number(match.phaseElapsedSeconds || 0) +
      (match.status === 'live' ? Math.max(0, Math.floor((Date.now() - start) / 1000)) : 0);
    return seconds;
  }

  function formatClock(seconds) {
    return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
  }

  function timerLabel(match) {
    const elapsed = elapsedSeconds(match);
    const duration = Number(match.durationMinutes);
    return Number.isFinite(duration) && duration > 0
      ? `${formatClock(elapsed)} / ${formatClock(duration * 60)}`
      : formatClock(elapsed);
  }

  function eventMinute(event) {
    if (event.minute != null) return `${event.minute}'`;
    if (event.payload?.minute != null) return `${event.payload.minute}'`;
    return '—';
  }

  function eventIcon(event) {
    if (event.type === 'goal') return event.payload?.ownGoal ? 'OG' : '⚽';
    if (event.type === 'card') return event.card === 'red' ? '🟥' : '🟨';
    if (event.type === 'shootout_attempt') return event.scored ? '✓' : '×';
    if (event.type === 'phase') return event.payload?.action === 'pause' ? 'Ⅱ' : '▶';
    return '•';
  }

  function eventTitle(event) {
    if (event.type === 'goal') return event.payload?.ownGoal ? 'Own goal' : 'Goal';
    if (event.type === 'card') return `${event.card === 'red' ? 'Red' : 'Yellow'} card`;
    if (event.type === 'shootout_attempt') return event.scored ? 'Penalty scored' : 'Penalty missed';
    return event.payload?.action || 'Match update';
  }

  function renderEventTimeline(events, match, homeSquad, awaySquad) {
    const timeline = UI.el('section', { class: 'referee-timeline' }, [
      UI.el('div', { class: 'referee-timeline__heading' }, [
        UI.el('h2', { text: 'Match timeline' }),
        UI.el('span', { class: 'field__hint', text: 'Chronological match events' }),
      ]),
    ]);
    let lastPhase = null;
    const timelineEvents = events.reduce((visibleEvents, event) => {
      if (event.type === 'assist') {
        if (!event.payload?.skipped) {
          const goal = [...visibleEvents].reverse().find((candidate) =>
            candidate.type === 'goal' &&
            candidate.phase === event.phase &&
            candidate.team_id === event.team_id &&
            !candidate.assisterName
          );
          if (goal) goal.assisterName = event.playerName || event.assisterName;
        }
        return visibleEvents;
      }
      visibleEvents.push({ ...event });
      return visibleEvents;
    }, []);

    timelineEvents.forEach((event) => {
      if (event.phase !== lastPhase) {
        lastPhase = event.phase;
        timeline.appendChild(UI.el('div', { class: 'referee-timeline__period' }, [
          UI.el('strong', { text: event.phase === 'regulation' ? 'Regulation' : event.phase === 'extra_time' ? 'Extra time' : event.phase === 'shootout' ? 'Penalty shootout' : 'Match' }),
          UI.el('span', { text: event.phase === match.phase ? 'Current phase' : '' }),
        ]));
      }
      const isPhase = event.type === 'phase';
      const eventTeamIsHome = event.team_id === match.homeParticipantTeamId;
      const isHome = event.payload?.ownGoal ? !eventTeamIsHome : eventTeamIsHome;
      const squad = eventTeamIsHome ? homeSquad : awaySquad;
      const benefitingTeamName = event.payload?.ownGoal
        ? (eventTeamIsHome ? state.awayTeam?.team?.name : state.homeTeam?.team?.name)
        : event.teamName;
      const participantPlayer = squad.find((entry) =>
        entry.id === event.player_id || entry.player?.id === event.player_id
      );
      const playerName = event.playerName || participantPlayer?.player?.name || null;
      const scorerLabel = playerName
        ? `${playerName}${event.assisterName ? ` (${event.assisterName})` : ''}`
        : null;
      const details = [
        UI.el('strong', { text: scorerLabel || event.teamName || eventTitle(event) }),
        playerName && benefitingTeamName ? UI.el('span', { class: 'referee-timeline__team', text: benefitingTeamName }) : null,
      ];
      const row = UI.el('div', { class: `referee-timeline__row ${isPhase ? 'referee-timeline__row--phase' : isHome ? 'referee-timeline__row--home' : 'referee-timeline__row--away'}` }, [
        UI.el('time', { class: 'referee-timeline__minute', text: eventMinute(event) }),
        UI.el('div', { class: 'referee-timeline__event' }, [
          UI.el('span', { class: `referee-timeline__icon referee-timeline__icon--${event.type}`, text: eventIcon(event) }),
          UI.el('div', { class: 'referee-timeline__details' }, details),
          UI.el('span', { class: 'referee-timeline__kind', text: eventTitle(event) }),
        ]),
      ]);
      timeline.appendChild(row);
    });
    if (!events.length) timeline.appendChild(UI.el('p', { class: 'field__hint referee-timeline__empty', text: 'No match events recorded yet.' }));
    return timeline;
  }

  function playerRoster(players, label, onSelect, allowSkip = false, unavailablePlayers = new Set()) {
    const list = UI.el('div', { class: 'referee-player-roster', role: 'list', 'aria-label': label });
    players.forEach((player) => {
      const unavailable = unavailablePlayers.has(player.id);
      const button = UI.el('button', {
        class: `referee-player-card${unavailable ? ' referee-player-card--unavailable' : ''}`,
        type: 'button',
        role: 'listitem',
        text: unavailable ? `${player.player?.name || 'Unknown player'} — sent off` : player.player?.name || 'Unknown player',
        disabled: unavailable,
      });
      button.addEventListener('click', () => {
        list.querySelectorAll('.referee-player-card').forEach((item) => item.classList.remove('is-selected'));
        button.classList.add('is-selected');
        onSelect(player.id);
      });
      list.appendChild(button);
    });
    if (allowSkip) {
      const skip = UI.el('button', { class: 'referee-player-card referee-player-card--skip', type: 'button', text: 'No scorer / own goal' });
      skip.addEventListener('click', () => {
        list.querySelectorAll('.referee-player-card').forEach((item) => item.classList.remove('is-selected'));
        skip.classList.add('is-selected');
        onSelect(null);
      });
      list.appendChild(skip);
    }
    return list;
  }

  function render() {
    const { match, events } = state;
    UI.clear(root);
    const home = state.homeSquad || [];
    const away = state.awaySquad || [];
    const sentOffPlayers = new Set(events
      .filter((event) => event.type === 'card' && event.card === 'red' && event.player_id)
      .map((event) => event.player_id));
    const timerNode = UI.el('strong', { class: 'referee-timer', text: timerLabel(match) });
    root.appendChild(UI.el('div', { class: 'referee-head' }, [
      UI.el('p', { class: 'eyebrow', text: 'Referee control' }),
      UI.el('div', { class: 'referee-scoreboard' }, [
        UI.el('div', { class: 'referee-scoreboard__team referee-scoreboard__team--home' }, [
          UI.el('span', { class: 'referee-scoreboard__name', text: state.homeTeam?.team?.name || state.homeTeam?.nickname || 'Home' }),
          UI.el('strong', { class: 'referee-scoreboard__score', text: String(match.score.home ?? 0) }),
        ]),
        UI.el('span', { class: 'referee-scoreboard__separator', text: '–' }),
        UI.el('div', { class: 'referee-scoreboard__team referee-scoreboard__team--away' }, [
          UI.el('strong', { class: 'referee-scoreboard__score', text: String(match.score.away ?? 0) }),
          UI.el('span', { class: 'referee-scoreboard__name', text: state.awayTeam?.team?.name || state.awayTeam?.nickname || 'Away' }),
        ]),
      ]),
      timerNode,
      UI.el('p', { class: 'field__hint', text: `${match.phase} · ${match.status} · ${events.length} recorded events` }),
    ]));

    const controls = UI.el('div', { class: 'referee-controls' });
    const administratorActiveLock = isAdministrator() && ['live', 'paused'].includes(match.status);
    if (administratorActiveLock) {
      controls.appendChild(UI.el('p', {
        class: 'field__hint',
        text: 'Live match is controlled by the assigned referee. Administrator changes are available after the match is finished.',
      }));
    }
    if (match.status === 'scheduled') {
      const duration = UI.el('input', { class: 'referee-control__input', type: 'number', min: 1, value: match.durationMinutes || 90, placeholder: 'Minutes' });
      const start = UI.el('button', { class: 'btn btn--primary', type: 'button', text: 'Start match' });
      start.addEventListener('click', () => call(() => Api.referee.start(tournamentId, matchId, { durationMinutes: Number(duration.value) })));
      controls.append(UI.el('label', { class: 'referee-control' }, [UI.el('span', { text: 'Match duration' }), duration]), start);
    }
    if (match.status === 'live') {
      const pause = UI.el('button', { class: 'btn btn--ghost', type: 'button', text: 'Pause' });
      pause.addEventListener('click', () => call(() => Api.referee.transition(tournamentId, matchId, 'pause', match.revision)));
      controls.appendChild(pause);
    }
    if (match.status === 'paused') {
      const resume = UI.el('button', { class: 'btn btn--primary', type: 'button', text: 'Resume' });
      resume.addEventListener('click', () => call(() => Api.referee.transition(tournamentId, matchId, 'resume', match.revision)));
      controls.appendChild(resume);
    }
    if ((['live', 'paused'].includes(match.status) && !isAdministrator()) ||
        (isAdministrator() && match.status === 'scheduled')) {
      const finish = UI.el('button', { class: 'btn btn--primary', type: 'button', text: `End ${match.phase}` });
      finish.addEventListener('click', () => call(() => Api.referee.finishPhase(tournamentId, matchId, match.phase, match.revision)));
      const reason = UI.el('input', { class: 'referee-control__input', placeholder: 'Abandon reason' });
      const abandon = UI.el('button', { class: 'btn btn--danger', type: 'button', text: 'Abandon' });
      abandon.addEventListener('click', () => call(() => Api.referee.abandon(tournamentId, matchId, reason.value)));
      controls.append(finish, reason, abandon);
    }
    root.appendChild(controls);

    if (!administratorActiveLock &&
        (['live', 'paused'].includes(match.status) || (isAdministrator() && ['scheduled', 'finished'].includes(match.status)))) {
      const eventPanel = UI.el('section', { class: 'referee-event-panel referee-event-picker' }, [
        UI.el('h2', { text: 'Record an event' }),
        UI.el('p', { class: 'field__hint', text: 'Choose an event, then select the team and player involved.' }),
      ]);
      const chooser = UI.el('div', { class: 'referee-event-squares' });
      const selection = UI.el('div', { class: 'referee-emitter-selection' });
      const teamName = (teamId) => teamId === match.homeParticipantTeamId
        ? (state.homeTeam?.team?.name || 'Home')
        : (state.awayTeam?.team?.name || 'Away');
      function showEmitter(eventType, options = {}) {
        clear(selection);
        let activeTeam = null;
        let activePlayer = null;
        const teamLists = UI.el('div', { class: 'referee-team-lists' });
        const action = UI.el('button', { class: 'btn btn--primary', type: 'button', text: options.ownGoal ? 'Record own goal' : eventType === 'goal' ? 'Record goal' : `Record ${eventType}` });
        const minute = isAdministrator()
          ? UI.el('input', { class: 'referee-control__input', type: 'number', min: 0, placeholder: 'Minute (optional)' })
          : null;
        const scored = eventType === 'shootout_attempt'
          ? UI.el('label', { class: 'referee-control' }, [
              UI.el('input', { type: 'checkbox', checked: true }),
              UI.el('span', { text: 'Scored' }),
            ])
          : null;
        [match.homeParticipantTeamId, match.awayParticipantTeamId].forEach((teamId) => {
          const teamButton = UI.el('button', {
            class: 'referee-team-list__button',
            type: 'button',
            text: teamName(teamId),
          });
          const players = teamId === match.homeParticipantTeamId ? home : away;
          const playerCards = playerRoster(players, `${teamName(teamId)} players`, (playerId) => {
            activeTeam = teamId;
            activePlayer = playerId;
            teamButton.click();
          }, eventType === 'goal' && !options.ownGoal, sentOffPlayers);
          const teamCard = UI.el('div', { class: 'referee-team-list' }, [teamButton, playerCards]);
          teamButton.addEventListener('click', () => {
            activeTeam = teamId;
            teamLists.querySelectorAll('.referee-team-list__button').forEach((button) => button.classList.remove('is-selected'));
            teamButton.classList.add('is-selected');
          });
          teamLists.appendChild(teamCard);
        });
        action.addEventListener('click', async () => {
          if (!activeTeam || (options.ownGoal && !activePlayer)) {
            return notify(options.ownGoal
              ? 'Select the offending team and the player who committed the own goal.'
              : 'Select a team and player list.');
          }
          const payload = {
            teamId: activeTeam,
            playerId: activePlayer,
            ...(eventType === 'goal' ? { ownGoal: Boolean(options.ownGoal || !activePlayer) } : {}),
            ...(options.card ? { card: options.card } : {}),
            ...(minute && minute.value !== '' ? { minute: Number(minute.value) } : {}),
            ...(scored ? { scored: scored.querySelector('input').checked } : {}),
          };
          try {
            await Api.referee.event(tournamentId, matchId, {
              type: eventType,
              phase: ['regulation', 'extra_time', 'shootout'].includes(match.phase) ? match.phase : 'regulation',
              payload,
              revision: match.revision,
              clientEventId: crypto.randomUUID(),
            });
            pendingAssist = eventType === 'goal' && !payload.ownGoal
              ? { teamId: activeTeam, phase: ['regulation', 'extra_time'].includes(match.phase) ? match.phase : 'regulation' }
              : null;
            await load();
          } catch (error) { notify(UI.friendlyErrorMessage(error)); }
        });
        selection.append(teamLists);
        if (scored)
          selection.append(scored);
        if (minute)
          selection.append(minute);
        selection.append(action);
      }
      const eventChoices = [
        ...(match.phase === 'shootout' ? [['shootout_attempt', '🥅 Shootout attempt', {}]] : [
          ['goal', '⚽ Goal', {}],
          ['goal', '↩ Own goal', { ownGoal: true }],
          ['card', '🟨 Yellow card', { card: 'yellow' }],
          ['card', '🟥 Red card', { card: 'red' }],
        ]),
      ];
      eventChoices.forEach(([type, label, options]) => {
        const cardClass = options.card ? ` referee-event-square--${options.card}` : '';
        const button = UI.el('button', { class: `referee-event-square${cardClass}`, type: 'button', text: label });
        button.addEventListener('click', () => showEmitter(type, options));
        chooser.appendChild(button);
      });
      eventPanel.append(chooser, selection);
      root.appendChild(eventPanel);
    }
    if (pendingAssist && (['regulation', 'extra_time'].includes(match.phase) || isAdministrator())) {
      const players = pendingAssist.teamId === match.homeParticipantTeamId ? home : away;
      let assisterId = null;
      const player = playerRoster(players, 'Choose assister', (playerId) => { assisterId = playerId; }, false, sentOffPlayers);
      const record = UI.el('button', { class: 'btn btn--primary', type: 'button', text: 'Record assist' });
      const skip = UI.el('button', { class: 'btn btn--ghost', type: 'button', text: 'Skip assist' });
      record.addEventListener('click', async () => {
        if (!assisterId) return notify('Select an assister or skip the assist.');
        try {
          await Api.referee.event(tournamentId, matchId, {
            type: 'assist', phase: pendingAssist.phase,
            payload: { teamId: pendingAssist.teamId, playerId: assisterId },
            revision: match.revision,
            clientEventId: crypto.randomUUID(),
          });
          pendingAssist = null;
          await load();
        } catch (error) { notify(UI.friendlyErrorMessage(error)); }
      });
      skip.addEventListener('click', async () => {
        try {
          await Api.referee.event(tournamentId, matchId, {
            type: 'assist',
            phase: pendingAssist.phase,
            payload: { teamId: pendingAssist.teamId, skipped: true },
            revision: match.revision,
            clientEventId: crypto.randomUUID(),
          });
          pendingAssist = null;
          await load();
        } catch (error) { notify(UI.friendlyErrorMessage(error)); }
      });
      root.appendChild(UI.el('section', { class: 'referee-event-panel referee-assist-panel' }, [
        UI.el('h2', { text: 'Assist for the goal (optional)' }), player, record, skip,
      ]));
    }
    root.appendChild(renderEventTimeline(events, match, home, away));
    clearInterval(timer);
    timer = setInterval(() => { if (match.status === 'live') timerNode.textContent = timerLabel(match); }, 1000);
  }

  async function load() {
    state = await Api.referee.detail(tournamentId, matchId);
    render();
  }
  load().catch((error) => notify(UI.friendlyErrorMessage(error)));
})();
