import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { greeting, suggestions, activityFeed, findCreations, stalledTasks, decisionsNeeded, nextActions } from '../cloudflare/activity.js';

const PORT = Number(process.env.CHE_PORT || 8787);
const SNAP = new URL('./snapshot.json', import.meta.url);

function load() {
  if (!existsSync(SNAP)) {
    return { team: [], team_tasks: [], projects: [], vault_items: [], jobs: [], meetings: [] };
  }
  return JSON.parse(readFileSync(SNAP, 'utf8'));
}

function save(data) {
  writeFileSync(SNAP, JSON.stringify(data, null, 2));
}

function json(res, body, code = 200) {
  const raw = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' });
  res.end(raw);
}

const server = createServer((req, res) => {
  const url = new URL(req.url || '/', `http://127.0.0.1:${PORT}`);
  const path = url.pathname;
  const data = load();

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'authorization,content-type',
      'access-control-allow-methods': 'GET,POST,OPTIONS',
    });
    return res.end();
  }

  if (req.method === 'GET' && path === '/api/stalled') return json(res, { items: stalledTasks(data) });
  if (req.method === 'GET' && path === '/api/decisions') return json(res, { items: decisionsNeeded(data) });
  if (req.method === 'GET' && path === '/api/next') return json(res, { actions: nextActions(data) });
  if (req.method === 'GET' && path === '/api/activity') {
    const limit = Math.max(1, Math.min(60, Number(url.searchParams.get('limit')) || 30));
    return json(res, { events: activityFeed(data, [], url.origin, limit) });
  }
  if (req.method === 'GET' && path === '/api/greeting') {
    const hour = Number(url.searchParams.get('hour'));
    return json(res, { ...greeting(data, [], { hour }), suggestions: suggestions(data, { hour }) });
  }
  if (req.method === 'GET' && path === '/api/find') {
    const q = String(url.searchParams.get('q') || '').slice(0, 200);
    return json(res, { items: findCreations(data, [], q, url.origin) });
  }
  if (req.method === 'POST' && path === '/api/snapshot') {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      try {
        const incoming = JSON.parse(raw || '{}');
        const next = load();
        for (const key of ['team', 'team_tasks', 'projects', 'vault_items', 'jobs', 'meetings']) {
          if (Array.isArray(incoming[key])) next[key] = incoming[key];
        }
        save(next);
        json(res, { ok: true });
      } catch {
        json(res, { detail: 'bad snapshot' }, 400);
      }
    });
    return;
  }
  json(res, { detail: 'not found' }, 404);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`CHE home base on http://0.0.0.0:${PORT}`);
});
