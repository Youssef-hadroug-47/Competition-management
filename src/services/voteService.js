// Assumes '../db' exports a promise-based wrapper with run/get/all methods,
// matching the convention implied by mappers.js's `require('../db')`.
// Adjust the calls below if your actual db module differs.
const crypto = require('crypto');
const db = require('../db');

// --- Votes ---

function createVote({ tournamentId, name, award }) {
  const id = crypto.randomUUID();
  db.run(
    `INSERT INTO vote (id, tournament_id, name, award) VALUES (?, ?, ?, ?)`,
    [id, tournamentId, name, award]
  );
  return getVoteById(id);
}

 function getVoteById(id) {
  return db.get(`SELECT * FROM vote WHERE id = ?`, [id]);
}

 function listVotesByTournament(tournamentId) {
  return db.all(`SELECT * FROM vote WHERE tournament_id = ?`, [tournamentId]);
}

 function updateVote(id, { name, award } = {}) {
  const existing =  getVoteById(id);
  if (!existing) return null;
   db.run(
    `UPDATE vote SET name = ?, award = ? WHERE id = ?`,
    [name ?? existing.name, award ?? existing.award, id]
  );
  return getVoteById(id);
}

 function deleteVote(id) {
  const result =  db.run(`DELETE FROM vote WHERE id = ?`, [id]);
  return result.changes > 0;
}

// --- Vote nominees ---

 function addNominee({ voteId, nomineeId }) {
   db.run(
    `INSERT INTO vote_nominees (vote_id, nominee_id, votes) VALUES (?, ?, 0)`,
    [voteId, nomineeId]
  );
  return getNominee(voteId, nomineeId);
}

 function getNominee(voteId, nomineeId) {
  return db.get(
    `SELECT * FROM vote_nominees WHERE vote_id = ? AND nominee_id = ?`,
    [voteId, nomineeId]
  );
}

 function listNominees(voteId) {
  return db.all(`SELECT * FROM vote_nominees WHERE vote_id = ?`, [voteId]);
}

 function setNomineeVotes(voteId, nomineeId, votes) {
  const existing =  getNominee(voteId, nomineeId);
  if (!existing) return null;
   db.run(
    `UPDATE vote_nominees SET votes = ? WHERE vote_id = ? AND nominee_id = ?`,
    [votes, voteId, nomineeId]
  );
  return getNominee(voteId, nomineeId);
}

 function removeNominee(voteId, nomineeId) {
  const result =  db.run(
    `DELETE FROM vote_nominees WHERE vote_id = ? AND nominee_id = ?`,
    [voteId, nomineeId]
  );
  return result.changes > 0;
}

module.exports = {
  createVote,
  getVoteById,
  listVotesByTournament,
  updateVote,
  deleteVote,
  addNominee,
  getNominee,
  listNominees,
  setNomineeVotes,
  removeNominee,
};
