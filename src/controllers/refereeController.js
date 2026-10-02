const { asyncHandler } = require('../utils/asyncHandler');
const { httpError } = require('../middleware/error');
const referee = require('../services/refereeService');
const map = require('../services/mappers');
const { getMatchDetail } = require('../services/matchService');
const { isAdministrator } = require('../middleware/auth');
const access = require('../services/access');
const { query } = require('../db');
const { resetStage, runDraw } = require('../services/drawService');
const adminOverride = (req) => isAdministrator(req.user);

const detail = asyncHandler(async (req, res) => {
  const tournament = await access.getTournamentOrThrow(req.params.tournamentId);
  await access.requireTournamentInspect(tournament, req.user);
  const data = await referee.snapshot(req.params.id, req.params.tournamentId);
  const detailData = await getMatchDetail(req.params.id);
  res.json({
    ...detailData,
    match: map.match(data.match),
    events: data.events,
  });

});

const start = asyncHandler(async (req, res) => {
  const data = await referee.start({
    matchId: req.params.id,
    tournamentId: req.params.tournamentId,
    refereeId: req.user.id,
    adminOverride: adminOverride(req),
    durationMinutes: req.body?.durationMinutes,
  });
  res.json({ match: map.match(data.match), events: data.events });
});

const continueFinished = asyncHandler(async (req, res) => {
  const data = await referee.continueFinished({
    matchId: req.params.id,
    tournamentId: req.params.tournamentId,
    refereeId: req.user.id,
    adminOverride: adminOverride(req),
    moderatorOverride: req.user.tournamentRoles?.[req.params.tournamentId] === 'moderator',
    expectedRevision: req.body?.revision,
  });
  res.json({ match: map.match(data.match), events: data.events });
});

const event = asyncHandler(async (req, res) => {
  const data = await referee.addEvent({
    matchId: req.params.id,
    tournamentId: req.params.tournamentId,
    refereeId: req.user.id,
    adminOverride: adminOverride(req),
    moderatorOverride: req.user.tournamentRoles?.[req.params.tournamentId] === 'moderator',
    type: req.body?.type,
    phase: req.body?.phase,
    payload: req.body?.payload || {},
    clientEventId: req.body?.clientEventId || null,
    expectedRevision: req.body?.revision,
  });
  res.status(201).json({
    match: map.match(data.match),
    events: data.events,
    eventId: data.eventId || null,
    impact: data.impact || null,
  });
});

const updateEvent = asyncHandler(async (req, res) => {
  const data = await referee.updateEvent({
    matchId: req.params.id,
    tournamentId: req.params.tournamentId,
    eventId: req.params.eventId,
    refereeId: req.user.id,
    adminOverride: adminOverride(req),
    moderatorOverride: req.user.tournamentRoles?.[req.params.tournamentId] === 'moderator',
    changes: req.body?.changes || req.body || {},
    expectedRevision: req.body?.revision,
    reason: req.body?.reason,
  });
  res.json({ match: map.match(data.match), events: data.events, impact: data.impact || null });
});

const deleteEvent = asyncHandler(async (req, res) => {
  const data = await referee.deleteEvent({
    matchId: req.params.id,
    tournamentId: req.params.tournamentId,
    eventId: req.params.eventId,
    refereeId: req.user.id,
    adminOverride: adminOverride(req),
    moderatorOverride: req.user.tournamentRoles?.[req.params.tournamentId] === 'moderator',
    expectedRevision: req.body?.revision,
    reason: req.body?.reason,
  });
  res.json({ match: map.match(data.match), events: data.events, impact: data.impact || null });
});

