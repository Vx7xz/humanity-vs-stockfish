// People vs Stockfish — everyone votes on the people's move, the move with the
// most votes is played, then Stockfish answers. Games run back to back forever.
import express from 'express';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { Server } from 'socket.io';
import { Chess } from 'chess.js';
import { Engine } from './src/engine.js';
import { loadState, saveState, storageMode } from './src/store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const num = (v, def) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? def : Number(v));
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

const CONFIG = {
  port: num(process.env.PORT, 3000),
  voteSeconds: clamp(num(process.env.VOTE_SECONDS, 20), 3, 600),
  engineMoveMs: clamp(num(process.env.ENGINE_MOVE_MS, 1000), 50, 30000),
  engineSkill: clamp(num(process.env.STOCKFISH_SKILL, 10), 0, 20),
  nextGameSeconds: clamp(num(process.env.NEXT_GAME_SECONDS, 15), 1, 600),
  maxVotersPerIp: clamp(num(process.env.MAX_VOTERS_PER_IP, 3), 1, 1000),
};

// ---------------------------------------------------------------- state ----

/** Persisted state. `game.moves` holds UCI moves so the game can be rebuilt. */
let state = (await loadState()) || {};
state = {
  createdAt: state.createdAt || new Date().toISOString(),
  totalMoves: state.totalMoves || 0,
  peopleMoves: state.peopleMoves || 0,
  totalVotes: state.totalVotes || 0,
  peopleWins: state.peopleWins || 0,
  stockfishWins: state.stockfishWins || 0,
  draws: state.draws || 0,
  gamesPlayed: state.gamesPlayed || 0,
  recentGames: state.recentGames || [],
  game: state.game || { number: 1, peopleColor: 'w', moves: [], startedAt: new Date().toISOString() },
};

let chess = new Chess();
for (const uci of state.game.moves) {
  try {
    chess.move(uciToMove(uci));
  } catch {
    console.warn('[game] stored move list was invalid; starting a fresh game');
    state.game.moves = [];
    chess = new Chess();
    break;
  }
}

// Runtime-only state.
let phase = 'voting'; // 'voting' | 'engine' | 'gameover'
let votes = new Map(); // voterId -> { uci, at, ip }
let deadline = null; // ms timestamp when voting closes (set by first vote)
let voteTimer = null;
let lastResult = null;
let lastMove = null;
let nextGameAt = null;
let turnToken = 0; // guards against stale async engine replies

const engine = new Engine({ skill: CONFIG.engineSkill });

function uciToMove(uci) {
  return { from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] };
}

function legalMoves() {
  return chess.moves({ verbose: true }).map((m) => ({
    uci: m.from + m.to + (m.promotion || ''),
    san: m.san,
    from: m.from,
    to: m.to,
    promotion: m.promotion || null,
  }));
}

function tally() {
  const counts = new Map();
  for (const v of votes.values()) {
    const c = counts.get(v.uci) || { uci: v.uci, count: 0, firstAt: v.at };
    c.count++;
    c.firstAt = Math.min(c.firstAt, v.at);
    counts.set(v.uci, c);
  }
  // Most votes first; on a tie the move that was proposed first wins.
  return [...counts.values()].sort((a, b) => b.count - a.count || a.firstAt - b.firstAt);
}

function sanOf(uci) {
  const m = legalMoves().find((x) => x.uci === uci);
  return m ? m.san : uci;
}

// ------------------------------------------------------------ game flow ----

function startTurn() {
  turnToken++;
  clearTimeout(voteTimer);
  votes = new Map();
  deadline = null;

  if (chess.isGameOver()) return endGame();

  if (chess.turn() === state.game.peopleColor) {
    phase = 'voting';
    broadcast();
  } else {
    phase = 'engine';
    broadcast();
    engineTurn(turnToken);
  }
}

