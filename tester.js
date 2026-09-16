
const sortedTeams = [{id: 5},{id: 7},{id: 8},{id: 2},{id: 10}];
const rankedPromotions = [{team: {id: 8}}, {team: {id: 10}}, {team: {id: 5}}, {team: {id: 2}}, {team: {id: 7}}];

console.log(sortedTeams);
console.log(rankedPromotions);


const teams = new Map();
for (let i=0; i<sortedTeams.length; i++ ) {
  teams.set(rankedPromotions[i].team.id, i);
}
console.log(teams);
console.log("====================================");


for (let index = 0; index< sortedTeams.length; index++) {
  const current = rankedPromotions[index];
  const aux = rankedPromotions[teams.get(sortedTeams[index].id)]; // correct placement of the first element
  rankedPromotions[teams.get(sortedTeams[index].id)] = rankedPromotions[index];
  rankedPromotions[index] = aux;
  
  const auxIndex = teams.get(sortedTeams[index].id);
  teams.set(sortedTeams[index].id, index);
  teams.set(current.team.id, auxIndex);
}
console.log(rankedPromotions);

