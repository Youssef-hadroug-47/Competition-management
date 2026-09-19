const { db } = require("../db");


function getAllFollowedTournaments(userId) {
  if (!userId) return null;

  const tournaments = db.prepare(`
    SELECT t.* FROM tournaments t 
    JOIN tournament_follows tf ON tf.tournament_id = t.id
    WHERE tf.user_id = ?
    AND tf.status = 'accepted'
    `).all(userId);

  return tournaments;

}

module.exports = {
  getAllFollowedTournaments,
}
