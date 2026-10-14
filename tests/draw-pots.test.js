const test = require('node:test');
const assert = require('node:assert/strict');
const {
  eligiblePotCounts,
  validatePotAssignments,
  allocatePotParticipants,
  randomizedPotAssignments,
} = require('../src/services/drawService');

function groups(groupCount, groupSize) {
  return Array.from({ length: groupCount }, (_, index) => ({
    id: `group-${index + 1}`,
    number_teams: groupSize,
  }));
}

function teams(count) {
  return Array.from({ length: count }, (_, index) => ({
    id: `team-${index + 1}`,
    name: `Team ${index + 1}`,
  }));
}

function potAssignments(participants, potCount) {
  return participants.map((participant, index) => ({
    participantTeamId: participant.id,
    potNumber: (index % potCount) + 1,
  }));
}

test('eligible pot counts are powers of two that divide equal group capacities', () => {
  assert.deepEqual(eligiblePotCounts(groups(4, 4)), [2, 4]);
  assert.deepEqual(eligiblePotCounts(groups(2, 8)), [2, 4, 8]);
  assert.deepEqual(eligiblePotCounts(groups(2, 6)), [2]);
  assert.deepEqual(eligiblePotCounts(groups(2, 5)), []);
  assert.deepEqual(eligiblePotCounts([
    { id: 'a', number_teams: 4 },
    { id: 'b', number_teams: 8 },
  ]), []);
});

test('manual pot assignments must include every team and fill pots equally', () => {
  const drawGroups = groups(4, 4);
  const participants = teams(16);
  const assignments = potAssignments(participants, 4);
  const valid = validatePotAssignments(drawGroups, participants, 4, assignments);
  assert.equal(valid.size, participants.length);
  assert.throws(
    () => validatePotAssignments(drawGroups, participants, 3, assignments),
    (error) => error.status === 400,
  );
  assert.throws(
    () => validatePotAssignments(drawGroups, participants.slice(1), 4, assignments.slice(1)),
    (error) => error.status === 409,
  );
  assert.throws(
    () => validatePotAssignments(drawGroups, participants, 4, assignments.slice(1)),
    (error) => error.status === 400,
  );
  assert.throws(
    () => validatePotAssignments(drawGroups, participants, 4, [
      ...assignments.slice(1),
      { participantTeamId: participants[1].id, potNumber: 1 },
    ]),
    (error) => error.status === 400,
  );
  assert.throws(
    () => validatePotAssignments(drawGroups, participants, 4, [
      ...assignments.slice(0, 4),
      ...assignments.slice(5),
      { participantTeamId: participants[4].id, potNumber: 2 },
    ]),
    (error) => error.status === 400,
  );
});

test('pot-constrained allocation gives each group the exact quota from every pot', () => {
  const drawGroups = groups(4, 4);
  const participants = teams(16);
  const byTeam = validatePotAssignments(
    drawGroups,
    participants,
    4,
    potAssignments(participants, 4),
  );
  const assignments = allocatePotParticipants(drawGroups, participants, byTeam, (items) => items);
  const potByTeamId = new Map([...byTeam.entries()].map(([teamId, pot]) => [teamId, pot]));
  const grouped = new Map(drawGroups.map((group) => [group.id, []]));
  assignments.forEach((assignment) => grouped.get(assignment.group_id).push(assignment.id));
  for (const group of drawGroups) {
    const assignedPots = grouped.get(group.id).map((teamId) => potByTeamId.get(teamId));
    assert.equal(assignedPots.length, 4);
    assert.deepEqual(assignedPots.sort(), [1, 2, 3, 4]);
  }
});

test('larger groups receive groupSize divided by potCount teams per pot', () => {
  const drawGroups = groups(2, 8);
  const participants = teams(16);
  const assignments = potAssignments(participants, 4);
  const byTeam = validatePotAssignments(drawGroups, participants, 4, assignments);
  const allocated = allocatePotParticipants(drawGroups, participants, byTeam, (items) => items);
  for (const group of drawGroups) {
    const pots = allocated
      .filter((team) => team.group_id === group.id)
      .map((team) => byTeam.get(team.id));
    assert.deepEqual(pots.sort(), [1, 1, 2, 2, 3, 3, 4, 4]);
  }
});

test('random pot filling balances membership exactly', () => {
  const drawGroups = groups(2, 8);
  const participants = teams(16);
  const assignments = randomizedPotAssignments(participants, 4, (items) => [...items].reverse());
  const counts = new Map();
  assignments.forEach(({ potNumber }) => counts.set(potNumber, (counts.get(potNumber) || 0) + 1));
  assert.deepEqual([...counts.values()].sort(), [4, 4, 4, 4]);
  assert.deepEqual(new Set(assignments.map(({ participantTeamId }) => participantTeamId)).size, 16);
  const byTeam = validatePotAssignments(drawGroups, participants, 4, assignments);
  const allocated = allocatePotParticipants(drawGroups, participants, byTeam, (items) => items);
  for (const group of drawGroups) {
    const pots = allocated
      .filter((team) => team.group_id === group.id)
      .map((team) => byTeam.get(team.id));
    assert.deepEqual(pots.sort(), [1, 1, 2, 2, 3, 3, 4, 4]);
  }
});
