// Thin wrapper around the Stockfish.js WASM engine, run as a child Node process
// that speaks UCI over stdin/stdout.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ENGINE_PATH = require('stockfish').findEngine(process.env.STOCKFISH_FLAVOR || 'lite-single');

export class Engine {
  constructor({ skill = 10 } = {}) {
    this.skill = skill;
    this.proc = null;
    this.pending = null;
    this.buffer = '';
    this.start();
  }

  start() {
    this.proc = spawn(process.execPath, [ENGINE_PATH], { stdio: ['pipe', 'pipe', 'inherit'] });
    this.buffer = '';
    const proc = this.proc;
    proc.stdout.on('data', (chunk) => {
      this.buffer += chunk.toString();
      let idx;
      while ((idx = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, idx).trim();
        this.buffer = this.buffer.slice(idx + 1);
        if (line) this.onLine(line);
      }
    });
    proc.on('exit', (code) => {
      if (this.proc !== proc) return;
      console.warn(`[engine] exited with code ${code}`);
      this.proc = null;
      this.fail(new Error('engine exited'));
    });
    proc.stdin.on('error', () => {});
    this.send('uci');
    this.send(`setoption name Skill Level value ${this.skill}`);
    this.send('isready');
  }

  restart() {
    const old = this.proc;
    this.proc = null;
    if (old) old.kill();
    this.start();
  }

  send(cmd) {
    if (this.proc) this.proc.stdin.write(cmd + '\n');
  }

  onLine(line) {
    if (!line.startsWith('bestmove') || !this.pending) return;
    const move = line.split(/\s+/)[1];
    const { resolve, reject, timer } = this.pending;
    clearTimeout(timer);
    this.pending = null;
    if (!move || move === '(none)') reject(new Error('engine returned no move'));
    else resolve(move);
  }

  fail(err) {
    if (!this.pending) return;
    clearTimeout(this.pending.timer);
    this.pending.reject(err);
    this.pending = null;
  }

  /** Returns the engine's chosen move in UCI notation (e.g. "e2e4", "e7e8q"). */
  bestMove(fen, movetimeMs) {
    if (!this.proc) this.start();
    this.fail(new Error('superseded'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending = null;
        reject(new Error('engine timeout'));
        this.restart();
      }, movetimeMs + 20000);
      this.pending = { resolve, reject, timer };
      this.send(`position fen ${fen}`);
      this.send(`go movetime ${movetimeMs}`);
    });
  }
}
