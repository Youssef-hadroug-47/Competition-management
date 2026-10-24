const voteService = require('../services/voteService');
const { query } = require('../db');
const mappers = require('../services/mappers');
const access = require('../services/access');
const { asyncHandler } = require('../utils/asyncHandler');
const { httpError } = require('../middleware/error');

async function tournament(req) {
  const result = await query('SELECT * FROM tournaments WHERE id = $1', [req.params.tournamentId]);
  const row = result.rows[0];
  if (!row) throw httpError(404, 'Tournament not found');
  return row;
}

const listVotes = asyncHandler(async (req, res) => {
  const row = await tournament(req);
  await access.requireTournamentInspect(row, req.user);
  const userId = req.user?.id || null;
  // Votes and their nominees are fetched together so the voting view does not
  // need one nominees request per vote.
  const [votes, nominees] = await Promise.all([
    voteService.listVotesByTournament(row.id, userId),
    voteService.listNomineesByTournament(row.id, userId),
  ]);
  const nomineesByVote = new Map();
  for (const nominee of nominees) {
    if (!nomineesByVote.has(nominee.vote_id)) nomineesByVote.set(nominee.vote_id, []);
    nomineesByVote.get(nominee.vote_id).push(mappers.voteNominee(nominee));
  }
  res.json({
    votes: votes.map((vote) => ({
      ...mappers.vote(vote),
      nominees: nomineesByVote.get(vote.id) || [],
    })),
  });
});

const getVote = asyncHandler(async (req, res) => {
  const row = await tournament(req);
  await access.requireTournamentInspect(row, req.user);
  const vote = await voteService.getVoteById(req.params.id, row.id);
  if (!vote) throw httpError(404, 'Vote not found');
  res.json({ vote: mappers.vote(vote) });
});

const createVote = asyncHandler(async (req, res) => {
  const row = await tournament(req);
  const { name, award } = req.body || {};
  if (!name?.trim() || !award?.trim()) throw httpError(400, 'name and award are required');
  res.status(201).json({ vote: mappers.vote(await voteService.createVote({
    tournamentId: row.id,
    name,
    award,
  })) });
});

const updateVote = asyncHandler(async (req, res) => {
  const row = await tournament(req);
  res.json({ vote: mappers.vote(await voteService.updateVote(req.params.id, row.id, req.body || {})) });
});

const finishVote = asyncHandler(async (req, res) => {
  const row = await tournament(req);
  res.json({ vote: mappers.vote(await voteService.finishVote(req.params.id, row.id)) });
});

const deleteVote = asyncHandler(async (req, res) => {
  const row = await tournament(req);
  if (!await voteService.deleteVote(req.params.id, row.id)) throw httpError(404, 'Vote not found');
  res.status(204).end();
});

const listNominees = asyncHandler(async (req, res) => {
  const row = await tournament(req);
  await access.requireTournamentInspect(row, req.user);
  const vote = await voteService.getVoteById(req.params.voteId, row.id);
  if (!vote) throw httpError(404, 'Vote not found');
  res.json({ nominees: (await voteService.listNominees(vote.id, row.id, req.user?.id || null)).map(mappers.voteNominee) });
});

const addNominee = asyncHandler(async (req, res) => {
  const row = await tournament(req);
  const { nomineeId } = req.body || {};
  if (!nomineeId) throw httpError(400, 'nomineeId is required');
  res.status(201).json({ nominee: mappers.voteNominee(await voteService.addNominee({
    voteId: req.params.voteId,
    tournamentId: row.id,
    nomineeId,
  })) });
});

const addTeamNominees = asyncHandler(async (req, res) => {
  const { teamId } = req.body || {};
  if (!teamId) throw httpError(400, 'teamId is required');
  const result = await query(
    `WITH vote_target AS (
       SELECT id, status FROM vote WHERE id = $1 AND tournament_id = $2
     ),
     team_target AS (
       SELECT id FROM participant_teams WHERE id = $3 AND tournament_id = $2
     ),
     eligible AS (
       SELECT vote_target.id AS vote_id
       FROM vote_target, team_target
       WHERE vote_target.status = 'open'
     ),
     inserted AS (
       INSERT INTO vote_nominees (vote_id, nominee_id, votes)
       SELECT eligible.vote_id, pp.id, 0
       FROM eligible
       JOIN team_target ON TRUE
       JOIN participant_players pp ON pp.participant_team_id = team_target.id
       ON CONFLICT (vote_id, nominee_id) DO NOTHING
       RETURNING vote_id, nominee_id, votes
     )
     SELECT
       (SELECT status FROM vote_target) AS vote_status,
       (SELECT id FROM team_target) AS team_id,
       (SELECT COUNT(*) FROM participant_players pp WHERE pp.participant_team_id = $3) AS team_player_count,
       COALESCE(
         (SELECT json_agg(json_build_object(
             'vote_id', inserted.vote_id,
             'nominee_id', inserted.nominee_id,
             'votes', inserted.votes,
             'participant_team_id', pp.participant_team_id,
             'player_name', pp.name,
             'player_position', pp.position
           ) ORDER BY pp.name COLLATE "C")
          FROM inserted
          JOIN participant_players pp ON pp.id = inserted.nominee_id),
         '[]'::json
       ) AS nominees`,
    [req.params.voteId, req.params.tournamentId, teamId],
  );
  const row = result.rows[0];
  if (!row?.vote_status) throw httpError(404, 'Vote not found');
  if (row.vote_status !== 'open') throw httpError(409, 'This vote is finished.');
  if (!row.team_id) throw httpError(404, 'Participant team not found');
  if (!Number(row.team_player_count)) throw httpError(400, 'This team has no registered players.');
  res.status(201).json({ nominees: (row.nominees || []).map(mappers.voteNominee) });
});

const castVote = asyncHandler(async (req, res) => {
  const row = await tournament(req);
  if (!req.user?.id) throw httpError(401, 'Authentication required');
  res.json({ nominee: mappers.voteNominee(await voteService.castVote({
    voteId: req.params.voteId,
    tournamentId: row.id,
    nomineeId: req.params.nomineeId,
    userId: req.user.id,
  })) });
});

const removeNominee = asyncHandler(async (req, res) => {
  const row = await tournament(req);
  if (!await voteService.removeNominee(req.params.voteId, row.id, req.params.nomineeId)) {
    throw httpError(404, 'Nominee not found');
  }
  res.status(204).end();
});

module.exports = {
  listVotes,
  getVote,
  createVote,
  updateVote,
  finishVote,
  deleteVote,
  listNominees,
  addNominee,
  addTeamNominees,
  castVote,
  removeNominee,
};
