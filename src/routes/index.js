const express = require('express');
const { requireAuth, requireRole, authOptional, requireTournamentRole, requireTournamentModerator, requireTournamentReferee, requireTournamentSupervisor, requireOwner } = require('../middleware/auth');
const auth = require('../controllers/authController');
const tournaments = require('../controllers/tournamentController');
const catalog = require('../controllers/catalogController');
const matches = require('../controllers/matchController');
const simulation = require('../controllers/simulationController');
const votes = require('../controllers/voteController');
const referee = require('../controllers/refereeController');

const router = express.Router();

router.get('/health', (req, res) => res.json({ ok: true }));

router.post('/auth/register', auth.register);
router.post('/auth/login', auth.login);
router.get('/auth/me', requireAuth, auth.me);
router.get('/users', requireAuth, requireRole('admin'), auth.listUsers);
router.patch('/users/:id/role', requireAuth, requireRole('admin'), auth.updateRole);

router.get('/tournaments/followed', requireAuth, matches.listFollowedTournaments);
router.get('/tournaments/mine', requireAuth, tournaments.listMine);
router.get('/tournaments', authOptional, tournaments.list);
router.get('/tournaments/search', authOptional, tournaments.searchByName);
router.get('/tournaments/:tournamentId', authOptional, tournaments.getOne);
router.post('/tournaments', requireAuth, tournaments.create);
router.patch('/tournaments/:tournamentId', requireAuth, requireTournamentRole('moderator'), tournaments.update);
router.delete('/tournaments/:tournamentId', requireAuth, requireOwner, tournaments.remove);

router.get('/tournaments/:tournamentId/stages/:id/standing', authOptional, tournaments.getStanding);
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
router.post('/tournaments/:tournamentId/participant-teams/auto', requireAuth, requireRole('admin'), catalog.autoAddParticipantTeams);
router.patch('/tournaments/:tournamentId/participant-teams/:id', requireAuth, requireTournamentRole('moderator'), catalog.updateParticipantTeam);
router.delete('/tournaments/:tournamentId/participant-teams/:id', requireAuth, requireTournamentRole('moderator'), catalog.removeParticipantTeam);

router.get('/tournaments/:tournamentId/participant-teams/:id/players', authOptional, catalog.listParticipantPlayers);
router.post('/tournaments/:tournamentId/participant-teams/:id/players', requireAuth, requireTournamentRole('moderator'), catalog.addParticipantPlayer);
router.post('/tournaments/:tournamentId/participant-teams/:id/players/auto', requireAuth, requireRole('admin'), catalog.autoAddParticipantPlayers);
router.patch('/tournaments/:tournamentId/participant-players/:id', requireAuth, requireTournamentRole('moderator'), catalog.updateParticipantPlayer);
router.delete('/tournaments/:tournamentId/participant-players/:id', requireAuth, requireTournamentRole('moderator'), catalog.removeParticipantPlayer);

router.post('/tournaments/:tournamentId/draw', requireAuth, requireTournamentRole('moderator'), matches.draw);
router.delete('/tournaments/:tournamentId/stages/:id/reset', requireAuth, requireTournamentRole('moderator'), matches.resetStage);

