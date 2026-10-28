const config = require('../config');

function canCreateTournament(user) {
  if (!user) return false;
  if (config.tournamentCreation === '*') return true;
  if (config.tournamentCreation === 'admin') {
    return String(user.role || '').toLowerCase() === 'admin';
  }
  return false;
}

module.exports = { canCreateTournament };
