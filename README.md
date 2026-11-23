# People vs Stockfish

A chess website where **everyone plays together against Stockfish**.

- When it's the people's turn, every visitor can vote for a move (click a piece, then a square).
- The first vote starts a countdown (20 s by default). Votes can be changed until it ends.
- The move with the most votes is played. A tie goes to the move that was suggested first.
- Stockfish answers, and the next voting round starts.
- When a game ends, a new one starts automatically and the people switch colours. It runs forever.
- All-time counters: **moves played since the site was created**, **People wins**, **Stockfish wins**, draws, games, votes.

Stockfish runs on the server (Stockfish 19 compiled to WebAssembly, so no native binary is needed).
The server decides everything, so visitors can't cheat by editing the page. Each browser gets one vote
per round, and at most 3 browsers per network (IP) can vote per round.

## Run it on your own computer (optional, for testing)

```bash
npm install
npm start
```

Open http://localhost:3000.

## Put it on the internet for free

You need three free accounts: **GitHub** (holds the code), **Render** (runs the website) and
**Upstash** (a small free database that keeps the counters safe). None of them need a credit card
for what this site uses.

### 1. Put the code on GitHub

Create a new repository on https://github.com/new and push this folder to it:

```bash
git init
git add .
git commit -m "People vs Stockfish"
git branch -M main
git remote add origin https://github.com/YOUR-NAME/people-vs-stockfish.git
git push -u origin main
```

### 2. Create the free database (Upstash Redis)

Render's free plan wipes its disk every time the site restarts, so the counters are stored in Upstash.

1. Sign up at https://upstash.com and choose **Create Database** → Redis. Pick any name and the region
   closest to your Render region. The free plan is enough.
2. Open the database and find the **REST API** section. Copy `UPSTASH_REDIS_REST_URL` and
   `UPSTASH_REDIS_REST_TOKEN`.

### 3. Deploy on Render

1. Sign up at https://render.com with your GitHub account.
2. Click **New** → **Blueprint**, pick your `people-vs-stockfish` repository. Render reads `render.yaml`.
3. Paste the two Upstash values when Render asks for them, then click **Apply**.
4. Wait for the first build (a few minutes). Your site will be at an address like
   `https://people-vs-stockfish.onrender.com`.

Every time you push to GitHub, Render redeploys automatically. The counters stay, because they live in Upstash.

### 4. Keep it awake 24/7 (free)

Render's free sites go to sleep after 15 minutes without visitors, and the first visitor then waits
about a minute for it to wake up. To keep it always on:

1. Sign up at https://uptimerobot.com (free).
2. **Add New Monitor** → type **HTTP(s)**, URL `https://YOUR-SITE.onrender.com/health`, interval **5 minutes**.

One always-on free Render site uses about 744 hours a month, which fits inside the 750 free hours.

### Other free hosts

The included `Dockerfile` works on any host that runs containers (for example Koyeb, Google Cloud Run,
or an Oracle Cloud "Always Free" VM). Set the same environment variables there.

## Settings (environment variables)

| Variable | Default | What it does |
| --- | --- | --- |
| `STOCKFISH_SKILL` | `10` | Stockfish strength, 0 (weakest) to 20 (full strength). |
| `ENGINE_MOVE_MS` | `1000` | How long Stockfish thinks per move, in milliseconds. |
| `VOTE_SECONDS` | `20` | Length of each voting round after the first vote. |
| `NEXT_GAME_SECONDS` | `15` | Pause between games. |
| `MAX_VOTERS_PER_IP` | `3` | How many different browsers on one network can vote per round. |
| `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` | – | Store the counters in Upstash Redis. Without them, a local file `data/state.json` is used. |
| `PORT` | `3000` | Port to listen on (hosts set this for you). |

At skill 20 the people will very rarely win. Lower `STOCKFISH_SKILL` if you want the People wins
counter to move once in a while.

## Files

- `server.js` – game loop, voting, counters, web server (Express + Socket.IO).
- `src/engine.js` – runs Stockfish and asks it for moves.
- `src/store.js` – saves state to a file and, if configured, Upstash Redis.
- `public/` – the website (board, vote list, counters).
- `scripts/bot-test.js` – development helper: fake voters that play random moves.

## Credits

Engine: [Stockfish.js](https://github.com/nmrugg/stockfish.js) (GPLv3). Chess rules:
[chess.js](https://github.com/jhlywa/chess.js). Pieces: Cburnett (CC BY-SA 3.0) via
[cm-chessboard](https://github.com/shaack/cm-chessboard).
