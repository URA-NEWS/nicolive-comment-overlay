const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const PORT = process.env.KOKUHATSU_PORT || 3942;
const OVERLAY_BASE = process.env.OVERLAY_BASE || 'http://localhost:3941';
const STATE_FILE = path.join(ROOT, 'kokuhatsu_state.json');

const defaultState = {
  day: '7',
  question: 'Day 7は告知回です。Day 6からゲーム開始。',
  choices: { A: 'A', B: 'B', C: 'C' },
  correct: '',
  route: [],
  keyword: '',
  misses: 0,
  prize: 100,
  revealResult: false,
  viewMode: 'question',
  ticker: '先着順ではありません。正解者から抽選で1名。',
};

function loadState() {
  try {
    return { ...defaultState, ...JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) };
  } catch {
    return { ...defaultState };
  }
}

let state = loadState();

function saveState() {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => {
      try { resolve(JSON.parse(data || '{}')); } catch { resolve({}); }
    });
  });
}

async function fetchExistingStatus() {
  try {
    const res = await fetch(`${OVERLAY_BASE}/api/overlay/status`);
    if (!res.ok) return null;
    const data = await res.json();
    return data.survey || null;
  } catch {
    return null;
  }
}

function majorityFromSurvey(survey) {
  if (!survey || !Array.isArray(survey.results) || survey.results.length === 0) return '';
  const sorted = survey.results.slice().sort((a, b) => b.count - a.count);
  if (!sorted[0] || sorted[0].count <= 0) return '';
  if (sorted[1] && sorted[1].count === sorted[0].count) return 'TIE';
  return sorted[0].key;
}

function publicState(survey) {
  return {
    ...state,
    prize: Math.max(0, 100 - Number(state.misses || 0) * 15),
    survey,
    majority: majorityFromSurvey(survey),
  };
}

function serve(res, file) {
  const html = fs.readFileSync(path.join(ROOT, file), 'utf8');
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(html);
}

function upstreamUnavailable(res) {
  res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ error: '既存コメントサーバーが起動していません' }));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if ((url.pathname === '/' || url.pathname === '/kokuhatsu-dock') && req.method === 'GET') {
    serve(res, 'kokuhatsu_dock.html');
    return;
  }

  if (url.pathname === '/kokuhatsu-overlay' && req.method === 'GET') {
    serve(res, 'kokuhatsu_overlay.html');
    return;
  }

  if (url.pathname === '/kokuhatsu-question' && req.method === 'GET') {
    serve(res, 'kokuhatsu_question.html');
    return;
  }

  if (url.pathname === '/kokuhatsu-amida' && req.method === 'GET') {
    serve(res, 'kokuhatsu_amida.html');
    return;
  }

  if (url.pathname === '/api/kokuhatsu/state' && req.method === 'GET') {
    const survey = await fetchExistingStatus();
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(publicState(survey)));
    return;
  }

  if (url.pathname === '/api/kokuhatsu/state' && req.method === 'POST') {
    const body = await readBody(req);
    state = {
      ...state,
      ...body,
      choices: { ...state.choices, ...(body.choices || {}) },
      route: Array.isArray(body.route) ? body.route.slice(0, 6) : state.route,
      misses: Math.min(6, Math.max(0, Number(body.misses ?? state.misses) || 0)),
      viewMode: ['question', 'amida', 'all'].includes(body.viewMode) ? body.viewMode : state.viewMode,
      question: String(body.question ?? state.question).slice(0, 500),
      keyword: String(body.keyword ?? state.keyword).slice(0, 12),
      ticker: String(body.ticker ?? state.ticker).slice(0, 120),
    };
    saveState();
    const survey = await fetchExistingStatus();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, state: publicState(survey) }));
    return;
  }

  if (url.pathname === '/api/kokuhatsu/survey/start' && req.method === 'POST') {
    const body = await readBody(req);
    const duration = Math.min(7200, Math.max(10, Number(body.duration) || 300));
    const options = [state.choices.A, state.choices.B, state.choices.C];
    try {
      const upstream = await fetch(`${OVERLAY_BASE}/api/overlay/survey/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ options, duration }),
      });
      const payload = await upstream.text();
      res.writeHead(upstream.status, { 'Content-Type': 'application/json' });
      res.end(payload);
    } catch {
      upstreamUnavailable(res);
    }
    return;
  }

  if (url.pathname === '/api/kokuhatsu/survey/stop' && req.method === 'POST') {
    try {
      const upstream = await fetch(`${OVERLAY_BASE}/api/overlay/survey/stop`, { method: 'POST' });
      const payload = await upstream.text();
      res.writeHead(upstream.status, { 'Content-Type': 'application/json' });
      res.end(payload);
    } catch {
      upstreamUnavailable(res);
    }
    return;
  }

  if (url.pathname === '/api/kokuhatsu/survey/clear' && req.method === 'POST') {
    try {
      const upstream = await fetch(`${OVERLAY_BASE}/api/overlay/survey/clear`, { method: 'POST' });
      const payload = await upstream.text();
      res.writeHead(upstream.status, { 'Content-Type': 'application/json' });
      res.end(payload);
    } catch {
      upstreamUnavailable(res);
    }
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not Found');
});

server.listen(PORT, () => {
  console.log(`告発ゲーム ドック: http://localhost:${PORT}/kokuhatsu-dock`);
  console.log(`告発ゲーム OBS  : http://localhost:${PORT}/kokuhatsu-overlay`);
  console.log(`既存コメントサーバー: ${OVERLAY_BASE}`);
});
