const { query } = require('../db');

async function getAllFollowedTournaments(userId) {
  if (!userId) return null;

  const result = await query(
    `SELECT t.* FROM tournaments t
     JOIN tournament_follows tf ON tf.tournament_id = t.id
     WHERE tf.user_id = $1
       AND tf.status = 'accepted'`,
    [userId],
  );
  return result.rows;
}

module.exports = {
  getAllFollowedTournaments,
};
