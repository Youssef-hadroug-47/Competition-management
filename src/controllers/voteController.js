const voteService = require('../services/voteService');
const mappers = require('../services/mappers');
const { asyncHandler } = require('../utils/asyncHandler');

// --- Votes ---

const listVotes = asyncHandler( (req, res, next) => {
  try {
    const { tournamentId } = req.params;
    const rows =  voteService.listVotesByTournament(tournamentId);
    res.json(rows.map(mappers.vote));
  } catch (err) {
    next(err);
  }
});

const getVote = asyncHandler( (req, res, next) => {
  try {
    const row =  voteService.getVoteById(req.params.id);
    if (!row) return res.status(404).json({ error: 'Vote not found' });
    res.json(mappers.vote(row));
  } catch (err) {
    next(err);
  }
});

const createVote = asyncHandler( (req, res, next) => {
  try {
    const { tournamentId } = req.params;
    const { name, award } = req.body;
    if (!name || !award) {
      return res.status(400).json({ error: 'name and award are required' });
    }
    const row =  voteService.createVote({ tournamentId, name, award });
    res.status(201).json(mappers.vote(row));
  } catch (err) {
    next(err);
  }
});

const updateVote = asyncHandler( (req, res, next) => {
  try {
    const row =  voteService.updateVote(req.params.id, req.body);
    if (!row) return res.status(404).json({ error: 'Vote not found' });
    res.json(mappers.vote(row));
  } catch (err) {
    next(err);
  }
});

const deleteVote = asyncHandler( (req, res, next) => {
  try {
    const deleted =  voteService.deleteVote(req.params.id);
    if (!deleted) return res.status(404).json({ error: 'Vote not found' });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

// --- Vote nominees ---

const listNominees = asyncHandler( (req, res, next) => {
  try {
    const rows = voteService.listNominees(req.params.voteId);
    res.json(rows.map(mappers.voteNominee));
  } catch (err) {
    next(err);
  }
});

const addNominee = asyncHandler( (req, res, next) => {
  try {
    const { voteId } = req.params;
    const { nomineeId } = req.body;
    if (!nomineeId) {
      return res.status(400).json({ error: 'nomineeId is required' });
    }
    const row =  voteService.addNominee({ voteId, nomineeId });
    res.status(201).json(mappers.voteNominee(row));
  } catch (err) {
    next(err);
  }
});


const vote = asyncHandler( (req, res, next) => {
  try {
    const { voteId, nomineeId } = req.params;
    const { userId } = req.body; 
    const row =  voteService.setNomineeVoter(voteId, nomineeId, userId);
    if (row === -1) return res.status(404).json({ error: 'Nominee not found' });
    if (row === -2) return res.status(400).json({ error: 'User already voted'});
    res.json(mappers.voteNominee(row));
  } catch (err) {
    next(err);
  }
});

const removeNominee = asyncHandler ((req, res, next) => {
  try {
    const { voteId, nomineeId } = req.params;
    const deleted = voteService.removeNominee(voteId, nomineeId);
    if (!deleted) return res.status(404).json({ error: 'Nominee not found' });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

module.exports = {
  listVotes,
  getVote,
  createVote,
  updateVote,
  deleteVote,
  listNominees,
  addNominee,
  vote,
  removeNominee,
};
