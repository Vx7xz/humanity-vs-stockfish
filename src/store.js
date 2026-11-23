// Persists the whole site state (counters + current game).
//
// Always writes a local JSON file. If UPSTASH_REDIS_REST_URL and
// UPSTASH_REDIS_REST_TOKEN are set, it also stores the state in Upstash Redis
// (free tier) so counters survive restarts/redeploys on hosts whose disk is
// wiped (e.g. Render's free plan).
import fs from 'node:fs';
import path from 'node:path';

const DATA_FILE = process.env.DATA_FILE || path.resolve('data', 'state.json');
const REDIS_URL = (process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/+$/, '');
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || '';
const KEY = process.env.STATE_KEY || 'people-vs-stockfish:state';
const useRedis = Boolean(REDIS_URL && REDIS_TOKEN);

export const storageMode = useRedis ? 'upstash-redis' : 'file';

async function redis(command, body) {
  const res = await fetch(`${REDIS_URL}/${command}/${encodeURIComponent(KEY)}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${REDIS_TOKEN}` },
    body,
  });
  if (!res.ok) throw new Error(`Upstash ${command} failed: HTTP ${res.status}`);
  return (await res.json()).result;
}

function readFile() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch {
    return null;
  }
}

export async function loadState() {
  if (useRedis) {
    // Retry a few times: if Redis is configured we must not silently start
    // from zero and then overwrite the real counters.
    for (let attempt = 1; ; attempt++) {
      try {
        const raw = await redis('get');
        return raw ? JSON.parse(raw) : readFile();
      } catch (err) {
        console.error(`[store] load attempt ${attempt} failed: ${err.message}`);
        if (attempt >= 5) throw err;
        await new Promise((r) => setTimeout(r, 2000 * attempt));
      }
    }
  }
  return readFile();
}

let chain = Promise.resolve();

export function saveState(state) {
  const json = JSON.stringify(state);
  try {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    fs.writeFileSync(DATA_FILE + '.tmp', json);
    fs.renameSync(DATA_FILE + '.tmp', DATA_FILE);
  } catch (err) {
    console.error(`[store] file write failed: ${err.message}`);
  }
  if (useRedis) {
    // Keep writes in order so an older state never overwrites a newer one.
    chain = chain
      .then(() => redis('set', json))
      .catch((err) => console.error(`[store] redis write failed: ${err.message}`));
  }
}
