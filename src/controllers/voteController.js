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
  castVote,
  removeNominee,
};
