const voteService = require('../services/voteService');
const mappers = require('../services/mappers');
const access = require('../services/access');
const { asyncHandler } = require('../utils/asyncHandler');
const { httpError } = require('../middleware/error');

function tournament(req) {
  return access.getTournamentOrThrow(req.params.tournamentId);
}

const listVotes = asyncHandler((req, res) => {
  const row = tournament(req);
  access.requireTournamentInspect(row, req.user);
  const votes = voteService.listVotesByTournament(row.id, req.user?.id || null);
  res.json({ votes: votes.map(mappers.vote) });
});

const getVote = asyncHandler((req, res) => {
  const row = tournament(req);
  access.requireTournamentInspect(row, req.user);
  const vote = voteService.getVoteById(req.params.id, row.id);
  if (!vote) throw httpError(404, 'Vote not found');
  res.json({ vote: mappers.vote(vote) });
});

const createVote = asyncHandler((req, res) => {
  const row = tournament(req);
  const { name, award } = req.body || {};
  if (!name?.trim() || !award?.trim()) throw httpError(400, 'name and award are required');
  res.status(201).json({ vote: mappers.vote(voteService.createVote({
    tournamentId: row.id,
    name,
    award,
  })) });
});

const updateVote = asyncHandler((req, res) => {
  const row = tournament(req);
  res.json({ vote: mappers.vote(voteService.updateVote(req.params.id, row.id, req.body || {})) });
});

const finishVote = asyncHandler((req, res) => {
  const row = tournament(req);
  res.json({ vote: mappers.vote(voteService.finishVote(req.params.id, row.id)) });
});

const deleteVote = asyncHandler((req, res) => {
  const row = tournament(req);
  if (!voteService.deleteVote(req.params.id, row.id)) throw httpError(404, 'Vote not found');
  res.status(204).end();
});

const listNominees = asyncHandler((req, res) => {
  const row = tournament(req);
  access.requireTournamentInspect(row, req.user);
  const vote = voteService.getVoteById(req.params.voteId, row.id);
  if (!vote) throw httpError(404, 'Vote not found');
  res.json({ nominees: voteService.listNominees(vote.id, row.id, req.user?.id || null).map(mappers.voteNominee) });
});

const addNominee = asyncHandler((req, res) => {
  const row = tournament(req);
  const { nomineeId } = req.body || {};
  if (!nomineeId) throw httpError(400, 'nomineeId is required');
  res.status(201).json({ nominee: mappers.voteNominee(voteService.addNominee({
    voteId: req.params.voteId,
    tournamentId: row.id,
    nomineeId,
  })) });
});

const castVote = asyncHandler((req, res) => {
  const row = tournament(req);
  if (!req.user?.id) throw httpError(401, 'Authentication required');
  res.json({ nominee: mappers.voteNominee(voteService.castVote({
    voteId: req.params.voteId,
    tournamentId: row.id,
    nomineeId: req.params.nomineeId,
    userId: req.user.id,
  })) });
});

const removeNominee = asyncHandler((req, res) => {
  const row = tournament(req);
  if (!voteService.removeNominee(req.params.voteId, row.id, req.params.nomineeId)) {
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