async function engineTurn(token) {
  const started = Date.now();
  let uci;
  try {
    uci = await engine.bestMove(chess.fen(), CONFIG.engineMoveMs);
  } catch (err) {
    console.error(`[engine] ${err.message}; retrying once`);
    try {
      uci = await engine.bestMove(chess.fen(), CONFIG.engineMoveMs);
    } catch (err2) {
      console.error(`[engine] ${err2.message}; playing a random legal move`);
      const moves = legalMoves();
      uci = moves[Math.floor(Math.random() * moves.length)].uci;
    }
  }
  if (token !== turnToken) return;
  // Keep a small minimum delay so people can follow what happened.
  const wait = Math.max(0, 600 - (Date.now() - started));
  setTimeout(() => {
    if (token !== turnToken) return;
    playMove(uci, 'stockfish');
  }, wait);
}

function closeVoting() {
  if (phase !== 'voting') return;
  const ranked = tally();
  if (!ranked.length) {
    deadline = null;
    return broadcast();
  }
  state.totalVotes += votes.size;
  state.peopleMoves++;
  playMove(ranked[0].uci, 'people', { votes: ranked[0].count, voters: votes.size });
}

function playMove(uci, by, extra = {}) {
  let move;
  try {
    move = chess.move(uciToMove(uci));
  } catch {
    console.error(`[game] illegal move ${uci} by ${by}; skipping`);
    return startTurn();
  }
  state.game.moves.push(uci);
  state.totalMoves++;
  lastMove = { from: move.from, to: move.to, san: move.san, by, ...extra };
  saveState(state);
  startTurn();
}

function endGame() {
  let winner = 'draw';
  let reason = 'draw';
  if (chess.isCheckmate()) {
    const loser = chess.turn();
    winner = loser === state.game.peopleColor ? 'stockfish' : 'people';
    reason = 'checkmate';
  } else if (chess.isStalemate()) reason = 'stalemate';
  else if (chess.isThreefoldRepetition()) reason = 'threefold repetition';
  else if (chess.isInsufficientMaterial()) reason = 'insufficient material';
  else if (chess.isDraw()) reason = '50-move rule';

  if (winner === 'people') state.peopleWins++;
  else if (winner === 'stockfish') state.stockfishWins++;
  else state.draws++;
  state.gamesPlayed++;

  lastResult = { winner, reason, gameNumber: state.game.number };
  state.recentGames.unshift({
    number: state.game.number,
    peopleColor: state.game.peopleColor,
    winner,
    reason,
    moves: state.game.moves.length,
    pgn: chess.pgn(),
    endedAt: new Date().toISOString(),
  });
  state.recentGames = state.recentGames.slice(0, 10);

  state.game.finished = true; // so a restart doesn't count this game twice
  phase = 'gameover';
  nextGameAt = Date.now() + CONFIG.nextGameSeconds * 1000;
  saveState(state);
  broadcast();
  setTimeout(newGame, CONFIG.nextGameSeconds * 1000);
}

function newGame() {
  state.game = {
    number: state.game.number + 1,
    // Swap colours every game so people get both White and Black.
    peopleColor: state.game.peopleColor === 'w' ? 'b' : 'w',
    moves: [],
    startedAt: new Date().toISOString(),
  };
  chess = new Chess();
  lastMove = null;
  lastResult = null;
  nextGameAt = null;
  saveState(state);
  startTurn();
}

// -------------------------------------------------------------- voting -----

function castVote(voterId, ip, uci) {
  if (phase !== 'voting') return 'Voting is closed right now.';
  if (!legalMoves().some((m) => m.uci === uci)) return 'That move is not legal.';
  if (!votes.has(voterId)) {
    let fromIp = 0;
    for (const v of votes.values()) if (v.ip === ip) fromIp++;
    if (fromIp >= CONFIG.maxVotersPerIp) return 'Too many votes from your network this round.';
  }
  const prev = votes.get(voterId);
  if (prev && prev.uci === uci) return null;
  votes.set(voterId, { uci, at: Date.now(), ip });
  if (!deadline) {
    deadline = Date.now() + CONFIG.voteSeconds * 1000;
    voteTimer = setTimeout(closeVoting, CONFIG.voteSeconds * 1000);
  }
  scheduleBroadcast();
  return null;
}

