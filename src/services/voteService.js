const { db } = require('../db');
const { httpError } = require('../middleware/error');
const { id } = require('../utils/ids');

function getVoteById(voteId, tournamentId = null) {
  return db.prepare(
    `SELECT * FROM vote WHERE id = ?${tournamentId ? ' AND tournament_id = ?' : ''}`
  ).get(...(tournamentId ? [voteId, tournamentId] : [voteId]));
}

function assertOpen(vote) {
  if (!vote) throw httpError(404, 'Vote not found');
  if (vote.status !== 'open') throw httpError(409, 'This vote is finished.');
}

function createVote({ tournamentId, name, award }) {
  const voteId = id();
  db.prepare(
    `INSERT INTO vote (id, tournament_id, name, award, status) VALUES (?, ?, ?, ?, 'open')`
  ).run(voteId, tournamentId, name.trim(), award.trim());
  return getVoteById(voteId, tournamentId);
}

function listVotesByTournament(tournamentId, userId = null) {
  return db.prepare(
    `SELECT v.*,
       (SELECT COUNT(*) FROM vote_ballots b WHERE b.vote_id = v.id) AS ballot_count,
       (SELECT nominee_id FROM vote_ballots b WHERE b.vote_id = v.id AND b.user_id = ?) AS selected_nominee_id
     FROM vote v
     WHERE v.tournament_id = ?
     ORDER BY v.created_at DESC, v.id DESC`
  ).all(userId, tournamentId);
}

function updateVote(voteId, tournamentId, { name, award } = {}) {
  const existing = getVoteById(voteId, tournamentId);
  assertOpen(existing);
  db.prepare(`UPDATE vote SET name = ?, award = ? WHERE id = ? AND tournament_id = ?`).run(
    name?.trim() || existing.name,
    award?.trim() || existing.award,
    voteId,
    tournamentId
  );
  return getVoteById(voteId, tournamentId);
}

function finishVote(voteId, tournamentId) {
  const existing = getVoteById(voteId, tournamentId);
  assertOpen(existing);
  db.prepare(`UPDATE vote SET status = 'finished', finished_at = datetime('now') WHERE id = ? AND tournament_id = ?`)
    .run(voteId, tournamentId);
  return getVoteById(voteId, tournamentId);
}

function deleteVote(voteId, tournamentId) {
  const result = db.prepare(`DELETE FROM vote WHERE id = ? AND tournament_id = ?`).run(voteId, tournamentId);
  return result.changes > 0;
}

function getNominee(voteId, nomineeId, tournamentId = null) {
  return db.prepare(
    `SELECT vn.vote_id, vn.nominee_id, vn.votes, pp.participant_team_id,
            p.name AS player_name, p.position AS player_position
     FROM vote_nominees vn
     JOIN vote v ON v.id = vn.vote_id
     JOIN participant_players pp ON pp.id = vn.nominee_id
     JOIN players p ON p.id = pp.player_id
     WHERE vn.vote_id = ? AND vn.nominee_id = ?${tournamentId ? ' AND v.tournament_id = ?' : ''}`
  ).get(...(tournamentId ? [voteId, nomineeId, tournamentId] : [voteId, nomineeId]));
}

function listNominees(voteId, tournamentId, userId = null) {
  return db.prepare(
    `SELECT vn.vote_id, vn.nominee_id, vn.votes, pp.participant_team_id,
            p.name AS player_name, p.position AS player_position,
            CASE WHEN b.user_id IS NULL THEN 0 ELSE 1 END AS selected_by_viewer
     FROM vote_nominees vn
     JOIN vote v ON v.id = vn.vote_id AND v.tournament_id = ?
     JOIN participant_players pp ON pp.id = vn.nominee_id
     JOIN players p ON p.id = pp.player_id
     LEFT JOIN vote_ballots b ON b.vote_id = vn.vote_id
       AND b.nominee_id = vn.nominee_id AND b.user_id = ?
     WHERE vn.vote_id = ?
     ORDER BY vn.votes DESC, p.name COLLATE NOCASE`
  ).all(tournamentId, userId, voteId);
}

function addNominee({ voteId, tournamentId, nomineeId }) {
  const vote = getVoteById(voteId, tournamentId);
  assertOpen(vote);
  const player = db.prepare(
    `SELECT pp.id FROM participant_players pp
     JOIN participant_teams pt ON pt.id = pp.participant_team_id
     WHERE pp.id = ? AND pt.tournament_id = ?`
  ).get(nomineeId, tournamentId);
  if (!player) throw httpError(404, 'Participant player not found');
  if (getNominee(voteId, nomineeId, tournamentId)) throw httpError(409, 'This nominee is already added.');
  try {
    db.prepare(`INSERT INTO vote_nominees (vote_id, nominee_id, votes) VALUES (?, ?, 0)`).run(voteId, nomineeId);
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT_PRIMARYKEY' || err.code === 'SQLITE_CONSTRAINT') {
      throw httpError(409, 'This nominee is already added.');
    }
    throw err;
  }
  return getNominee(voteId, nomineeId, tournamentId);
}

function removeNominee(voteId, tournamentId, nomineeId) {
  const vote = getVoteById(voteId, tournamentId);
  assertOpen(vote);
  const result = db.prepare(`DELETE FROM vote_nominees WHERE vote_id = ? AND nominee_id = ?`).run(voteId, nomineeId);
  return result.changes > 0;
}

function castVote({ voteId, tournamentId, nomineeId, userId }) {
  const vote = getVoteById(voteId, tournamentId);
  assertOpen(vote);
  if (!getNominee(voteId, nomineeId, tournamentId)) throw httpError(404, 'Nominee not found');
  try {
    db.exec('BEGIN');
    db.prepare(`INSERT INTO vote_ballots (vote_id, user_id, nominee_id) VALUES (?, ?, ?)`)
      .run(voteId, userId, nomineeId);
    db.prepare(`UPDATE vote_nominees SET votes = votes + 1 WHERE vote_id = ? AND nominee_id = ?`)
      .run(voteId, nomineeId);
    db.exec('COMMIT');
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch {}
    if (err.code === 'SQLITE_CONSTRAINT_PRIMARYKEY' || err.code === 'SQLITE_CONSTRAINT' ||
        String(err.message).includes('UNIQUE constraint failed: vote_ballots.vote_id, vote_ballots.user_id')) {
      throw httpError(409, 'You have already voted in this vote.');
    }
    throw err;
  }
  return getNominee(voteId, nomineeId, tournamentId);
}

module.exports = {
  getVoteById,
  listVotesByTournament,
  createVote,
  updateVote,
  finishVote,
  deleteVote,
  listNominees,
  addNominee,
  removeNominee,
  castVote,
};
