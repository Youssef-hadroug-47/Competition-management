const { asyncHandler } = require('../utils/asyncHandler');
const access = require('../services/access');
const simulation = require('../services/simulationService');
const { advanceKnockoutStage } = require('../services/drawService');

const simulateMatch = asyncHandler(async (req, res) => {
  const result = await simulation.simulateMatch(req.params.id, { actorId: req.user.id });
  res.json(result);
});

const simulateGroup = asyncHandler(async (req, res) => {
  const result = await simulation.simulateGroup(req.params.id, { actorId: req.user.id });
  res.json(result);
});

const simulateRound = asyncHandler(async (req, res) => {
  const result = await simulation.simulateRound(req.params.id, { actorId: req.user.id });
  res.json(result);
});

const simulateStage = asyncHandler(async (req, res) => {
  const result = await simulation.simulateStage(req.params.id, { actorId: req.user.id });
  res.json(result);
});

const simulateTournament = asyncHandler(async (req, res) => {
  await access.getTournamentOrThrow(req.params.tournamentId);
  const result = await simulation.simulateTournament(req.params.tournamentId, { actorId: req.user.id });
  res.json(result);
});

module.exports = { simulateMatch, simulateGroup, simulateRound, simulateStage, simulateTournament };
