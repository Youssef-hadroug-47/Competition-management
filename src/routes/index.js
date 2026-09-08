const express = require('express');
const { requireAuth, requireRole, authOptional } = require('../middleware/auth');
const auth = require('../controllers/authController');
const tournaments = require('../controllers/tournamentController');
const catalog = require('../controllers/catalogController');
const matches = require('../controllers/matchController');

const router = express.Router();

router.get('/health', (req, res) => res.json({ ok: true }));

router.post('/auth/register', auth.register);
router.post('/auth/login', auth.login);
router.get('/auth/me', requireAuth, auth.me);
router.get('/users', requireAuth, requireRole('admin'), auth.listUsers);
router.patch('/users/:id/role', requireAuth, requireRole('admin'), auth.updateRole);

router.get('/tournaments', authOptional, tournaments.list);
router.get('/tournaments/:id', authOptional, tournaments.getOne);
router.post('/tournaments', requireAuth, requireRole('admin'), tournaments.create);
router.patch('/tournaments/:id', requireAuth, requireRole('admin'), tournaments.update);
router.delete('/tournaments/:id', requireAuth, requireRole('admin'), tournaments.remove);

router.post('/tournaments/:id/stages', requireAuth, requireRole('admin'), tournaments.addStage);
router.patch('/stages/:id', requireAuth, requireRole('admin'), tournaments.updateStage);
router.delete('/stages/:id', requireAuth, requireRole('admin'), tournaments.removeStage);
router.post('/stages/:id/groups', requireAuth, requireRole('admin'), tournaments.addGroup);
router.patch('/groups/:id', requireAuth, requireRole('admin'), tournaments.updateGroup);
router.delete('/groups/:id', requireAuth, requireRole('admin'), tournaments.removeGroup);

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

router.get('/tournaments/:id/participant-teams', authOptional, catalog.listParticipantTeams);
router.post('/tournaments/:id/participant-teams', requireAuth, requireRole('admin'), catalog.addParticipantTeam);
router.patch('/participant-teams/:id', requireAuth, requireRole('admin'), catalog.updateParticipantTeam);
router.delete('/participant-teams/:id', requireAuth, requireRole('admin'), catalog.removeParticipantTeam);

router.get('/participant-teams/:id/players', authOptional, catalog.listParticipantPlayers);
router.post('/participant-teams/:id/players', requireAuth, requireRole('admin'), catalog.addParticipantPlayer);
router.patch('/participant-players/:id', requireAuth, requireRole('admin'), catalog.updateParticipantPlayer);
router.delete('/participant-players/:id', requireAuth, requireRole('admin'), catalog.removeParticipantPlayer);

router.post('/draw', requireAuth, requireRole('admin'), matches.draw);
router.post('/tournaments/:id/draw', requireAuth, requireRole('admin'), matches.draw);

router.get('/tournaments/:id/matches', authOptional, matches.listMatches);
router.get('/matches/:id', authOptional, matches.getMatch);
router.post('/matches/:id/start', requireAuth, requireRole('admin', 'referee'), matches.startMatch);
router.patch('/matches/:id', requireAuth, requireRole('admin', 'referee'), matches.updateMatch);
router.post('/matches/:id/finish', requireAuth, requireRole('admin', 'referee'), matches.finishMatch);

router.post('/tournaments/:id/follow', requireAuth, matches.follow);
router.delete('/tournaments/:id/follow', requireAuth, matches.unfollow);
router.get('/tournaments/:id/followers', requireAuth, requireRole('admin'), matches.listFollowers);
router.patch(
  '/tournaments/:id/follow-requests/:userId',
  requireAuth,
  requireRole('admin'),
  matches.moderateFollow
);

module.exports = router;
