const { asyncHandler } = require('../utils/asyncHandler');
const referee = require('../services/refereeService');
const map = require('../services/mappers');
const { getMatchDetail } = require('../services/matchService');
const { isAdministrator } = require('../middleware/auth');
const adminOverride = (req) => isAdministrator(req.user);

const detail = asyncHandler((req, res) => {
  const data = referee.snapshot(req.params.id, req.params.tournamentId);
  const detailData = getMatchDetail(req.params.id);
  res.json({
    ...detailData,
    match: map.match(data.match),
    events: data.events,
  });

});

const start = asyncHandler((req, res) => {
  const data = referee.start({
    matchId: req.params.id,
    tournamentId: req.params.tournamentId,
    refereeId: req.user.id,
    adminOverride: adminOverride(req),
    durationMinutes: req.body?.durationMinutes,
  });
  res.json({ match: map.match(data.match), events: data.events });
});

const event = asyncHandler((req, res) => {
  const data = referee.addEvent({
    matchId: req.params.id,
    tournamentId: req.params.tournamentId,
    refereeId: req.user.id,
    adminOverride: adminOverride(req),
    type: req.body?.type,
    phase: req.body?.phase,
    payload: req.body?.payload || {},
    clientEventId: req.body?.clientEventId || null,
    expectedRevision: req.body?.revision,
  });

  const updateEvent = asyncHandler((req, res) => {
    const data = referee.updateEvent({
      matchId: req.params.id,
      tournamentId: req.params.tournamentId,
      eventId: req.params.eventId,
      refereeId: req.user.id,
      adminOverride: adminOverride(req),
      changes: req.body?.changes || req.body || {},
      expectedRevision: req.body?.revision,
      reason: req.body?.reason,
    });
    res.json({ match: map.match(data.match), events: data.events });
  });

  const deleteEvent = asyncHandler((req, res) => {
    const data = referee.deleteEvent({
      matchId: req.params.id,
      tournamentId: req.params.tournamentId,
      eventId: req.params.eventId,
      refereeId: req.user.id,
      adminOverride: adminOverride(req),
      expectedRevision: req.body?.revision,
      reason: req.body?.reason,
    });
    res.json({ match: map.match(data.match), events: data.events });
  });
  res.status(201).json({ match: map.match(data.match), events: data.events });
});

const transition = asyncHandler((req, res) => {
  const data = referee.transition({
    matchId: req.params.id,
    tournamentId: req.params.tournamentId,
    refereeId: req.user.id,
    adminOverride: adminOverride(req),
    action: req.body?.action,
    expectedRevision: req.body?.revision,
  });
  res.json({ match: map.match(data.match), events: data.events });
});

const finishPhase = asyncHandler((req, res) => {
  const data = referee.finishPhase({
    matchId: req.params.id,
    tournamentId: req.params.tournamentId,
    refereeId: req.user.id,
    adminOverride: adminOverride(req),
    phase: req.body?.phase,
    expectedRevision: req.body?.revision,
  });
  res.json({ match: map.match(data.match), events: data.events, advance: data.advance || null });
});

const abandon = asyncHandler((req, res) => {
  const data = referee.abandon({
    matchId: req.params.id,
    tournamentId: req.params.tournamentId,
    refereeId: req.user.id,
    adminOverride: adminOverride(req),
    reason: req.body?.reason,
  });
  res.json({ match: map.match(data.match), events: data.events });
});

const stream = asyncHandler((req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.flushHeaders?.();
  let last = '';
  const send = () => {
    const data = referee.snapshot(req.params.id, req.params.tournamentId);
    const payload = JSON.stringify({ match: map.match(data.match), events: data.events });
    if (payload !== last) {
      res.write(`event: match-update\ndata: ${payload}\n\n`);
      last = payload;
    } else {
      res.write(': heartbeat\n\n');
    }
  };
  send();
  const timer = setInterval(send, 1000);
  req.on('close', () => clearInterval(timer));
});

module.exports = { detail, start, event, updateEvent, deleteEvent, transition, finishPhase, abandon, stream };