const applyImpact = asyncHandler(async (req, res) => {
  await access.getTournamentOrThrow(req.params.tournamentId);
  const match = (await query(
    `SELECT m.stage_id, m.revision, s.sequence_order
     FROM matches m JOIN stages s ON s.id = m.stage_id
     WHERE m.id = $1 AND m.tournament_id = $2`,
    [req.params.id, req.params.tournamentId])).rows[0];
  if (!match) throw httpError(404, 'Match not found');
  if (req.body?.revision != null && Number(req.body.revision) !== Number(match.revision)) {
    throw httpError(409, 'Match changed while the impact was awaiting confirmation. Refresh and retry.');
  }
  const stageIds = Array.isArray(req.body?.stageIds) ? req.body.stageIds.filter(Boolean) : [];
  if (!stageIds.length) throw httpError(400, 'Affected downstream stages are required');
  const placeholders = stageIds.map((_, index) => `$${index + 3}`).join(', ');
  const validNextStages = (await query(
    `SELECT id FROM stages
     WHERE tournament_id = $1 AND sequence_order = $2 AND id IN (${placeholders})`,
    [req.params.tournamentId, Number(match.sequence_order) + 1, ...stageIds])).rows;
  if (validNextStages.length !== stageIds.length) {
    throw httpError(400, 'Only directly affected next stages can be reset');
  }
  const results = [];
  for (const stageId of stageIds) {
    const stageState = (await query(
      `SELECT COUNT(*) AS total,
              COUNT(*) FILTER (WHERE status NOT IN ('scheduled', 'postponed', 'cancelled')) AS started
       FROM matches WHERE tournament_id = $1 AND stage_id = $2`,
      [req.params.tournamentId, stageId])).rows[0];
    if (Number(stageState.total || 0) === 0) {
      results.push({ stageId, action: 'none' });
    } else if (Number(stageState.started || 0) > 0) {
      results.push({
        stageId,
        action: 'reset',
        result: await resetStage({
          tournamentId: req.params.tournamentId,
          stageId: match.stage_id,
          scopeStageIds: [stageId],
        }),
      });
    } else {
      results.push({
        stageId,
        action: 'redraw',
        result: await runDraw({ tournamentId: req.params.tournamentId, stageId }),
      });
    }
  }
  res.json({ results });
});

const transition = asyncHandler(async (req, res) => {
  const data = await referee.transition({
    matchId: req.params.id,
    tournamentId: req.params.tournamentId,
    refereeId: req.user.id,
    adminOverride: adminOverride(req),
    moderatorOverride: req.user.tournamentRoles?.[req.params.tournamentId] === 'moderator',
    action: req.body?.action,
    expectedRevision: req.body?.revision,
  });
  res.json({ match: map.match(data.match), events: data.events });
});

const finishPhase = asyncHandler(async (req, res) => {
  const data = await referee.finishPhase({
    matchId: req.params.id,
    tournamentId: req.params.tournamentId,
    refereeId: req.user.id,
    adminOverride: adminOverride(req),
    moderatorOverride: req.user.tournamentRoles?.[req.params.tournamentId] === 'moderator',
    phase: req.body?.phase,
    expectedRevision: req.body?.revision,
  });
  res.json({ match: map.match(data.match), events: data.events, advance: data.advance || null });
});

const abandon = asyncHandler(async (req, res) => {
  const data = await referee.abandon({
    matchId: req.params.id,
    tournamentId: req.params.tournamentId,
    refereeId: req.user.id,
    adminOverride: adminOverride(req),
    moderatorOverride: req.user.tournamentRoles?.[req.params.tournamentId] === 'moderator',
    reason: req.body?.reason,
  });
  res.json({ match: map.match(data.match), events: data.events });
});

const stream = asyncHandler(async (req, res) => {
  const tournament = await access.getTournamentOrThrow(req.params.tournamentId);
  await access.requireTournamentInspect(tournament, req.user);
  const match = (await query(
    'SELECT id FROM matches WHERE id = $1 AND tournament_id = $2',
    [req.params.id, req.params.tournamentId]
  )).rows[0];
  if (!match) throw httpError(404, 'Match not found');
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.flushHeaders?.();
  let last = '';
  const send = async () => {
    const data = await referee.snapshot(req.params.id, req.params.tournamentId);
    const payload = JSON.stringify({ match: map.match(data.match), events: data.events });
    if (payload !== last) {
      res.write(`event: match-update\ndata: ${payload}\n\n`);
      last = payload;
    } else {
      res.write(': heartbeat\n\n');
    }
  };
  await send();
  const timer = setInterval(() => { send().catch(() => clearInterval(timer)); }, 1000);
  req.on('close', () => clearInterval(timer));
});

module.exports = { detail, start, continueFinished, event, updateEvent, deleteEvent, applyImpact, transition, finishPhase, abandon, stream };