// ------------------------------------------------------------- network -----

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);
const server = http.createServer(app);
const io = new Server(server, { serveClient: true });

// maxAge 0 + ETag: browsers revalidate, so a redeploy shows up immediately.
app.use(express.static(path.join(__dirname, 'public'), { maxAge: 0 }));
app.get('/pieces.svg', (_req, res) => {
  res.set('Cache-Control', 'public, max-age=86400');
  res.sendFile(require.resolve('cm-chessboard/assets/pieces/standard.svg'));
});
app.get('/health', (_req, res) => res.json({ ok: true, phase, totalMoves: state.totalMoves }));
app.get('/api/state', (_req, res) => res.json(publicState()));

function publicState() {
  const ranked = tally();
  const inCheck = chess.inCheck();
  let checkSquare = null;
  if (inCheck) {
    const board = chess.board();
    for (const row of board)
      for (const sq of row)
        if (sq && sq.type === 'k' && sq.color === chess.turn()) checkSquare = sq.square;
  }
  return {
    phase,
    fen: chess.fen(),
    turn: chess.turn(),
    peopleColor: state.game.peopleColor,
    gameNumber: state.game.number,
    history: chess.history(),
    ply: state.game.moves.length,
    lastMove,
    checkSquare,
    legal: phase === 'voting' ? legalMoves() : [],
    votes: ranked.map((r) => ({ uci: r.uci, san: sanOf(r.uci), count: r.count })),
    voters: votes.size,
    deadline,
    serverNow: Date.now(),
    result: lastResult,
    nextGameAt,
    online: io.engine.clientsCount,
    stats: {
      createdAt: state.createdAt,
      totalMoves: state.totalMoves,
      peopleMoves: state.peopleMoves,
      totalVotes: state.totalVotes,
      peopleWins: state.peopleWins,
      stockfishWins: state.stockfishWins,
      draws: state.draws,
      gamesPlayed: state.gamesPlayed,
    },
    recentGames: state.recentGames.map(({ pgn, ...g }) => g),
    config: { voteSeconds: CONFIG.voteSeconds, skill: CONFIG.engineSkill },
  };
}

let broadcastTimer = null;
function broadcast() {
  clearTimeout(broadcastTimer);
  broadcastTimer = null;
  io.emit('state', publicState());
}
function scheduleBroadcast() {
  if (!broadcastTimer) broadcastTimer = setTimeout(broadcast, 150);
}

function clientIp(socket) {
  const fwd = socket.handshake.headers['x-forwarded-for'];
  return (typeof fwd === 'string' && fwd.split(',')[0].trim()) || socket.handshake.address;
}

io.on('connection', (socket) => {
  const raw = socket.handshake.auth && socket.handshake.auth.voterId;
  const voterId = typeof raw === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(raw) ? raw : socket.id;
  const ip = clientIp(socket);
  let lastVoteAt = 0;

  socket.emit('state', publicState());
  const mine = votes.get(voterId);
  socket.emit('yourVote', mine ? { uci: mine.uci, game: state.game.number, ply: state.game.moves.length } : null);
  scheduleBroadcast(); // online count changed

  socket.on('vote', (uci, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    const now = Date.now();
    if (now - lastVoteAt < 300) return reply({ ok: false, error: 'Slow down a little.' });
    lastVoteAt = now;
    if (typeof uci !== 'string' || !/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(uci))
      return reply({ ok: false, error: 'Bad move format.' });
    const error = castVote(voterId, ip, uci);
    if (error) return reply({ ok: false, error });
    reply({ ok: true, uci, game: state.game.number, ply: state.game.moves.length });
  });

  socket.on('disconnect', scheduleBroadcast);
});

server.listen(CONFIG.port, () => {
  console.log(`People vs Stockfish on http://localhost:${CONFIG.port}`);
  console.log(`storage: ${storageMode}, skill ${CONFIG.engineSkill}, vote window ${CONFIG.voteSeconds}s`);
  if (state.game.finished) newGame();
  else startTurn();
});

process.on('SIGTERM', () => {
  saveState(state);
  process.exit(0);
});