router.get('/tournaments/:tournamentId/matches', authOptional, matches.listMatches);
router.get('/tournaments/:tournamentId/matches/:id', authOptional, matches.getMatch);
router.get('/tournaments/:tournamentId/matches/:id/detail', authOptional, matches.getMatchDetail);
router.post('/tournaments/:tournamentId/matches/:id/start', requireAuth, requireTournamentSupervisor, matches.startMatch);
router.post('/tournaments/:tournamentId/matches/:id/pause', requireAuth, requireTournamentSupervisor, matches.pauseMatch);
router.post('/tournaments/:tournamentId/matches/:id/resume', requireAuth, requireTournamentSupervisor, matches.resumeMatch);
router.post('/tournaments/:tournamentId/matches/:id/abandon', requireAuth, requireTournamentSupervisor, matches.abandonMatch);
router.post('/tournaments/:tournamentId/matches/:id/cancel', requireAuth, requireRole('admin'), matches.cancelMatch);
router.patch('/tournaments/:tournamentId/matches/:id', requireAuth, requireTournamentSupervisor, matches.updateMatch);
router.post('/tournaments/:tournamentId/matches/:id/finish', requireAuth, requireTournamentSupervisor, matches.finishMatch);
router.get('/tournaments/:tournamentId/matches/:id/referee', requireAuth, requireTournamentReferee, referee.detail);
router.get('/tournaments/:tournamentId/matches/:id/referee/stream', requireAuth, requireTournamentReferee, referee.stream);
router.post('/tournaments/:tournamentId/matches/:id/referee/start', requireAuth, requireTournamentReferee, referee.start);
router.post('/tournaments/:tournamentId/matches/:id/referee/events', requireAuth, requireTournamentReferee, referee.event);
router.patch('/tournaments/:tournamentId/matches/:id/referee/events/:eventId', requireAuth, requireTournamentReferee, referee.updateEvent);
router.delete('/tournaments/:tournamentId/matches/:id/referee/events/:eventId', requireAuth, requireTournamentReferee, referee.deleteEvent);
router.post('/tournaments/:tournamentId/matches/:id/referee/transition', requireAuth, requireTournamentReferee, referee.transition);
router.post('/tournaments/:tournamentId/matches/:id/referee/finish-phase', requireAuth, requireTournamentReferee, referee.finishPhase);
router.post('/tournaments/:tournamentId/matches/:id/referee/abandon', requireAuth, requireTournamentReferee, referee.abandon);

router.post('/matches/:id/simulate', requireAuth, requireRole('admin'), simulation.simulateMatch);
router.post('/groups/:id/simulate', requireAuth, requireRole('admin'), simulation.simulateGroup);
router.post('/rounds/:id/simulate', requireAuth, requireRole('admin'), simulation.simulateRound);
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


router.get('/tournaments/:tournamentId/votes', authOptional, votes.listVotes);
router.get('/tournaments/:tournamentId/votes/:id', authOptional, votes.getVote);
router.post('/tournaments/:tournamentId/votes', requireAuth, requireTournamentModerator, votes.createVote);
router.patch('/tournaments/:tournamentId/votes/:id', requireAuth, requireTournamentModerator, votes.updateVote);
router.post('/tournaments/:tournamentId/votes/:id/finish', requireAuth, requireTournamentModerator, votes.finishVote);
router.delete('/tournaments/:tournamentId/votes/:id', requireAuth, requireTournamentModerator, votes.deleteVote);

router.get('/tournaments/:tournamentId/votes/:voteId/nominees', authOptional, votes.listNominees);
router.post('/tournaments/:tournamentId/votes/:voteId/nominees', requireAuth, requireTournamentModerator, votes.addNominee);
router.post('/tournaments/:tournamentId/votes/:voteId/nominees/:nomineeId', requireAuth, votes.castVote);
router.delete('/tournaments/:tournamentId/votes/:voteId/nominees/:nomineeId', requireAuth, requireTournamentModerator, votes.removeNominee);

router.get('/tournaments/:tournamentId/roles', requireAuth ,requireOwner , tournaments.getAllTournamentRole);
router.get('/tournaments/:tournamentId/roles/me', requireAuth, tournaments.getUserRole);
router.get('/tournaments/:tournamentId/staff-users', requireAuth, requireOwner, tournaments.findStaffUser);
router.post('/tournaments/:tournamentId/roles/:userId', requireAuth, requireOwner, tournaments.addTournamentRole);
router.patch('/tournaments/:tournamentId/roles/:userId', requireAuth, requireOwner, tournaments.updateTournamentRole);
router.delete('/tournaments/:tournamentId/roles/:userId', requireAuth, requireOwner, tournaments.deleteTournamentRole);

module.exports = router;
