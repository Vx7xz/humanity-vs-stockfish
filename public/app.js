(() => {
  'use strict';

  // ---------- identity (one vote per browser) ----------
  function makeId() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'v' + Math.random().toString(36).slice(2) + Date.now().toString(36);
  }
  let voterId;
  try {
    voterId = localStorage.getItem('pvs-voter');
    if (!voterId) {
      voterId = makeId();
      localStorage.setItem('pvs-voter', voterId);
    }
  } catch {
    voterId = makeId();
  }

  const $ = (id) => document.getElementById(id);
  const FILES = 'abcdefgh';
  const NAMES = { k: 'king', q: 'queen', r: 'rook', b: 'bishop', n: 'knight', p: 'pawn' };

  let S = null; // latest server state
  let clockOffset = 0; // serverNow - Date.now()
  let myVote = null; // { uci, game, ply }
  let selected = null; // square
  let orientation = null;
  const squares = {}; // square -> element
  let lastStats = null;

  // ---------- piece sprite ----------
  fetch('/pieces.svg')
    .then((r) => r.text())
    .then((svg) => {
      $('sprite').innerHTML = svg.replace(/<\?xml[^>]*>/, '');
      if (S) renderBoard();
    })
    .catch(() => {});

  function pieceSvg(color, type) {
    return `<svg class="piece" viewBox="0 0 40 40" aria-label="${color === 'w' ? 'white' : 'black'} ${NAMES[type]}"><use href="#${color}${type}"></use></svg>`;
  }

  // ---------- board geometry ----------
  function squareXY(sq) {
    const f = FILES.indexOf(sq[0]);
    const r = Number(sq[1]);
    return orientation === 'w' ? { x: f, y: 8 - r } : { x: 7 - f, y: r - 1 };
  }

  function buildBoard(color) {
    orientation = color;
    const board = $('board');
    board.innerHTML = '';
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        const f = orientation === 'w' ? x : 7 - x;
        const r = orientation === 'w' ? 8 - y : y + 1;
        const sq = FILES[f] + r;
        const el = document.createElement('div');
        el.className = 'sq ' + ((f + r) % 2 === 1 ? 'dark' : 'light');
        el.dataset.sq = sq;
        el.setAttribute('role', 'gridcell');
        el.setAttribute('aria-label', sq);
        let coords = '';
        if (y === 7) coords += `<span class="coord file">${FILES[f]}</span>`;
        if (x === 0) coords += `<span class="coord rank">${r}</span>`;
        el.innerHTML = `<div class="content"></div>${coords}`;
        el.firstChild.style.cssText = 'position:absolute;inset:0;display:grid;place-items:center;';
        board.appendChild(el);
        squares[sq] = el;
      }
    }
  }

  function parseFen(fen) {
    const out = {};
    const rows = fen.split(' ')[0].split('/');
    rows.forEach((row, i) => {
      let f = 0;
      for (const ch of row) {
        if (/\d/.test(ch)) f += Number(ch);
        else {
          out[FILES[f] + (8 - i)] = { color: ch === ch.toUpperCase() ? 'w' : 'b', type: ch.toLowerCase() };
          f++;
        }
      }
    });
    return out;
  }

  // ---------- voting helpers ----------
  function canVote() {
    return S && S.phase === 'voting';
  }
  function currentVote() {
    if (!myVote || !S) return null;
    return myVote.game === S.gameNumber && myVote.ply === S.ply && S.phase === 'voting' ? myVote.uci : null;
  }

  function sendVote(uci) {
    if (!canVote()) return;
    socket.emit('vote', uci, (res) => {
      if (!res || !res.ok) return toast((res && res.error) || 'Vote failed.');
      myVote = { uci: res.uci, game: res.game, ply: res.ply };
      const m = S.legal.find((l) => l.uci === uci);
      toast(`You voted ${m ? m.san : uci}`);
      render();
    });
  }

  function onSquareClick(sq) {
    hidePromo();
    if (!canVote()) return;
    if (selected) {
      const options = S.legal.filter((m) => m.from === selected && m.to === sq);
      if (options.length === 1) {
        selected = null;
        sendVote(options[0].uci);
        return renderBoard();
      }
      if (options.length > 1) return showPromo(selected, sq, options);
    }
    selected = S.legal.some((m) => m.from === sq) && selected !== sq ? sq : null;
    renderBoard();
  }

  function showPromo(from, to, options) {
    const promo = $('promo');
    const { x } = squareXY(to);
    promo.style.left = (x * 12.5) + '%';
    promo.style.top = '0';
    promo.style.width = '12.5%';
    promo.innerHTML = '';
    for (const type of ['q', 'r', 'b', 'n']) {
      const m = options.find((o) => o.promotion === type);
      if (!m) continue;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.title = 'Promote to ' + NAMES[type];
      btn.innerHTML = pieceSvg(S.peopleColor, type);
      btn.onclick = (e) => {
        e.stopPropagation();
        hidePromo();
        selected = null;
        sendVote(m.uci);
        renderBoard();
      };
      promo.appendChild(btn);
    }
    promo.hidden = false;
  }
  function hidePromo() {
    $('promo').hidden = true;
  }

  $('board').addEventListener('click', (e) => {
    const el = e.target.closest('.sq');
    if (el) onSquareClick(el.dataset.sq);
  });

  // ---------- rendering ----------
  function renderBoard() {
    if (!S) return;
    if (orientation !== S.peopleColor) {
      selected = null;
      buildBoard(S.peopleColor);
    }
    const pieces = parseFen(S.fen);
    const voting = canVote();
    const mine = currentVote();
    const targets = selected ? S.legal.filter((m) => m.from === selected) : [];
    const targetSet = new Set(targets.map((m) => m.to));
    const fromSet = new Set(voting ? S.legal.map((m) => m.from) : []);

    $('board').classList.toggle('can-vote', voting);

    for (const sq in squares) {
      const el = squares[sq];
      const p = pieces[sq];
      el.classList.toggle('last', !!(S.lastMove && (S.lastMove.from === sq || S.lastMove.to === sq)));
      el.classList.toggle('selected', selected === sq);
      el.classList.toggle('check', S.checkSquare === sq);
      el.classList.toggle('own', fromSet.has(sq));
      el.classList.toggle('target', targetSet.has(sq));
      el.classList.toggle('mine', !!mine && (mine.slice(0, 2) === sq || mine.slice(2, 4) === sq));
      let html = p ? pieceSvg(p.color, p.type) : '';
      if (targetSet.has(sq)) html += `<span class="hint${p ? ' capture' : ''}"></span>`;
      const content = el.firstChild;
      if (content.dataset.html !== html) {
        content.innerHTML = html;
        content.dataset.html = html;
      }
    }
    animateLastMove();
    renderArrows();
  }

  // One arrow per voted move (up to 8). The arrow ends in a round bubble on
  // the target square that shows how many votes that move has.
  function renderArrows() {
    const svg = $('arrows');
    if (!S || S.phase !== 'voting' || !S.votes.length) {
      svg.innerHTML = '';
      return;
    }
    const total = S.votes.reduce((a, v) => a + v.count, 0);
    const mine = currentVote();
    const shown = S.votes.slice(0, 8);
    let lines = '';
    let bubbles = '';
    // Draw weaker moves first so the leader sits on top.
    for (let i = shown.length - 1; i >= 0; i--) {
      const v = shown[i];
      const a = squareXY(v.uci.slice(0, 2));
      const b = squareXY(v.uci.slice(2, 4));
      const x1 = a.x + 0.5, y1 = a.y + 0.5, x2 = b.x + 0.5, y2 = b.y + 0.5;
      const len = Math.hypot(x2 - x1, y2 - y1);
      const ux = (x2 - x1) / len, uy = (y2 - y1) / len;
      const r = 0.25; // bubble radius
      const headLen = 0.24, headW = 0.17;
      const tipX = x2 - ux * r, tipY = y2 - uy * r;
      const baseX = tipX - ux * headLen, baseY = tipY - uy * headLen;
      const leader = i === 0;
      const color = leader ? '#1f8a5b' : '#3b2a1a';
      const op = leader ? 0.95 : 0.55 + 0.35 * (v.count / total);
      const w = leader ? 0.15 : 0.1;
      lines += `<g opacity="${op.toFixed(2)}">` +
        `<line x1="${x1}" y1="${y1}" x2="${baseX}" y2="${baseY}" stroke="${color}" stroke-width="${w}" stroke-linecap="round"/>` +
        `<polygon points="${tipX},${tipY} ${baseX - uy * headW},${baseY + ux * headW} ${baseX + uy * headW},${baseY - ux * headW}" fill="${color}"/>` +
        `</g>`;
      const ring = v.uci === mine ? '#4da3ff' : '#fff8ec';
      bubbles += `<g class="bubble"><title>${v.san}: ${v.count} vote${v.count === 1 ? '' : 's'}</title>` +
        `<circle cx="${x2}" cy="${y2}" r="${r}" fill="${color}" stroke="${ring}" stroke-width="0.05"/>` +
        `<text x="${x2}" y="${y2}" text-anchor="middle" dominant-baseline="central" font-size="${v.count > 99 ? 0.2 : 0.27}" font-weight="800" fill="#fff">${v.count}</text></g>`;
    }
    svg.innerHTML = lines + bubbles;
  }

  // Slide the piece that just moved from its old square to its new one.
  let animatedKey = null;
  function animateLastMove() {
    if (!S || !S.lastMove) return;
    const key = S.gameNumber + ':' + S.ply;
    if (animatedKey === null) { animatedKey = key; return; } // first paint: no animation
    if (key === animatedKey) return;
    animatedKey = key;
    const slides = [[S.lastMove.from, S.lastMove.to]];
    if (/^O-O/.test(S.lastMove.san)) {
      const rank = S.lastMove.to[1];
      slides.push(S.lastMove.san.startsWith('O-O-O') ? ['a' + rank, 'd' + rank] : ['h' + rank, 'f' + rank]);
    }
    for (const [from, to] of slides) slide(from, to);
  }
  function slide(from, to) {
    const sqEl = squares[to];
    const piece = sqEl && sqEl.querySelector('.piece');
    if (!piece) return;
    const a = squareXY(from), b = squareXY(to);
    piece.style.transition = 'none';
    piece.style.transform = `translate(${(a.x - b.x) * 100}%, ${(a.y - b.y) * 100}%)`;
    sqEl.style.zIndex = 4;
    void piece.getBoundingClientRect();
    piece.style.transition = 'transform 380ms cubic-bezier(.22,.8,.3,1)';
    piece.style.transform = '';
    setTimeout(() => { sqEl.style.zIndex = ''; }, 420);
  }

  function fmt(n) {
    return Number(n || 0).toLocaleString();
  }

  function setStat(id, value, bump) {
    const el = $(id);
    el.textContent = fmt(value);
    if (bump) {
      el.classList.remove('bump');
      void el.offsetWidth;
      el.classList.add('bump');
    }
  }

  function renderStats() {
    const st = S.stats;
    const prev = lastStats;
    setStat('stat-moves', st.totalMoves, prev && prev.totalMoves !== st.totalMoves);
    setStat('stat-people', st.peopleWins, prev && prev.peopleWins !== st.peopleWins);
    setStat('stat-engine', st.stockfishWins, prev && prev.stockfishWins !== st.stockfishWins);
    setStat('stat-draws', st.draws, prev && prev.draws !== st.draws);
    lastStats = st;
    const since = new Date(st.createdAt).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
    $('since').textContent =
      `Since ${since} · ${fmt(st.gamesPlayed)} games finished · ${fmt(st.totalVotes)} votes cast`;
    $('online').textContent = fmt(S.online);
  }

  function renderPanel() {
    const peopleWhite = S.peopleColor === 'w';
    $('game-label').textContent = `Game #${fmt(S.gameNumber)}`;
    $('people-color').textContent = peopleWhite ? '(White)' : '(Black)';
    $('skill').textContent = `(level ${S.config.skill})`;

    const engineTurn = S.phase === 'engine';
    $('thinking').hidden = !engineTurn;
    $('bar-top').classList.toggle('active', engineTurn);
    $('bar-bottom').classList.toggle('active', S.phase === 'voting');

    const title = $('status-title');
    const hint = $('status-hint');
    if (S.phase === 'voting') {
      title.textContent = S.deadline ? 'Voting is open' : 'Your move, people';
      const mine = currentVote();
      const mineSan = mine && (S.legal.find((m) => m.uci === mine) || {}).san;
      hint.textContent = mine
        ? `You voted ${mineSan}. You can change your vote until the timer ends.`
        : S.deadline
          ? 'Click a piece, then a square, to add your vote.'
          : `Click a piece, then a square. The first vote starts a ${S.config.voteSeconds % 60 === 0 ? S.config.voteSeconds / 60 + '-minute' : S.config.voteSeconds + '-second'} countdown.`;
    } else if (S.phase === 'engine') {
      title.textContent = 'Stockfish is thinking…';
      hint.textContent = S.lastMove && S.lastMove.by === 'people'
        ? `People played ${S.lastMove.san} with ${S.lastMove.votes} of ${S.lastMove.voters} vote${S.lastMove.voters === 1 ? '' : 's'}.`
        : '';
    } else {
      title.textContent = 'Game over';
      hint.textContent = 'A new game starts soon. People switch colours each game.';
    }

    // votes
    const total = S.votes.reduce((a, v) => a + v.count, 0);
    $('voter-count').textContent = S.phase === 'voting' && total ? `${fmt(total)} vote${total === 1 ? '' : 's'}` : '';
    const mine = currentVote();
    const list = $('votes');
    list.innerHTML = '';
    if (S.phase === 'voting') {
      S.votes.forEach((v, i) => {
        const li = document.createElement('li');
        li.className = 'vote' + (i === 0 ? ' leader' : '') + (v.uci === mine ? ' mine' : '');
        li.title = 'Vote for ' + v.san;
        const pct = total ? Math.round((v.count / total) * 100) : 0;
        li.innerHTML = `<div class="vote-bar" style="width:${pct}%"></div><span class="vote-san"></span><span class="vote-count">${v.count} · ${pct}%</span>`;
        li.querySelector('.vote-san').textContent = v.san;
        li.onclick = () => sendVote(v.uci);
        list.appendChild(li);
      });
    }
    const emptyEl = $('votes-empty');
    emptyEl.hidden = S.phase === 'voting' && S.votes.length > 0;
    emptyEl.textContent = S.phase === 'voting'
      ? 'No votes yet. Pick a move on the board to start the round.'
      : S.phase === 'engine' ? 'Voting opens again after Stockfish moves.' : 'Voting opens when the next game starts.';

    // move list
    const moves = $('moves');
    moves.innerHTML = '';
    S.history.forEach((san, i) => {
      if (i % 2 === 0) {
        const n = document.createElement('li');
        n.className = 'num';
        n.textContent = i / 2 + 1 + '.';
        moves.appendChild(n);
      }
      const li = document.createElement('li');
      const byPeople = (i % 2 === 0) === peopleWhite;
      li.className = 'ply' + (byPeople ? ' people' : '') + (i === S.history.length - 1 ? ' latest' : '');
      li.textContent = san;
      moves.appendChild(li);
    });
    if (!S.history.length) {
      const li = document.createElement('li');
      li.style.gridColumn = '1 / -1';
      li.className = 'num';
      li.textContent = 'No moves yet.';
      moves.appendChild(li);
    }
    moves.scrollTop = moves.scrollHeight;

    // recent games
    const recent = $('recent');
    recent.innerHTML = '';
    S.recentGames.forEach((g) => {
      const li = document.createElement('li');
      const label = g.winner === 'people' ? 'People won' : g.winner === 'stockfish' ? 'Stockfish won' : 'Draw';
      li.innerHTML = `<span>#${fmt(g.number)} <span class="muted">· ${g.peopleColor === 'w' ? 'White' : 'Black'} · ${g.reason} · ${Math.ceil(g.moves / 2)} moves</span></span><span class="badge ${g.winner}">${label}</span>`;
      recent.appendChild(li);
    });
    $('recent-empty').hidden = S.recentGames.length > 0;

    // game over overlay
    const overlay = $('overlay');
    if (S.phase === 'gameover' && S.result) {
      const t = $('overlay-title');
      t.className = 'overlay-title ' + S.result.winner;
      t.textContent = S.result.winner === 'people' ? 'People win!' : S.result.winner === 'stockfish' ? 'Stockfish wins' : 'Draw';
      $('overlay-sub').textContent = `Game #${fmt(S.result.gameNumber)} ended by ${S.result.reason}.`;
      overlay.hidden = false;
    } else {
      overlay.hidden = true;
    }
  }

  function render() {
    if (!S) return;
    if (S.phase !== 'voting') {
      selected = null;
      hidePromo();
    }
    if (selected && !S.legal.some((m) => m.from === selected)) selected = null;
    renderBoard();
    renderStats();
    renderPanel();
    tick();
  }

  // ---------- countdown ----------
  function tick() {
    if (!S) return;
    const now = Date.now() + clockOffset;
    const timer = $('timer');
    const bar = $('progress');
    if (S.phase === 'voting' && S.deadline) {
      const left = Math.max(0, S.deadline - now);
      const secs = Math.ceil(left / 1000);
      timer.textContent = secs >= 60 ? `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}` : secs + 's';
      timer.classList.toggle('urgent', secs <= 10);
      bar.style.width = (100 * left / (S.config.voteSeconds * 1000)) + '%';
    } else if (S.phase === 'gameover' && S.nextGameAt) {
      const secs = Math.max(0, Math.ceil((S.nextGameAt - now) / 1000));
      timer.textContent = secs + 's';
      timer.classList.remove('urgent');
      bar.style.width = '0%';
      $('overlay-next').textContent = `Next game in ${secs}s`;
    } else {
      timer.textContent = '';
      bar.style.width = S.phase === 'engine' ? '100%' : '0%';
    }
  }
  setInterval(tick, 250);

  // ---------- toast ----------
  let toastTimer;
  function toast(msg) {
    const el = $('toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
  }

  // ---------- socket ----------
  const socket = io({ auth: { voterId } });
  socket.on('state', (state) => {
    clockOffset = state.serverNow - Date.now();
    S = state;
    render();
  });
  socket.on('yourVote', (v) => {
    myVote = v;
    render();
  });
  socket.on('disconnect', () => {
    $('status-title').textContent = 'Reconnecting…';
  });
})();
