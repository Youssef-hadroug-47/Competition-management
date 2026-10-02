const { query } = require('../db');

async function getRoles(tournamentId) {
  if (!tournamentId) return null;
  const result = await query(
    'SELECT role, user_id FROM tournament_role WHERE tournament_id = $1',
    [tournamentId],
  );
  return result.rows;
}

async function getRole(tournamentId, userId) {
  if (!(tournamentId && userId)) return null;
  const result = await query(
    'SELECT role FROM tournament_role WHERE tournament_id = $1 AND user_id = $2',
    [tournamentId, userId],
  );
  const row = result.rows[0];
  return row?.role || null;
}

async function addRole(tournamentId, userId, role) {
  if (!(tournamentId && userId && role)) return false;
  try {
    await query(
      'INSERT INTO tournament_role (tournament_id, user_id, role) VALUES ($1, $2, $3)',
      [tournamentId, userId, role],
    );
    return true;
  } catch (err) {
    if (err.code === '23505') return false;
    throw err;
  }
}

async function updateRole(tournamentId, userId, role) {
  if (!(tournamentId && userId && role)) return false;

  if (!(await getRole(tournamentId, userId))) return false;

  const result = await query(
    'UPDATE tournament_role SET role = $1 WHERE tournament_id = $2 AND user_id = $3',
    [role, tournamentId, userId],
  );
  return result.rowCount > 0;
}

async function deleteRole(tournamentId, userId) {
  if (!(tournamentId && userId)) return false;

  const result = await query(
    'DELETE FROM tournament_role WHERE tournament_id = $1 AND user_id = $2',
    [tournamentId, userId],
  );
  return result.rowCount > 0;
} 


module.exports = {
  getRoles,
  getRole,
  addRole,
  updateRole,
  deleteRole,
}
