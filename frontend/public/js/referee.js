(() => {
  const params = new URLSearchParams(location.search);
  const tournamentId = params.get('tournamentId');
  const matchId = params.get('matchId');
  const root = document.getElementById('referee-app');
  const banner = document.getElementById('banner');
  let state = null;
  let timer = null;
  let stream = null;
  let streamRetry = null;
  let fallbackRefresh = null;
  let pendingAssist = null;
  const isAdministrator = () => String(Session.getUser()?.role || '').toLowerCase() === 'admin';

  if (!tournamentId || !matchId) {
    location.href = `/login?next=${encodeURIComponent(location.pathname + location.search)}`;
    return;
  }

  const notify = (message, kind = 'error') => UI.flashMessage(message, kind);
  const canOperateMatch = (match) => {
    const user = Session.getUser();
    return String(user?.role || '').toLowerCase() === 'admin'
      || Boolean(user?.id && match?.refereeId === user.id);
  };
  const canEditEvents = (match) =>
    ['live', 'paused', 'finished'].includes(match?.status)
    && (state?.viewerRole === 'moderator'
      || isAdministrator()
      || (canOperateMatch(match) && match?.status === 'live'));
  const canStartMatch = (match) =>
    state?.viewerRole === 'moderator'
    || state?.viewerRole === 'referee'
    || Boolean(Session.getUser()?.id && match?.refereeId === Session.getUser().id);
  const canContinueMatch = () =>
    state?.viewerRole === 'moderator' || isAdministrator();
  const canOperateLiveMatch = (match) =>
    state?.viewerRole === 'moderator'
    || Boolean(Session.getUser()?.id && match?.refereeId === Session.getUser().id);
  const canRecordEvents = (match) =>
    ['live', 'paused', 'finished'].includes(match?.status)
    && (state?.viewerRole === 'moderator'
      || isAdministrator()
      || (canOperateMatch(match) && match?.status === 'live'));
  const backButton = document.getElementById('back-navigation');
  if (backButton) {
    backButton.addEventListener('click', () => {
      let previousUrl = null;
      try {
        const referrer = document.referrer ? new URL(document.referrer) : null;
        if (referrer?.origin === location.origin) {
          previousUrl = referrer;
        }
      } catch {
        previousUrl = null;
      }

      const destination = previousUrl || new URL(
        `/tournament?id=${encodeURIComponent(tournamentId)}`,
        location.origin
      );
      destination.searchParams.set('_refresh', Date.now().toString());
      location.replace(destination.href);
    });
  }
  const applyImpactPrompt = async (result) => {
    if (result?.impact?.resetRequired && isAdministrator()) {
        const redrawStages = result.impact.affectedStages.filter((stage) => stage.action === 'redraw');
        const resetStages = result.impact.affectedStages.filter((stage) => stage.action === 'reset');
        const stages = result.impact.affectedStages
          .filter((stage) => stage.action !== 'none')
          .map((stage) => `${stage.name}: ${stage.action === 'reset' ? 'reset' : 'redraw'} (${stage.matchCount} match${stage.matchCount === 1 ? '' : 'es'})`)
          .join(', ');
        const confirmed = await UI.confirmAction(
          'Downstream stages changed',
          `This correction changes qualification data. ${redrawStages.length ? 'Scheduled next-stage fixtures will be redrawn.' : ''} ${resetStages.length ? 'Stages with started matches will be reset.' : ''}${stages ? ` Affected stages: ${stages}.` : ''}`,
          'Apply stage changes'
        );
        if (confirmed) {
          await Api.referee.applyImpact(
            tournamentId,
            matchId,
            result.match?.revision,
            result.impact.affectedStages.map((stage) => stage.id)
          );
          notify('Promotions and affected next-stage fixtures were updated.', 'success');
        }
    }
  };

  const call = async (action) => {
    try {
      const result = await action();
      await applyImpactPrompt(result);
      await load();
      return result;
    }
    catch (error) { notify(UI.friendlyErrorMessage(error)); }
  };

  function eventDialog(title, {
    reasonRequired = false,
    minute = '',
    includeMinute = true,
    message = '',
    confirmLabel = 'Continue',
    confirmClass = 'btn--primary',
  } = {}) {
    return new Promise((resolve) => {
      const minuteInput = UI.el('input', {
        class: 'referee-dialog__input',
        type: 'number',
        min: 0,
        value: minute,
        placeholder: 'Minute (optional)',
        'aria-label': 'Event minute',
      });
      const reasonInput = reasonRequired ? UI.el('textarea', {
        class: 'referee-dialog__input',
        rows: 3,
        placeholder: 'Reason for correction (required)',
        'aria-label': 'Correction reason',
      }) : null;
      const backdrop = UI.el('div', { class: 'modal-backdrop referee-dialog-backdrop' });
      const finish = (value) => { backdrop.remove(); resolve(value); };
      const form = UI.el('form', { class: 'modal referee-dialog', role: 'dialog', 'aria-modal': 'true' }, [
        UI.el('h2', { text: title }),
        message ? UI.el('p', { class: 'referee-dialog__message', text: message }) : null,
        includeMinute ? UI.el('label', { class: 'referee-dialog__field' }, [UI.el('span', { text: 'Event minute' }), minuteInput]) : null,
        reasonInput ? UI.el('label', { class: 'referee-dialog__field' }, [UI.el('span', { text: 'Correction reason' }), reasonInput]) : null,
        UI.el('div', { class: 'modal__actions' }, [
          UI.el('button', { class: 'btn btn--ghost', type: 'button', text: 'Cancel', onclick: () => finish(null) }),
          UI.el('button', { class: `btn ${confirmClass}`, type: 'submit', text: confirmLabel }),
        ]),
      ]);
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        const reason = reasonInput?.value.trim() || '';
        if (reasonRequired && !reason) {
          reasonInput.focus();
          return;
        }
        finish({ minute: minuteInput.value === '' ? null : Number(minuteInput.value), reason: reason || null });
      });
      backdrop.appendChild(form);
      document.body.appendChild(backdrop);
      minuteInput.focus();
    });
  }

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
    if (event.type === 'card' && event.payload?.automaticSecondYellow) return 'Second yellow — red card';
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
          const goal = event.goal_event_id
            ? visibleEvents.find((candidate) => candidate.id === event.goal_event_id)
            : [...visibleEvents].reverse().find((candidate) =>
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
      if (!isPhase && canEditEvents(match) && !event.payload?.automaticSecondYellow) {
        const actions = UI.el('span', { class: 'referee-timeline__actions' });
        const edit = UI.el('button', {
          class: 'btn btn--ghost btn--small referee-event-action',
          type: 'button',
          text: 'Edit event',
          title: 'Edit event minute',
          'aria-label': 'Edit event minute',
        });
        edit.addEventListener('click', async () => {
          const input = await eventDialog('Edit match event', {
            reasonRequired: match.status === 'finished' && (isAdministrator() || state.viewerRole === 'moderator'),
            minute: event.minute == null ? '' : String(event.minute),
          });
          if (!input) return;
          await call(() => Api.referee.updateEvent(tournamentId, matchId, event.id, {
            changes: { minute: input.minute },
            revision: match.revision,
            reason: input.reason,
          }));
        });
        const remove = UI.el('button', {
          class: 'btn btn--danger btn--small referee-event-action',
          type: 'button',
          text: 'Delete event',
          title: 'Delete event',
          'aria-label': 'Delete event',
        });
        remove.addEventListener('click', async () => {
          const input = await eventDialog('Delete match event', {
            reasonRequired: match.status === 'finished' && (isAdministrator() || state.viewerRole === 'moderator'),
            includeMinute: false,
            message: 'This removes the event and recalculates the match score and player statistics.',
            confirmLabel: 'Delete event',
            confirmClass: 'btn--danger',
          });
          if (!input) return;
          const reason = input.reason;
          await call(() => Api.referee.deleteEvent(tournamentId, matchId, event.id, { revision: match.revision, reason }));
        });
        actions.append(edit, remove);
        row.querySelector('.referee-timeline__event').appendChild(actions);
      }
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
        text: unavailable ? `${player.player?.name || 'Unknown player'} — unavailable` : player.player?.name || 'Unknown player',
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
    const cardCounts = new Map();
    events.filter((event) => event.type === 'card' && event.player_id).forEach((event) => {
      const current = cardCounts.get(event.player_id) || { yellow: 0, red: false };
      if (event.card === 'yellow') current.yellow += 1;
      if (event.card === 'red') current.red = true;
      cardCounts.set(event.player_id, current);
    });
    const unavailablePlayers = new Set([...cardCounts.entries()]
      .filter(([, cards]) => cards.red || cards.yellow >= 2)
      .map(([playerId]) => playerId));
    [...home, ...away].forEach((player) => {
      const suspension = player.suspension;
      if (suspension && (suspension.kind === 'yellow_threshold'
        || (suspension.kind === 'red_card' && suspension.status !== 'included'))) {
        unavailablePlayers.add(player.id);
      }
    });
    const shootoutPlayers = new Set(events
      .filter((event) => event.type === 'shootout_attempt' && event.player_id)
      .map((event) => event.player_id));
    const timerNode = UI.el('strong', { class: 'referee-timer', text: timerLabel(match) });
    root.appendChild(UI.el('div', { class: 'referee-head' }, [
      UI.el('p', { class: 'eyebrow', text: canEditEvents(match) ? 'Match control' : 'Match timeline' }),
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
    if (match.status === 'scheduled' && canStartMatch(match)) {
      const duration = UI.el('input', { class: 'referee-control__input', type: 'number', min: 1, value: match.durationMinutes || 90, placeholder: 'Minutes' });
      const start = UI.el('button', { class: 'btn btn--primary', type: 'button', text: 'Start match' });
      start.addEventListener('click', () => call(() => Api.referee.start(tournamentId, matchId, { durationMinutes: Number(duration.value) })));
      controls.append(UI.el('label', { class: 'referee-control' }, [UI.el('span', { text: 'Match duration' }), duration]), start);
    }
    const pendingRedSuspensions = (state.suspensions || []).filter((item) =>
      item.kind === 'red_card' && item.status === 'pending'
    );

    if (pendingRedSuspensions.length && match.status === 'scheduled' && canStartMatch(match)) {
      const suspensionPanel = UI.el('section', { class: 'referee-suspension-panel' }, [
        UI.el('div', { class: 'referee-suspension-panel__header' }, [
          UI.el('span', { class: 'referee-suspension-panel__icon', text: '!' }),
          UI.el('div', {}, [
            UI.el('h3', { text: 'Red-card availability' }),
            UI.el('p', { class: 'field__hint', text: 'Decision required before kickoff' }),
          ]),
          UI.el('span', { class: 'status-pill status-pill--warning', text: `${pendingRedSuspensions.length} pending` }),
        ]),
        UI.el('p', { class: 'referee-suspension-panel__instruction', text: 'Choose whether each player can be included in this match.' }),
      ]);
      pendingRedSuspensions.forEach((item) => {
        const include = UI.el('button', { class: 'btn btn--primary btn--small', type: 'button', text: 'Include' });
        const exclude = UI.el('button', { class: 'btn btn--danger btn--small', type: 'button', text: 'Exclude' });
        const decide = async (decision) => {
          const confirmed = await UI.confirmAction(
            decision === 'include' ? 'Include player' : 'Exclude player',
            decision === 'include'
              ? `Include ${item.playerName} in this match despite the red-card suspension?`
              : `Exclude ${item.playerName} from this match because of the red-card suspension?`,
            decision === 'include' ? 'Include player' : 'Exclude player'
          );
          if (!confirmed) return;
          include.disabled = true;
          exclude.disabled = true;
          await call(() => Api.matches.decideSuspension(tournamentId, matchId, item.id, decision));
        };
        include.addEventListener('click', () => decide('include'));
        exclude.addEventListener('click', () => decide('exclude'));
        suspensionPanel.appendChild(UI.el('div', { class: 'referee-suspension-row' }, [
          UI.el('div', { class: 'referee-suspension-row__player' }, [
            UI.el('strong', { text: item.playerName }),
            UI.el('span', { class: 'referee-suspension-row__reason', text: 'Red-card suspension' }),
          ]),
          UI.el('div', { class: 'referee-suspension-row__actions' }, [include, exclude]),
        ]));
      });
      controls.appendChild(suspensionPanel);
    }
    if (match.status === 'finished' && canContinueMatch()) {
      const continueButton = UI.el('button', { class: 'btn btn--primary', type: 'button', text: 'Continue match' });
      continueButton.addEventListener('click', async () => {
        if (!await UI.confirmAction(
          'Continue finished match',
          'Reopen this match for correction and further play?',
          'Continue match'
        )) return;
        await call(() => Api.referee.continueFinished(tournamentId, matchId, match.revision));
      });
      controls.append(continueButton);
    }
    if (match.status === 'live' && canOperateLiveMatch(match)) {
      const pause = UI.el('button', { class: 'btn btn--ghost', type: 'button', text: 'Pause' });
      pause.addEventListener('click', () => call(() => Api.referee.transition(tournamentId, matchId, 'pause', match.revision)));
      controls.appendChild(pause);
    }
    if (match.status === 'paused' && canOperateLiveMatch(match)) {
      const resume = UI.el('button', { class: 'btn btn--primary', type: 'button', text: 'Resume' });
      resume.addEventListener('click', () => call(() => Api.referee.transition(tournamentId, matchId, 'resume', match.revision)));
      controls.appendChild(resume);
    }
    if ((['live', 'paused'].includes(match.status) && canOperateLiveMatch(match))
      || (isAdministrator() && match.status === 'scheduled')) {
      const finish = UI.el('button', { class: 'btn btn--primary', type: 'button', text: `End ${match.phase}` });
      finish.addEventListener('click', async () => {
        if (match.phase === 'regulation' && !await UI.confirmAction(
          'End regulation',
          'Are you sure you want to end regulation? The match will move to the next phase or finish according to its rules.',
          'End regulation'
        )) return;
        await call(() => Api.referee.finishPhase(tournamentId, matchId, match.phase, match.revision));
      });
      const reason = UI.el('input', { class: 'referee-control__input', placeholder: 'Abandon reason' });
      const abandon = UI.el('button', { class: 'btn btn--danger', type: 'button', text: 'Abandon' });
      abandon.addEventListener('click', () => call(() => Api.referee.abandon(tournamentId, matchId, reason.value)));
      controls.append(finish, reason, abandon);
    }
    root.appendChild(controls);

    if (canRecordEvents(match)) {
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
        const action = UI.el('button', { class: 'btn btn--primary', type: 'button', text: options.ownGoal ? 'Record own goal' : eventType === 'goal' ? 'Record goal' : eventType === 'shootout_attempt' ? 'Record shootout attempt' : `Record ${eventType}` });
        const minute = isAdministrator()
          ? UI.el('input', { class: 'referee-control__input', type: 'number', min: 0, placeholder: 'Minute (optional)' })
          : null;
        const correctionReason = (isAdministrator() || state.viewerRole === 'moderator') && match.status === 'finished'
          ? UI.el('textarea', { class: 'referee-control__input', rows: 2, placeholder: 'Correction reason (required)' })
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
          const unavailable = new Set(unavailablePlayers);
          if (eventType === 'shootout_attempt') shootoutPlayers.forEach((playerId) => unavailable.add(playerId));
          const playerCards = playerRoster(players, `${teamName(teamId)} players`, (playerId) => {
            activeTeam = teamId;
            activePlayer = playerId;
            teamButton.click();
          }, eventType === 'goal' && !options.ownGoal, unavailable);
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
            ...(correctionReason ? { reason: correctionReason.value.trim() } : {}),
          };
          if (correctionReason && !correctionReason.value.trim()) return notify('A correction reason is required.');
          try {
            const result = await Api.referee.event(tournamentId, matchId, {
              type: eventType,
              phase: ['regulation', 'extra_time', 'shootout'].includes(match.phase) ? match.phase : 'regulation',
              payload,
              revision: match.revision,
              clientEventId: crypto.randomUUID(),
            });
            pendingAssist = eventType === 'goal' && !payload.ownGoal
              ? {
                teamId: activeTeam,
                phase: ['regulation', 'extra_time'].includes(match.phase) ? match.phase : 'regulation',
                goalEventId: result.eventId,
                goalPlayerId: payload.playerId,
              }
              : null;
            await applyImpactPrompt(result);
            await load();
          } catch (error) { notify(UI.friendlyErrorMessage(error)); }
        });
        selection.append(teamLists);
        if (scored)
          selection.append(scored);
        if (minute)
          selection.append(minute);
        if (correctionReason)
          selection.append(correctionReason);
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
      const correctionReason = (isAdministrator() || state.viewerRole === 'moderator') && match.status === 'finished'
        ? UI.el('textarea', { class: 'referee-control__input', rows: 2, placeholder: 'Correction reason (required)' })
        : null;
      const unavailableAssisters = new Set(unavailablePlayers);
      unavailableAssisters.add(pendingAssist.goalPlayerId);
      const player = playerRoster(players, 'Choose assister', (playerId) => { assisterId = playerId; }, false, unavailableAssisters);
      const record = UI.el('button', { class: 'btn btn--primary', type: 'button', text: 'Record assist' });
      const skip = UI.el('button', { class: 'btn btn--ghost', type: 'button', text: 'Skip assist' });
      record.addEventListener('click', async () => {
        if (!assisterId) return notify('Select an assister or skip the assist.');
        if (correctionReason && !correctionReason.value.trim()) return notify('A correction reason is required.');
        try {
          const result = await Api.referee.event(tournamentId, matchId, {
            type: 'assist', phase: pendingAssist.phase,
            payload: {
              teamId: pendingAssist.teamId,
              playerId: assisterId,
              goalEventId: pendingAssist.goalEventId,
              ...(correctionReason ? { reason: correctionReason.value.trim() } : {}),
            },
            revision: match.revision,
            clientEventId: crypto.randomUUID(),
          });
          pendingAssist = null;
          await applyImpactPrompt(result);
          await load();
        } catch (error) { notify(UI.friendlyErrorMessage(error)); }
      });
      skip.addEventListener('click', async () => {
        if (correctionReason && !correctionReason.value.trim()) return notify('A correction reason is required.');
        try {
          const result = await Api.referee.event(tournamentId, matchId, {
            type: 'assist',
            phase: pendingAssist.phase,
            payload: {
              teamId: pendingAssist.teamId,
              skipped: true,
              goalEventId: pendingAssist.goalEventId,
              ...(correctionReason ? { reason: correctionReason.value.trim() } : {}),
            },
            revision: match.revision,
            clientEventId: crypto.randomUUID(),
          });
          pendingAssist = null;
          await applyImpactPrompt(result);
          await load();
        } catch (error) { notify(UI.friendlyErrorMessage(error)); }
      });
      root.appendChild(UI.el('section', { class: 'referee-event-panel referee-assist-panel' }, [
        UI.el('h2', { text: 'Assist for the goal (optional)' }), player, correctionReason, record, skip,
      ]));
    }
    root.appendChild(renderEventTimeline(events, match, home, away));
    clearInterval(timer);
    timer = setInterval(() => { if (match.status === 'live') timerNode.textContent = timerLabel(match); }, 1000);
  }

  async function load() {
    state = await Api.referee.detail(tournamentId, matchId);
    state.viewerRole = null;
    if (Session.isAuthenticated()) {
      try {
        state.viewerRole = (await Api.tournaments.get(tournamentId))?.viewerRole || null;
      } catch (error) {
        if (![401, 403, 404].includes(error.status)) throw error;
      }
    }
    render();
  }

  function stopRealtime() {
    if (stream) {
      stream.close();
      stream = null;
    }
    clearTimeout(streamRetry);
    streamRetry = null;
    clearInterval(fallbackRefresh);
    fallbackRefresh = null;
  }

  function startFallbackRefresh() {
    if (fallbackRefresh) return;
    fallbackRefresh = setInterval(() => {
      load().catch((error) => notify(UI.friendlyErrorMessage(error)));
    }, 5000);
  }

  function connectRealtime() {
    stopRealtime();
    const base = window.__APP_CONFIG__?.API_BASE_URL;
    if (!base || !window.EventSource) {
      startFallbackRefresh();
      return;
    }
    const url = new URL(
      `${base}/tournaments/${encodeURIComponent(tournamentId)}/matches/${encodeURIComponent(matchId)}/referee/stream`
    );
    stream = new EventSource(url);
    stream.addEventListener('match-update', (event) => {
      try {
        const snapshot = JSON.parse(event.data);
        if (!state || !snapshot.match) return;
        state.match = snapshot.match;
        state.events = Array.isArray(snapshot.events) ? snapshot.events : [];
        clearInterval(fallbackRefresh);
        fallbackRefresh = null;
        render();
      } catch {
        startFallbackRefresh();
      }
    });
    stream.onerror = () => {
      if (!stream) return;
      stream.close();
      stream = null;
      startFallbackRefresh();
      clearTimeout(streamRetry);
      streamRetry = setTimeout(connectRealtime, 3000);
    };
  }

  window.addEventListener('beforeunload', stopRealtime, { once: true });
  load()
    .then(connectRealtime)
    .catch((error) => notify(UI.friendlyErrorMessage(error)));
})();
