// Assumes '../db' exports a promise-based wrapper with run/get/all methods,
// matching the convention implied by mappers.js's `require('../db')`.
// Adjust the calls below if your actual db module differs.
const crypto = require('crypto');
const db = require('../db');

// --- Votes ---

function createVote({ tournamentId, name, award }) {
  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO vote (id, tournament_id, name, award) VALUES (?, ?, ?, ?)`)
    .run(id, tournamentId, name, award);
  return getVoteById(id);
}

function getVoteById(id) {
  return db.prepare(`SELECT * FROM vote WHERE id = ?`).get(id);
}

function listVotesByTournament(tournamentId) {
  return db.prepare(`SELECT * FROM vote WHERE tournament_id = ?`).all(tournamentId);
}

function updateVote(id, { name, award } = {}) {
  const existing =  getVoteById(id);
  if (!existing) return null;
  db.prepare(`UPDATE vote SET name = ?, award = ? WHERE id = ?`).run(name ?? existing.name, award ?? existing.award, id);
  return getVoteById(id);
}

function deleteVote(id) {
  const result =  db.prepare(`DELETE FROM vote WHERE id = ?`).run(id);
  return result.changes > 0;
}

// --- Vote nominees ---

function addNominee({ voteId, nomineeId}) {
  db.prepare(
    `INSERT INTO vote_nominees (vote_id, nominee_id, votes) VALUES (?, ?, 0)`
  ).run(voteId, nomineeId);
  return getNominee(voteId, nomineeId);
}

function getNominee(voteId, nomineeId) {
  return db.prepare(
    `SELECT * FROM vote_nominees WHERE vote_id = ? AND nominee_id = ?`)
    .get(voteId, nomineeId);
}

function listNominees(voteId) {
  return db.prepare(`SELECT * FROM vote_nominees WHERE vote_id = ?`).all(voteId);
}

function setNomineeVoter(voteId, nomineeId, userId) {
  const existing =  getNominee(voteId, nomineeId);
  if (!existing) return -1;
  try {
    db.prepare(
      `UPDATE vote_nominees SET user_id = ? WHERE vote_id = ? AND nominee_id = ? AND votes = ?`
    ).run(userId, voteId, nomineeId, existing.votes + 1);
    return getNominee(voteId, nomineeId);
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE' || err.code === 'SQLITE_CONSTRAINT') return -2;
    throw err;
  }
}

function removeNominee(voteId, nomineeId) {
  const result =  db.prepare(
    `DELETE FROM vote_nominees WHERE vote_id = ? AND nominee_id = ?`).run(voteId, nomineeId);
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
  setNomineeVoter,
  removeNominee,
};
