const express = require('express');
const { requireAuth, requireRole, authOptional, requireTournamentRole, requireOwner } = require('../middleware/auth');
const auth = require('../controllers/authController');
const tournaments = require('../controllers/tournamentController');
const catalog = require('../controllers/catalogController');
const matches = require('../controllers/matchController');
const simulation = require('../controllers/simulationController');
const { listVotes, getVote, vote } = require('../controllers/voteController');
const { deleteVote, updateVote, listNominees, addNominee, removeNominee, createVote } = require('../services/voteService');

const router = express.Router();

router.get('/health', (req, res) => res.json({ ok: true }));

router.post('/auth/register', auth.register);
router.post('/auth/login', auth.login);
router.get('/auth/me', requireAuth, auth.me);
router.get('/users', requireAuth, requireRole('admin'), auth.listUsers);
router.patch('/users/:id/role', requireAuth, requireRole('admin'), auth.updateRole);

router.get('/tournaments/followed', requireAuth, matches.listFollowedTournaments);
router.get('/tournaments', authOptional, tournaments.list);
router.get('/tournaments/:tournamentId', authOptional, tournaments.getOne);
router.post('/tournaments', requireAuth, tournaments.create);
router.patch('/tournaments/:tournamentId', requireAuth, requireTournamentRole('moderator'), tournaments.update);
router.delete('/tournaments/:tournamentId', requireAuth, requireTournamentRole('moderator'), tournaments.remove);

router.get('/tournaments/:tournamentId/stages/:id', authOptional, tournaments.getStage);
router.post('/tournaments/:tournamentId/stages', requireAuth, requireTournamentRole('moderator'), tournaments.addStage);
router.patch('/tournaments/:tournamentId/stages/:id', requireAuth, requireTournamentRole('moderator'), tournaments.updateStage);
router.delete('/tournaments/:tournamentId/stages/:id', requireAuth, requireTournamentRole('moderator'), tournaments.removeStage);

router.post('/tournaments/:tournamentId/stages/:id/groups', requireAuth, requireTournamentRole('moderator'), tournaments.addGroup);
router.patch('/tournaments/:tournamentId/groups/:id', requireAuth, requireTournamentRole('moderator'), tournaments.updateGroup);
router.delete('/tournaments/:tournamentId/groups/:id', requireAuth, requireTournamentRole('moderator'), tournaments.removeGroup);

router.post('/tournaments/:tournamentId/stages/:id/rounds', requireAuth, requireTournamentRole('moderator'), tournaments.addRound);
router.patch('/tournaments/:tournamentId/rounds/:id', requireAuth, requireTournamentRole('moderator'), tournaments.updateRound);
router.delete('/tournaments/:tournamentId/rounds/:id', requireAuth, requireTournamentRole('moderator'), tournaments.removeRound);

router.get('/teams', authOptional, catalog.listTeams);
router.get('/teams/:id', authOptional, catalog.getTeam);
router.post('/teams', requireAuth, requireRole('admin'), catalog.createTeam);
router.patch('/teams/:id', requireAuth, requireRole('admin'), catalog.updateTeam);
router.delete('/teams/:id', requireAuth, requireRole('admin'), catalog.removeTeam);

router.get('/players', authOptional, catalog.listPlayers);
router.get('/players/:id', authOptional, catalog.getPlayer);
router.post('/players', requireAuth, requireRole('admin'), catalog.createPlayer);
router.patch('/players/:id', requireAuth, requireRole('admin'), catalog.updatePlayer);
router.delete('/players/:id', requireAuth, requireRole('admin'), catalog.removePlayer);

router.get('/tournaments/:tournamentId/participant-teams', authOptional, catalog.listParticipantTeams);
router.post('/tournaments/:tournamentId/participant-teams', requireAuth, requireTournamentRole('moderator'), catalog.addParticipantTeam);
router.patch('/tournaments/:tournamentId/participant-teams/:id', requireAuth, requireTournamentRole('moderator'), catalog.updateParticipantTeam);
router.delete('/tournaments/:tournamentId/participant-teams/:id', requireAuth, requireTournamentRole('moderator'), catalog.removeParticipantTeam);

