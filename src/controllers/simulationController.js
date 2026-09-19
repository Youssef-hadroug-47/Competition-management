const { asyncHandler } = require('../utils/asyncHandler');
const access = require('../services/access');
const simulation = require('../services/simulationService');

const simulateMatch = asyncHandler((req, res) => {
  const result = simulation.simulateMatch(req.params.id, { actorId: req.user.id });
  res.json(result);
});

const simulateStage = asyncHandler((req, res) => {
  const result = simulation.simulateStage(req.params.id, { actorId: req.user.id });
  res.json(result);
});

const simulateTournament = asyncHandler((req, res) => {
  access.getTournamentOrThrow(req.params.tournamentId);
  const result = simulation.simulateTournament(req.params.tournamentId, { actorId: req.user.id });
  res.json(result);
});

module.exports = { simulateMatch, simulateStage, simulateTournament };
