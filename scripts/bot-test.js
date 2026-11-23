// Dev helper: connects fake voters that vote random legal moves so a whole
// game can be played quickly. Usage: node scripts/bot-test.js [url] [bots] [seconds]
import { io } from 'socket.io-client';
const url = process.argv[2] || 'http://localhost:3000';
const bots = Number(process.argv[3] || 4);
const seconds = Number(process.argv[4] || 60);
let last = null;
for (let i = 0; i < bots; i++) {
  const s = io(url, { auth: { voterId: `bot-${i}-${Date.now()}` } });
  let votedPly = -1;
  s.on('state', (st) => {
    if (i === 0) {
      const line = `${st.phase} game#${st.gameNumber} ply=${st.ply} total=${st.stats.totalMoves} P${st.stats.peopleWins}/S${st.stats.stockfishWins}/D${st.stats.draws} votes=${st.voters}${st.result ? ' RESULT=' + JSON.stringify(st.result) : ''}`;
      if (line !== last) console.log(line);
      last = line;
    }
    if (st.phase === 'voting' && votedPly !== st.ply && st.legal.length) {
      votedPly = st.ply;
      const pick = i % 2 && st.votes[0] ? st.votes[0].uci : st.legal[Math.floor(Math.random() * st.legal.length)].uci;
      setTimeout(() => s.emit('vote', pick, (r) => { if (!r.ok) console.log('rejected', r.error); }), 50 + i * 40);
    }
  });
}
setTimeout(() => process.exit(0), seconds * 1000);