router.get('/tournaments/:tournamentId/participant-teams/:id/players', authOptional, catalog.listParticipantPlayers);
router.post('/tournaments/:tournamentId/participant-teams/:id/players', requireAuth, requireTournamentRole('moderator'), catalog.addParticipantPlayer);
router.patch('/tournaments/:tournamentId/participant-players/:id', requireAuth, requireTournamentRole('moderator'), catalog.updateParticipantPlayer);
router.delete('/tournaments/:tournamentId/participant-players/:id', requireAuth, requireTournamentRole('moderator'), catalog.removeParticipantPlayer);

router.post('/tournaments/:tournamentId/draw', requireAuth, requireTournamentRole('moderator'), matches.draw);

router.get('/tournaments/:tournamentId/matches', authOptional, matches.listMatches);
router.get('/tournaments/:tournamentId/matches/:id', authOptional, matches.getMatch);
router.post('/tournaments/:tournamentId/matches/:id/start', requireAuth, requireTournamentRole('moderator', 'referee'), matches.startMatch);
router.patch('/tournaments/:tournamentId/matches/:id', requireAuth, requireTournamentRole('moderator', 'referee'), matches.updateMatch);
router.post('/tournaments/:tournamentId/matches/:id/finish', requireAuth, requireTournamentRole('moderator', 'referee'), matches.finishMatch);

router.post('/matches/:id/simulate', requireAuth, requireRole('admin'), simulation.simulateMatch);
router.post('/stages/:id/simulate', requireAuth, requireRole('admin'), simulation.simulateStage);
router.post('/tournaments/:tournamentId/simulate', requireAuth, requireRole('admin'), simulation.simulateTournament);

router.post('/tournaments/:tournamentId/follow', requireAuth, matches.follow);
router.delete('/tournaments/:tournamentId/follow', requireAuth, matches.unfollow);
router.get('/tournaments/:tournamentId/followers', requireAuth, requireTournamentRole('moderator'), matches.listFollowers);
router.patch(
  '/tournaments/:tournamentId/follow-requests/:userId',
  requireAuth,
  requireTournamentRole('moderator'),
  matches.moderateFollow
);


router.get('/tournaments/:tournamentId/votes', authOptional, listVotes);
router.get('/tournaments/:tournamentId/votes/:id', authOptional, getVote);
router.post('/tournaments/:tournamentId/votes', requireAuth, requireTournamentRole('moderator'), createVote);
router.patch('/tournaments/:tournamentId/votes/:id', requireAuth, requireTournamentRole('moderator'), updateVote);
router.delete('/tournaments/:tournamentId/votes/:id', requireAuth, requireTournamentRole('moderator'), deleteVote);

router.get('/tournaments/:tournamentId/votes/:voteId/nominees', authOptional, listNominees);
router.post('/tournaments/:tournamentId/votes/:voteId/nominees', requireAuth, requireTournamentRole('moderator'), addNominee);
router.post('/tournaments/:tournamentId/votes/:voteId/nominees/:nomineeId', requireAuth, vote);
router.delete('/tournaments/:tournamentId/votes/:voteId/nominees/:nomineeId', requireAuth, requireTournamentRole('moderator'), removeNominee);

router.get('/tournaments/:tournamentId/roles', requireAuth ,requireOwner, tournaments.getAllTournamentRole);
router.get('/tournaments/:tournamentId/roles/:userId', requireAuth, requireOwner, tournaments.getTournamentRole);
router.post('/tournaments/:tournamentId/roles/userId', requireAuth, requireOwner, tournaments.addTournamentRole);
router.patch('/tournaments/:tournamentId/roles/:userId', requireAuth, requireOwner, tournaments.updateTournamentRole);
router.delete('/tournaments/:tournamentId/roles/:userId', requireAuth, requireOwner, tournaments.deleteTournamentRole);

module.exports = router;
