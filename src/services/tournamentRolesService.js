const db = require('../db');

function getRoles(tournamentId) {
  return (tournamentId) ?
    db.prepare('SELECT role, user_id FROM tournament_role WHERE tournament_id = ?').all(tournamentId) : null;
}

function getRole(tournamentId, userId) {
  return  (tournamentId && userId) ? 
    db.prepare('SELECT role FROM tournament_role WHERE tournament_id = ? AND user_id = ?').get(tournamentId, userId) : null ;
}

function addRole(tournamentId, userId, role) {
  if (!(tournamentId && userId && role)) return false;
  try {
    db.prepare('INSERT INTO tournament_role (tournament_id, user_id, role) VALUES (?, ?, ?)').run(tournamentId, userId, role);
    return true;
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE' || err.code === 'SQLITE_CONSTRAINT') return false;
    throw err;
  }
}

function updateRole(tournamentId, userId, role) {
  if (!(tournamentId && userId && role)) return false;

  if (!getRole(tournamentId, userId)) return false;

  db.prepare('UPDATE tournament_role SET role = ? WHERE tournament_id = ? AND user_id = ?').run(role, tournamentId, userId);
  return true;
}

function deleteRole(tournamentId, userId) {
  if (!(tournamentId && userId)) return false;

  if (!getRole(tournamentId, userId)) return false;

  db.prepare('DELETE FROM tournament_role WHERE tournament_id = ? AND user_id = ?').run(tournamentId, userId);
  return true;
} 


module.exports = {
  getRoles,
  getRole,
  addRole,
  updateRole,
  deleteRole,
}
