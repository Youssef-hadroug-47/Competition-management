const { query, withTransaction } = require('../db');
const { httpError } = require('../middleware/error');
const { id } = require('../utils/ids');

async function one(text, values = []) {
  return (await query(text, values)).rows[0];
}
async function many(text, values = []) {
  return (await query(text, values)).rows;
}

async function getVoteById(voteId, tournamentId = null) {
  return one(
    `SELECT * FROM vote WHERE id = $1${tournamentId ? ' AND tournament_id = $2' : ''}`,
    tournamentId ? [voteId, tournamentId] : [voteId],
  );
}

function assertOpen(vote) {
  if (!vote) throw httpError(404, 'Vote not found');
  if (vote.status !== 'open') throw httpError(409, 'This vote is finished.');
}

async function createVote({ tournamentId, name, award }) {
  const voteId = id();
  await query(
    `INSERT INTO vote (id, tournament_id, name, award, status) VALUES ($1, $2, $3, $4, 'open')`,
    [voteId, tournamentId, name.trim(), award.trim()],
  );
  return getVoteById(voteId, tournamentId);
}

async function listVotesByTournament(tournamentId, userId = null) {
  return many(
    `SELECT v.*,
       (SELECT COUNT(*) FROM vote_ballots b WHERE b.vote_id = v.id) AS ballot_count,
       (SELECT nominee_id FROM vote_ballots b WHERE b.vote_id = v.id AND b.user_id = $1) AS selected_nominee_id
     FROM vote v
     WHERE v.tournament_id = $2
     ORDER BY v.created_at DESC, v.id DESC`,
    [userId, tournamentId],
  );
}

async function updateVote(voteId, tournamentId, { name, award } = {}) {
  const existing = await getVoteById(voteId, tournamentId);
  assertOpen(existing);
  await query(
    'UPDATE vote SET name = $1, award = $2 WHERE id = $3 AND tournament_id = $4',
    [name?.trim() || existing.name, award?.trim() || existing.award, voteId, tournamentId],
  );
  return getVoteById(voteId, tournamentId);
}

async function finishVote(voteId, tournamentId) {
  const existing = await getVoteById(voteId, tournamentId);
  assertOpen(existing);
  await query(
    `UPDATE vote SET status = 'finished', finished_at = NOW() WHERE id = $1 AND tournament_id = $2`,
    [voteId, tournamentId],
  );
  return getVoteById(voteId, tournamentId);
}

async function deleteVote(voteId, tournamentId) {
  const result = await query('DELETE FROM vote WHERE id = $1 AND tournament_id = $2', [voteId, tournamentId]);
  return result.rowCount > 0;
}

async function getNominee(voteId, nomineeId, tournamentId = null) {
  return one(
    `SELECT vn.vote_id, vn.nominee_id, vn.votes, pp.participant_team_id,
            p.name AS player_name, p.position AS player_position
     FROM vote_nominees vn
     JOIN vote v ON v.id = vn.vote_id
     JOIN participant_players pp ON pp.id = vn.nominee_id
     JOIN players p ON p.id = pp.player_id
     WHERE vn.vote_id = $1 AND vn.nominee_id = $2${tournamentId ? ' AND v.tournament_id = $3' : ''}`,
    tournamentId ? [voteId, nomineeId, tournamentId] : [voteId, nomineeId],
  );
}

async function listNominees(voteId, tournamentId, userId = null) {
  return many(
    `SELECT vn.vote_id, vn.nominee_id, vn.votes, pp.participant_team_id,
            p.name AS player_name, p.position AS player_position,
            CASE WHEN b.user_id IS NULL THEN 0 ELSE 1 END AS selected_by_viewer
     FROM vote_nominees vn
     JOIN vote v ON v.id = vn.vote_id AND v.tournament_id = $1
     JOIN participant_players pp ON pp.id = vn.nominee_id
     JOIN players p ON p.id = pp.player_id
     LEFT JOIN vote_ballots b ON b.vote_id = vn.vote_id
       AND b.nominee_id = vn.nominee_id AND b.user_id = $2
     WHERE vn.vote_id = $3
     ORDER BY vn.votes DESC, p.name COLLATE "C"`,
    [tournamentId, userId, voteId],
  );
}

async function addNominee({ voteId, tournamentId, nomineeId }) {
  const vote = await getVoteById(voteId, tournamentId);
  assertOpen(vote);
  const player = await one(
    `SELECT pp.id FROM participant_players pp
     JOIN participant_teams pt ON pt.id = pp.participant_team_id
     WHERE pp.id = $1 AND pt.tournament_id = $2`,
    [nomineeId, tournamentId],
  );
  if (!player) throw httpError(404, 'Participant player not found');
  if (await getNominee(voteId, nomineeId, tournamentId)) throw httpError(409, 'This nominee is already added.');
  try {
    await query('INSERT INTO vote_nominees (vote_id, nominee_id, votes) VALUES ($1, $2, 0)', [voteId, nomineeId]);
  } catch (err) {
    if (err.code === '23505') throw httpError(409, 'This nominee is already added.');
    throw err;
  }
  return getNominee(voteId, nomineeId, tournamentId);
}

async function removeNominee(voteId, tournamentId, nomineeId) {
  const vote = await getVoteById(voteId, tournamentId);
  assertOpen(vote);
  const result = await query(
    'DELETE FROM vote_nominees WHERE vote_id = $1 AND nominee_id = $2',
    [voteId, nomineeId],
  );
  return result.rowCount > 0;
}

async function castVote({ voteId, tournamentId, nomineeId, userId }) {
  const vote = await getVoteById(voteId, tournamentId);
  assertOpen(vote);
  if (!(await getNominee(voteId, nomineeId, tournamentId))) throw httpError(404, 'Nominee not found');
  try {
    await withTransaction(async (client) => {
      await client.query(
        'INSERT INTO vote_ballots (vote_id, user_id, nominee_id) VALUES ($1, $2, $3)',
        [voteId, userId, nomineeId],
      );
      await client.query(
        'UPDATE vote_nominees SET votes = votes + 1 WHERE vote_id = $1 AND nominee_id = $2',
        [voteId, nomineeId],
      );
    });
  } catch (err) {
    if (err.code === '23505') throw httpError(409, 'You have already voted in this vote.');
    throw err;
  }
  return getNominee(voteId, nomineeId, tournamentId);
}

module.exports = {
  getVoteById, listVotesByTournament, createVote, updateVote, finishVote, deleteVote,
  listNominees, addNominee, removeNominee, castVote,
};
