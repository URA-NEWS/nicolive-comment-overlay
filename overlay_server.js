// ============================================================
// ニコ生風コメントオーバーレイ - overlay_server.js
// 依存: なし(Node標準モジュールのみ)
//
// 起動: node overlay_server.js
//   コントロールドック: http://localhost:3941/dock
//   オーバーレイ画面  : http://localhost:3941/overlay-nico
//
// 環境変数(.envまたはRenderのダッシュボードで設定):
//   PORT               - 待受ポート(Renderが自動設定。ローカルは未設定なら3941)
//   KICK_CLIENT_ID     - Kick Developer APIのクライアントID
//   KICK_CLIENT_SECRET - Kick Developer APIのクライアントシークレット
//   GEMINI_API_KEY     - Gemini APIキー(未設定でもドックUIから設定可)
// ============================================================

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;

// ---------- .envファイル読み込み(依存ゼロ・ローカル開発用) ----------
// Renderなど本番環境では環境変数はダッシュボード側で設定するため、
// .envファイルが無くても何も起きない(存在すれば読み込むだけ)。
(function loadDotEnv() {
  const envPath = path.join(ROOT, '.env');
  try {
    const text = fs.readFileSync(envPath, 'utf8');
    for (const line of text.split('\n')) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      const key = m[1];
      let val = m[2];
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (process.env[key] === undefined) process.env[key] = val;
    }
  } catch {}
})();

const PORT = process.env.PORT || 3941;

// Renderの有料プランでPersistent Diskを追加した場合、環境変数DATA_DIRに
// そのマウントパス(例: /var/data)を設定すると、設定・コメント履歴(アイテム)・
// 配信統計を再デプロイでも消えないディスク側に保存する。
// 未設定時は従来通りアプリ本体と同じディレクトリに保存する(Render無料プランはここが再デプロイのたびに消える)。
const DATA_DIR = (process.env.DATA_DIR && process.env.DATA_DIR.trim()) ? process.env.DATA_DIR.trim() : ROOT;
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {}

const CONFIG_FILE = path.join(DATA_DIR, 'overlay_config.json');
const DEBUG_FILE = path.join(ROOT, 'debug_last.json'); // デバッグ用の一時ファイルなので永続化は不要
// curl.exeはWindows専用。本番(Render/Linux)ではcurlを使う
const CURL_BIN = process.platform === 'win32' ? 'curl.exe' : 'curl';

// Kick API認証情報(環境変数から取得。Renderの環境変数 or ローカルの.envに設定)
const KICK_CLIENT_ID = process.env.KICK_CLIENT_ID || '';
const KICK_CLIENT_SECRET = process.env.KICK_CLIENT_SECRET || '';

// ---------- config ----------
// 配信スケジュールは「週(月曜日付=YYYY-MM-DD)ごと」に内容を保持する。
// 週を切り替えて登録すればその週だけの内容として保存され、他の週には影響しない。
const SCHEDULE_DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
function mondayISO(date) {
  const day = date.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  const m = new Date(date.getFullYear(), date.getMonth(), date.getDate() + diff);
  const mm = String(m.getMonth() + 1).padStart(2, '0');
  const dd = String(m.getDate()).padStart(2, '0');
  return `${m.getFullYear()}-${mm}-${dd}`;
}
function sanitizeWeekMap(src) {
  const out = {};
  for (const key of SCHEDULE_DAYS) {
    const d = src && src[key];
    out[key] = {
      time: (d && typeof d.time === 'string') ? d.time.slice(0, 40) : '',
      text: (d && typeof d.text === 'string') ? d.text.slice(0, 100) : '',
      color: (d && typeof d.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(d.color)) ? d.color : '',
    };
  }
  return out;
}
function loadConfig() {
  try {
    const c = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    if (typeof c.liveId !== 'string') c.liveId = '';
    if (typeof c.speed !== 'number' || !(c.speed >= 2 && c.speed <= 20)) c.speed = 7;
    if (typeof c.kickSlug !== 'string') c.kickSlug = '';
    if (typeof c.kickChatroomId !== 'number' && typeof c.kickChatroomId !== 'string') c.kickChatroomId = '';
    if (c.verticalPos !== 'left' && c.verticalPos !== 'right') c.verticalPos = 'right';
    if (c.displayMode !== 'nico' && c.displayMode !== 'vertical') c.displayMode = 'nico';
    if (typeof c.bgOpacity !== 'number' || c.bgOpacity < 0 || c.bgOpacity > 100) c.bgOpacity = 55;
    if (typeof c.topic !== 'string') c.topic = '';
    if (typeof c.topicVisible !== 'boolean') c.topicVisible = false;
    if (typeof c.goalTarget !== 'number') c.goalTarget = 0;
    if (typeof c.goalRate !== 'number') c.goalRate = 1;
    if (typeof c.goalVisible !== 'boolean') c.goalVisible = false;
    if (typeof c.goalBaseline !== 'number') c.goalBaseline = 0;
    if (typeof c.geminiApiKey !== 'string') c.geminiApiKey = '';
    if (!['fw', 'kick', 'tiktok'].includes(c.commentSource)) c.commentSource = 'fw';
    // コメント欄に流すプラットフォームは複数選択可(チェックボックス化)。旧形式(単一文字列)は配列に移行
    if (!Array.isArray(c.commentSources) || !c.commentSources.every((s) => ['fw', 'kick', 'tiktok'].includes(s))) {
      c.commentSources = [c.commentSource];
    }
    c.commentSources = [...new Set(c.commentSources)];
    if (c.commentSources.length === 0) c.commentSources = [c.commentSource];
    if (typeof c.showFw !== 'boolean') c.showFw = true;
    if (typeof c.showKick !== 'boolean') c.showKick = true;
    if (typeof c.tiktokUsername !== 'string') c.tiktokUsername = '';
    if (typeof c.scheduleEnabled !== 'boolean') c.scheduleEnabled = true;
    // ''(または不正値) = 自動(実際の今週を表示)。"YYYY-MM-DD"(月曜日付) = その週を強制的に表示(下書きプレビュー用)
    if (typeof c.scheduleDisplayWeek !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(c.scheduleDisplayWeek)) c.scheduleDisplayWeek = '';
    if (typeof c.scheduleByWeek !== 'object' || c.scheduleByWeek === null) c.scheduleByWeek = {};
    // 旧形式(曜日テンプレートを全週共通で使い回す)からの移行: 既存の内容は「今週」の分として引き継ぐ
    if (typeof c.schedule === 'object' && c.schedule !== null) {
      const thisWeek = mondayISO(new Date());
      if (!c.scheduleByWeek[thisWeek]) c.scheduleByWeek[thisWeek] = sanitizeWeekMap(c.schedule);
      delete c.schedule;
    }
    for (const wk of Object.keys(c.scheduleByWeek)) {
      c.scheduleByWeek[wk] = sanitizeWeekMap(c.scheduleByWeek[wk]);
    }
    if (typeof c.scheduleStyle !== 'object' || c.scheduleStyle === null) c.scheduleStyle = {};
    if (typeof c.scheduleStyle.color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(c.scheduleStyle.color)) c.scheduleStyle.color = '#ffffff';
    if (typeof c.scheduleStyle.fontSize !== 'number' || c.scheduleStyle.fontSize < 10 || c.scheduleStyle.fontSize > 60) c.scheduleStyle.fontSize = 18;
    if (typeof c.scheduleStyle.opacity !== 'number' || c.scheduleStyle.opacity < 0 || c.scheduleStyle.opacity > 100) c.scheduleStyle.opacity = 70;
    if (typeof c.scheduleStyle.width !== 'number' || c.scheduleStyle.width < 120 || c.scheduleStyle.width > 2000) c.scheduleStyle.width = 420;
    if (typeof c.scheduleStyle.scale !== 'number' || c.scheduleStyle.scale < 50 || c.scheduleStyle.scale > 300) c.scheduleStyle.scale = 100;
    return c;
  } catch {
    return {
      liveId: '', speed: 7, kickSlug: '', verticalPos: 'right', displayMode: 'nico', bgOpacity: 55, topic: '', topicVisible: false, goalTarget: 0, goalRate: 1, goalVisible: false, goalBaseline: 0, geminiApiKey: '', commentSource: 'fw', commentSources: ['fw'], showFw: true, showKick: true, tiktokUsername: '',
      scheduleEnabled: true,
      scheduleDisplayWeek: '',
      scheduleByWeek: {},
      scheduleStyle: { color: '#ffffff', fontSize: 18, opacity: 70, width: 420, scale: 100 },
    };
  }
}
function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
}
let config = loadConfig();
// geminiApiKeyが未設定なら環境変数GEMINI_API_KEYをデフォルト値として使う
// (ドックUIで設定すればoverlay_config.json側が優先される)
if (!config.geminiApiKey && process.env.GEMINI_API_KEY) {
  config.geminiApiKey = process.env.GEMINI_API_KEY;
}

function extractLiveId(input) {
  if (!input) return '';
  const m = String(input).match(/(\d{5,})/g);
  if (m) return m[m.length - 1];
  return String(input).trim();
}

// ---------- アイテム検知 ----------
function detectItem(c) {
  const item = c.item || c.gift || c.present || c.sticker || c.stamp || null;
  if (item && typeof item === 'object') {
    return { isItem: true, label: item.name || item.title || item.id || 'アイテム', count: c.count || 1 };
  }
  if (c.type && /gift|item|present|sticker|stamp/i.test(String(c.type))) {
    return { isItem: true, label: String(c.type), count: 1 };
  }
  const text = c.text || c.message || '';

  // ふわっちAPI: アイテム付きコメントは <img src="URL" ...>アクション文 (NN点) の形式で届く
  const imgMatch = text.match(/<img[^>]*\bsrc=["']([^"']+)["'][^>]*>/i);
  if (imgMatch) {
    const imageUrl = imgMatch[1];
    let rest = text.replace(imgMatch[0], '').replace(/<[^>]+>/g, '').trim();
    let score = null;
    const scoreMatch = rest.match(/[\(（]\s*(\d+)\s*点\s*[\)）]\s*$/);
    if (scoreMatch) {
      score = parseInt(scoreMatch[1], 10);
      rest = rest.slice(0, scoreMatch.index).trim();
    }
    return { isItem: true, label: rest || 'アイテム', count: 1, imageUrl, score, actionText: rest };
  }

  let m = text.match(/^(.+?)[×x](\d+)\s*をプレゼントしました/);
  if (m) return { isItem: true, label: m[1], count: parseInt(m[2], 10) || 1 };
  m = text.match(/^(.+?)を(\d+)\s*(?:個|つ)プレゼントしました/);
  if (m) return { isItem: true, label: m[1], count: parseInt(m[2], 10) || 1 };
  m = text.match(/^(.+?)をプレゼントしました/);
  if (m) return { isItem: true, label: m[1], count: 1 };
  return { isItem: false, label: null, count: 1 };
}

// ---------- アイテム履歴(永続保存) ----------
const GIFT_LOG_FILE = path.join(DATA_DIR, 'gift_log.json');
function loadGiftLog() {
  try { return JSON.parse(fs.readFileSync(GIFT_LOG_FILE, 'utf8')); } catch { return []; }
}
function saveGiftLog() {
  try { fs.writeFileSync(GIFT_LOG_FILE, JSON.stringify(giftLog, null, 2), 'utf8'); } catch {}
}
let giftLog = loadGiftLog();

// ---------- コメント保持 ----------
let recentComments = [];
let fwLastUpdated = 0;
let commentIdCounter = 0;
let itemImageMap = {};

function addComment(obj) {
  collectVote(obj.name, obj.text);
  collectQuizVote(obj.name, obj.text);
  // 配信統計: コメントが多く流れたタイミングを後で特定するため、集計中の配信があれば1分単位でカウント(プラットフォーム別)
  if (currentStream && !statsPaused) {
    currentCommentTick.total++;
    if (obj.platform === 'fw') currentCommentTick.fw++;
    else if (obj.platform === 'kick') currentCommentTick.kick++;
    else if (obj.platform === 'tiktok') currentCommentTick.tiktok++;
  }
  commentIdCounter++;
  recentComments.push({ id: commentIdCounter, ts: Date.now(), ...obj });
  if (recentComments.length > 200) recentComments = recentComments.slice(-200);
  // アイテム系はgiftLogにも永続保存
  if (obj.isItem) {
    giftLog.push({
      ts: Date.now(),
      name: obj.name,
      item: obj.itemLabel || obj.text,
      count: obj.itemCount || 1,
      liveId: config.liveId,
    });
    if (giftLog.length > 5000) giftLog = giftLog.slice(-5000);
    saveGiftLog();
  }
}


// ============================================================
// アンケート機能
// ============================================================
let survey = null; // {optionA, optionB, startedAt, endsAt, votes:{name:'A'|'B'}, active}

function startSurvey(options, durationSec) {
  // options: ['乗らない','乗る', ...] 空文字は除外
  const keys = ['A', 'B', 'C', 'D'];
  const opts = {};
  (options || []).forEach((v, i) => {
    const t = String(v || '').trim();
    if (t && i < 4) opts[keys[i]] = t;
  });
  if (Object.keys(opts).length < 2) return false;
  survey = {
    options: opts,
    startedAt: Date.now(),
    durationSec: durationSec || 60,
    endsAt: Date.now() + (durationSec || 60) * 1000,
    votes: {},
    active: true,
    finished: false,
  };
  console.log(`[アンケート] 開始: ${Object.entries(opts).map(([k, v]) => k + '=' + v).join(' / ')} (${durationSec}秒)`);
  return true;
}

function stopSurvey() {
  if (survey) { survey.active = false; survey.finished = true; }
}

function clearSurvey() {
  survey = null;
}

// コメントから投票を拾う(1人1票・先着のみ有効)
function collectVote(name, text) {
  if (!survey || !survey.active) return;
  if (Date.now() > survey.endsAt) { stopSurvey(); return; }
  let t = String(text || '').trim().toUpperCase();
  // 全角英字を半角に
  t = t.replace(/[Ａ-Ｄ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
  if (!/^[ABCD]$/.test(t)) return;
  if (!survey.options[t]) return; // 未使用の選択肢は無効
  const key = String(name || '?');
  if (survey.votes[key] !== undefined) return; // 1人1票
  survey.votes[key] = t;
}

function surveyState() {
  if (!survey) return null;
  if (survey.active && Date.now() > survey.endsAt) stopSurvey();
  const counts = {};
  for (const k of Object.keys(survey.options)) counts[k] = 0;
  for (const v of Object.values(survey.votes)) {
    if (counts[v] !== undefined) counts[v]++;
  }
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const results = Object.keys(survey.options).map((k) => ({
    key: k,
    label: survey.options[k],
    count: counts[k],
    pct: total ? Math.round((counts[k] / total) * 100) : 0,
  }));
  return {
    results,
    total,
    active: survey.active,
    finished: survey.finished,
    durationSec: survey.durationSec,
    remainSec: survey.active ? Math.max(0, Math.ceil((survey.endsAt - Date.now()) / 1000)) : 0,
  };
}


// ============================================================
// クイズ機能(ミリオネア風)
// ============================================================
let quiz = null; // {question, options:{A..D}, correct, revealed, votes:{}}

function showQuiz(question, options, correct) {
  const keys = ['A', 'B', 'C', 'D'];
  const opts = {};
  (options || []).forEach((v, i) => {
    const t = String(v || '').trim();
    if (t && i < 4) opts[keys[i]] = t;
  });
  if (!question || Object.keys(opts).length < 2) return false;
  quiz = {
    question: String(question).slice(0, 300),
    options: opts,
    correct: keys.includes(correct) && opts[correct] ? correct : null,
    revealed: false,
    votes: {},
    audience: 'idle',   // idle | voting | done
    audienceEndsAt: 0,
    audienceDuration: 60,
  };
  console.log(`[クイズ] 出題: ${quiz.question} (正解: ${quiz.correct || '未設定'})`);
  return true;
}

function revealQuiz() {
  if (quiz) quiz.revealed = true;
}

function startAudience(durationSec) {
  if (!quiz) return false;
  quiz.votes = {};              // カウントダウン中のコメントだけ拾う
  quiz.audience = 'voting';
  quiz.audienceDuration = durationSec || 60;
  quiz.audienceEndsAt = Date.now() + quiz.audienceDuration * 1000;
  console.log(`[クイズ] オーディエンス開始 (${quiz.audienceDuration}秒)`);
  return true;
}

function stopAudience() {
  if (quiz && quiz.audience === 'voting') {
    quiz.audience = 'done';
    console.log('[クイズ] オーディエンス開票');
  }
}

function clearQuiz() {
  quiz = null;
}

function collectQuizVote(name, text) {
  if (!quiz) return;
  if (quiz.audience !== 'voting') return;      // カウントダウン中のみ有効
  if (Date.now() > quiz.audienceEndsAt) { stopAudience(); return; }
  let t = String(text || '').trim().toUpperCase();
  t = t.replace(/[Ａ-Ｄ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
  if (!/^[ABCD]$/.test(t)) return;
  if (!quiz.options[t]) return;
  const key = String(name || '?');
  if (quiz.votes[key] !== undefined) return;
  quiz.votes[key] = t;
}

function quizState() {
  if (!quiz) return null;
  if (quiz.audience === 'voting' && Date.now() > quiz.audienceEndsAt) stopAudience();
  const counts = {};
  for (const k of Object.keys(quiz.options)) counts[k] = 0;
  for (const v of Object.values(quiz.votes)) {
    if (counts[v] !== undefined) counts[v]++;
  }
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  return {
    question: quiz.question,
    results: Object.keys(quiz.options).map((k) => ({
      key: k,
      label: quiz.options[k],
      count: counts[k],
      pct: total ? Math.round((counts[k] / total) * 100) : 0,
    })),
    correct: quiz.revealed ? quiz.correct : null,
    revealed: quiz.revealed,
    total,
    audience: quiz.audience,
    audienceRemain: quiz.audience === 'voting'
      ? Math.max(0, Math.ceil((quiz.audienceEndsAt - Date.now()) / 1000)) : 0,
    audienceDuration: quiz.audienceDuration,
    showCounts: quiz.audience === 'done',
  };
}

// ============================================================
// ルーレット機能
// ============================================================
const ROULETTE_MAX_ITEMS = 30;
let roulette = {
  items: [],        // string[]
  visible: false,
  spinning: false,
  spinId: 0,        // 回すたびに+1。クライアント側でこの変化を検知してアニメ開始
  resultIndex: null,
  spinDurationMs: 6500,
  spinStartedAt: 0, // 回転開始時刻(ms epoch)。途中から見たクライアントの同期用
};
let rouletteSpinTimer = null;

function addRouletteItem(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  if (roulette.items.length >= ROULETTE_MAX_ITEMS) return false;
  roulette.items.push(t);
  return true;
}

function removeRouletteItem(index) {
  const i = Number(index);
  if (!Number.isInteger(i) || i < 0 || i >= roulette.items.length) return false;
  roulette.items.splice(i, 1);
  return true;
}

function resetRoulette() {
  roulette.items = [];
  roulette.spinning = false;
  roulette.resultIndex = null;
  clearTimeout(rouletteSpinTimer);
}

function spinRoulette() {
  if (roulette.items.length < 2 || roulette.spinning) return false;
  const winner = Math.floor(Math.random() * roulette.items.length);
  roulette.spinning = true;
  roulette.resultIndex = winner;
  roulette.spinId++;
  roulette.spinStartedAt = Date.now();
  clearTimeout(rouletteSpinTimer);
  rouletteSpinTimer = setTimeout(() => {
    roulette.spinning = false;
  }, roulette.spinDurationMs);
  return true;
}

function rouletteState() {
  return {
    items: roulette.items,
    visible: roulette.visible,
    spinning: roulette.spinning,
    spinId: roulette.spinId,
    resultIndex: roulette.resultIndex,
    spinDurationMs: roulette.spinDurationMs,
    spinStartedAt: roulette.spinStartedAt,
    maxItems: ROULETTE_MAX_ITEMS,
  };
}

// ---------- ふわっちポーリング ----------
async function pollFwComments() {
  if (!config.liveId) { fwViewerCount = null; fwLiveNow = false; return; }
  try {
    const url = `https://api.whowatch.tv/lives/${config.liveId}?last_updated_at=${fwLastUpdated}`;
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json',
        'Referer': 'https://whowatch.tv/',
      },
    });
    if (!res.ok) return;
    const d = await res.json();
    try { fs.writeFileSync(DEBUG_FILE, JSON.stringify(d, null, 2), 'utf8'); } catch {}
    // fwLiveNowは「今回の応答で配信中と確認できたか」を表す(統計の配信終了判定用)。
    // fwViewerCountはオーバーレイ表示用に直近の値を保持し続ける(配信終了直後もチラつかせないため)
    fwLiveNow = !!(d.live && Number.isFinite(Number(d.live.view_count)));
    if (d.live && Number.isFinite(Number(d.live.view_count))) {
      fwViewerCount = Number(d.live.view_count);
    }
    if (d.live) {
      const t = d.live.title || d.live.name || d.live.live_title;
      if (typeof t === 'string' && t) lastFwTitle = t;
    }
    if (Array.isArray(d.live_sent_items)) {
      for (const item of d.live_sent_items) {
        if (item && item.name && item.image_url) itemImageMap[item.name] = item.image_url;
      }
    }
    const comments = d.comments || [];
    if (d.updated_at) fwLastUpdated = d.updated_at;
    for (const c of comments) {
      const itemInfo = detectItem(c);
      let itemData = null;
      if (itemInfo.isItem) {
        const imageUrl = itemInfo.imageUrl || itemImageMap[itemInfo.label];
        if (imageUrl) itemData = { image_url: imageUrl };
      }
      addComment({
        name: c.name || c.user?.name || '?',
        text: itemInfo.isItem && itemInfo.actionText ? itemInfo.actionText : (c.text || c.message || ''),
        isItem: itemInfo.isItem,
        itemLabel: itemInfo.label,
        itemCount: itemInfo.count || 1,
        itemScore: itemInfo.score || null,
        itemData,
        isFollower: c.comment_type === 'BY_FOLLOWER',
        platform: 'fw',
      });
    }
  } catch (e) {
    console.error('[fwポーリング エラー]', e.message);
  }
}
setInterval(pollFwComments, 3000);

// ---------- ふわっちフォロワー数ポーリング ----------
const FW_PROFILE = 'w:equaleru';
let followerCount = null;
let fwViewerCount = null;
let kickFollowerCount = null;
let kickViewerCount = null;
let lastFwTitle = '';   // 配信統計での記録用(取得できた場合のみ)
let lastKickTitle = '';
let fwLiveNow = false;   // 直近のポーリングで「配信中」と確認できたか(配信終了の自動判定用)
let kickLiveNow = false;

// Kick: 閲覧数(公式API) + フォロワー数(v2/curl)
async function pollKickStats() {
  if (!config.kickSlug) { kickFollowerCount = null; kickViewerCount = null; kickLiveNow = false; return; }
  const slug = config.kickSlug;

  // 閲覧数: 公式API v1
  try {
    const token = await getKickAccessToken();
    if (token) {
      const res = await fetch(`https://api.kick.com/public/v1/channels?slug=${encodeURIComponent(slug)}`, {
        headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' },
      });
      if (res.ok) {
        const d = await res.json();
        const ch = (Array.isArray(d.data) ? d.data[0] : d.data) || d;
        const v = Number(ch?.stream?.viewer_count);
        kickLiveNow = !!ch?.stream?.is_live;
        kickViewerCount = ch?.stream?.is_live && Number.isFinite(v) ? v : null;
        // stream_titleはstreamのネストではなくチャンネル直下(公式API v1のスキーマ)
        const t = ch?.stream_title || ch?.stream?.stream_title || ch?.stream?.title;
        if (typeof t === 'string' && t) lastKickTitle = t;
      }
    }
  } catch (e) {}

  // フォロワー数: v2(fetch→curlフォールバック)
  try {
    let json = null;
    try {
      const res2 = await fetch(`https://kick.com/api/v2/channels/${encodeURIComponent(slug)}`, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
          'Accept': 'application/json, text/plain, */*',
          'Referer': `https://kick.com/${slug}`,
        },
      });
      if (res2.ok) {
        const t = await res2.text();
        try { json = JSON.parse(t); } catch {}
      }
    } catch {}
    if (!json) {
      const { execFile } = require('child_process');
      const out = await new Promise((resolve) => {
        execFile(CURL_BIN, [
          '-s', '--max-time', '10',
          '-H', 'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
          '-H', 'Accept: application/json',
          '-H', `Referer: https://kick.com/${slug}`,
          `https://kick.com/api/v2/channels/${slug}`,
        ], { windowsHide: true }, (err, stdout) => resolve(err ? '' : stdout));
      });
      if (out) { try { json = JSON.parse(out); } catch {} }
    }
    if (json) {
      const f = Number(json.followers_count);
      if (Number.isFinite(f)) kickFollowerCount = f;
    }
  } catch (e) {}
}
setInterval(pollKickStats, 15000);
setTimeout(pollKickStats, 3000);

async function pollFollowerCount() {
  if (!config.liveId) { followerCount = null; return; }
  try {
    const res = await fetch(`https://api.whowatch.tv/users/${FW_PROFILE}/profile`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json',
        'Referer': 'https://whowatch.tv/',
      },
    });
    if (!res.ok) return;
    const d = await res.json();
    const count = Number(d.follower_count);
    if (Number.isFinite(count) && count >= 0 && count !== followerCount) {
      if (followerCount !== null) console.log(`[フォロワー] ${followerCount} → ${count}`);
      followerCount = count;
    }
  } catch (e) {}
}
pollFollowerCount();
setInterval(pollFollowerCount, 5000);

// ============================================================
// 配信統計(時間毎の閲覧数・配信毎のフォロワー数を記録)
// ============================================================
const STATS_FILE = path.join(DATA_DIR, 'stats_history.json');
const STATS_TICK_MS = 60 * 1000;              // 生存確認(配信中か)の間隔
const STATS_SAMPLE_MS = 60 * 1000;            // 閲覧数サンプリング間隔(1分。実際の閲覧数は3〜15秒おきに取得済みのため追加通信なし)
const STATS_OFFLINE_GRACE_MS = 5 * 60 * 1000; // 両プラットフォームがこの時間非配信なら「配信終了」
const STATS_MAX_STREAMS = 300;                // 保持する配信記録の上限件数(古い順に削除)

function loadStats() {
  try {
    const s = JSON.parse(fs.readFileSync(STATS_FILE, 'utf8'));
    if (!Array.isArray(s.streams)) s.streams = [];
    return s;
  } catch { return { streams: [] }; }
}
function saveStats() {
  try { fs.writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2), 'utf8'); } catch {}
}
let stats = loadStats();

// JST(UTC+9)基準の日付文字列(YYYY-MM-DD)。Render等サーバーのタイムゾーンに関わらず
// 日本の配信者にとって自然な「配信日」の区切りになるよう明示的に変換する。
function toJstDateStr(ms) {
  return new Date(ms + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

let currentStream = null;    // 進行中の配信レコード(stats.streamsの末尾要素への参照)
let statsOfflineTicks = 0;
let statsPaused = false;     // ドックの「計測を停止」スイッチ。trueの間は自動開始/終了判定を止める
let currentCommentTick = { total: 0, fw: 0, kick: 0, tiktok: 0 }; // 直近1分間のコメント/ギフト等の件数(プラットフォーム別・addCommentでカウント)

// サーバー再起動/redeployで正常終了できなかった配信記録が残っていたら、その時点で確定させる
(function recoverUnfinishedStream() {
  const last = stats.streams[stats.streams.length - 1];
  if (last && last.endedAt === null) {
    const lastSample = last.samples[last.samples.length - 1];
    last.endedAt = lastSample ? lastSample.t : last.startedAt;
    if (last.fwFollowerEnd === null) last.fwFollowerEnd = last.fwFollowerStart;
    if (last.kickFollowerEnd === null) last.kickFollowerEnd = last.kickFollowerStart;
    last.note = 'サーバー再起動により自動終了';
    saveStats();
  }
})();

function newStreamRecord() {
  return {
    id: `s${Date.now()}`,
    startedAt: Date.now(),
    endedAt: null,
    fwLiveId: config.liveId || '',
    kickSlug: config.kickSlug || '',
    fwTitle: lastFwTitle || '',
    kickTitle: lastKickTitle || '',
    fwFollowerStart: followerCount,
    kickFollowerStart: kickFollowerCount,
    fwFollowerEnd: null,
    kickFollowerEnd: null,
    peakFwViewers: null,
    peakKickViewers: null,
    sumFwViewers: 0, countFwViewers: 0,
    sumKickViewers: 0, countKickViewers: 0,
    samples: [], // {t, fw, kick} を1分おきに追加
    commentBuckets: [], // {t, count} コメント/ギフト等の件数を1分おきに追加(盛り上がりタイミング特定用)
  };
}

function finalizeCurrentStream() {
  if (!currentStream) return;
  currentStream.endedAt = Date.now();
  currentStream.fwFollowerEnd = followerCount;
  currentStream.kickFollowerEnd = kickFollowerCount;
  console.log(`[統計] 配信記録を終了: ${currentStream.id}`);
  currentStream = null;
  statsOfflineTicks = 0;
  saveStats();
}

function statsTick() {
  // コメント件数の1分バケットは、集計中の配信がある限り(一時停止中でも)そのまま積み立てる
  if (currentStream) {
    currentStream.commentBuckets.push({
      t: Date.now(),
      count: currentCommentTick.total,
      fw: currentCommentTick.fw,
      kick: currentCommentTick.kick,
      tiktok: currentCommentTick.tiktok,
    });
    if (currentStream.commentBuckets.length > 1000) currentStream.commentBuckets = currentStream.commentBuckets.slice(-1000);
    currentCommentTick = { total: 0, fw: 0, kick: 0, tiktok: 0 };
  }
  if (statsPaused) return; // 手動停止中は自動開始/終了判定を行わない
  // 表示用のfwViewerCount/kickViewerCountは配信終了直後も直近値を保持することがあるため、
  // 「今回のポーリングで実際に生存確認できたか」を表すfwLiveNow/kickLiveNowで判定する
  const isLive = fwLiveNow || kickLiveNow;
  if (isLive) {
    statsOfflineTicks = 0;
    if (!currentStream) {
      currentStream = newStreamRecord();
      stats.streams.push(currentStream);
      if (stats.streams.length > STATS_MAX_STREAMS) stats.streams = stats.streams.slice(-STATS_MAX_STREAMS);
      console.log(`[統計] 配信記録を開始: ${currentStream.id}`);
      saveStats();
    } else {
      // タイトルは配信開始直後に取得できないことがあるため随時更新
      if (lastFwTitle) currentStream.fwTitle = lastFwTitle;
      if (lastKickTitle) currentStream.kickTitle = lastKickTitle;
    }
  } else if (currentStream) {
    statsOfflineTicks++;
    if (statsOfflineTicks * STATS_TICK_MS >= STATS_OFFLINE_GRACE_MS) {
      finalizeCurrentStream();
    }
  }
}
setInterval(statsTick, STATS_TICK_MS);
statsTick();

function statsSampleTick() {
  if (!currentStream) return;
  // fwLiveNow/kickLiveNowで実際に生存確認できている値だけを集計対象にする
  // (配信終了直後の猶予期間中は表示用キャッシュ値が古いまま残っている場合があるため)
  const sampleFw = fwLiveNow ? fwViewerCount : null;
  const sampleKick = kickLiveNow ? kickViewerCount : null;
  // フォロワー数の推移グラフ用に、閲覧数と同じタイミングでフォロワー数もサンプリングしておく
  currentStream.samples.push({
    t: Date.now(),
    fw: sampleFw,
    kick: sampleKick,
    fwFollower: followerCount,
    kickFollower: kickFollowerCount,
  });
  if (currentStream.samples.length > 500) currentStream.samples = currentStream.samples.slice(-500);
  if (sampleFw !== null) {
    currentStream.sumFwViewers += sampleFw;
    currentStream.countFwViewers += 1;
    if (currentStream.peakFwViewers === null || sampleFw > currentStream.peakFwViewers) currentStream.peakFwViewers = sampleFw;
  }
  if (sampleKick !== null) {
    currentStream.sumKickViewers += sampleKick;
    currentStream.countKickViewers += 1;
    if (currentStream.peakKickViewers === null || sampleKick > currentStream.peakKickViewers) currentStream.peakKickViewers = sampleKick;
  }
  // 途中終了時の保険として、フォロワー数の最新値を随時「終了時点の値」として更新しておく
  currentStream.fwFollowerEnd = followerCount;
  currentStream.kickFollowerEnd = kickFollowerCount;
  saveStats();
}
setInterval(statsSampleTick, STATS_SAMPLE_MS);

function summarizeStream(s, includeSamples) {
  const avgFw = s.countFwViewers ? Math.round(s.sumFwViewers / s.countFwViewers) : null;
  const avgKick = s.countKickViewers ? Math.round(s.sumKickViewers / s.countKickViewers) : null;
  // コメント/ギフト等が最も多く流れた1分間を特定
  let peakCommentBucket = null;
  for (const b of (s.commentBuckets || [])) {
    if (b.count > 0 && (!peakCommentBucket || b.count > peakCommentBucket.count)) peakCommentBucket = b;
  }
  const out = {
    id: s.id,
    startedAt: s.startedAt,
    endedAt: s.endedAt,
    live: s.endedAt === null,
    date: toJstDateStr(s.startedAt),
    fwLiveId: s.fwLiveId,
    kickSlug: s.kickSlug,
    fwTitle: s.fwTitle,
    kickTitle: s.kickTitle,
    fwFollowerStart: s.fwFollowerStart,
    fwFollowerEnd: s.fwFollowerEnd,
    kickFollowerStart: s.kickFollowerStart,
    kickFollowerEnd: s.kickFollowerEnd,
    fwFollowerGain: (s.fwFollowerStart != null && s.fwFollowerEnd != null) ? (s.fwFollowerEnd - s.fwFollowerStart) : null,
    kickFollowerGain: (s.kickFollowerStart != null && s.kickFollowerEnd != null) ? (s.kickFollowerEnd - s.kickFollowerStart) : null,
    peakFwViewers: s.peakFwViewers,
    peakKickViewers: s.peakKickViewers,
    avgFwViewers: avgFw,
    avgKickViewers: avgKick,
    durationMs: (s.endedAt || Date.now()) - s.startedAt,
    peakCommentAt: peakCommentBucket ? peakCommentBucket.t : null,
    peakCommentCount: peakCommentBucket ? peakCommentBucket.count : 0,
    note: s.note || '',
  };
  if (includeSamples) {
    out.samples = s.samples;
    out.commentBuckets = s.commentBuckets;
  }
  return out;
}

// ---------- ギフト受信(ユーザースクリプト) ----------
function handleIncomingGift(msg) {
  if (!msg) return;
  addComment({
    name: msg.user || '?',
    text: `${msg.item || 'アイテム'} ×${msg.count || 1}`,
    isItem: true,
    itemLabel: msg.item || 'アイテム',
    itemCount: msg.count || 1,
    itemData: msg.itemData || null,
    platform: 'fw',
  });
  try { fs.writeFileSync(path.join(ROOT, 'debug_gift.json'), JSON.stringify(msg, null, 2), 'utf8'); } catch {}
}

// ============================================================
// Kick対応
// ============================================================
let kickAccessToken = null;
let kickTokenExpiresAt = 0;
let kickWs = null;
let kickReconnectTimer = null;
let kickChatroomId = null;

async function getKickAccessToken() {
  if (kickAccessToken && Date.now() < kickTokenExpiresAt - 30000) return kickAccessToken;
  try {
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: KICK_CLIENT_ID,
      client_secret: KICK_CLIENT_SECRET,
    }).toString();
    const res = await fetch('https://id.kick.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
      body,
    });
    if (!res.ok) { console.error('[Kick OAuth] HTTP', res.status); return null; }
    const d = await res.json();
    kickAccessToken = d.access_token;
    kickTokenExpiresAt = Date.now() + (parseInt(d.expires_in) || 3600) * 1000;
    console.log('[Kick OAuth] token取得完了');
    return kickAccessToken;
  } catch (e) {
    console.error('[Kick OAuth] error:', e.message);
    return null;
  }
}

async function getKickChatroomId(slug) {
  // 1) 公式API (App Access Token)
  try {
    const token = await getKickAccessToken();
    if (token) {
      const res = await fetch(`https://api.kick.com/public/v1/channels?slug=${encodeURIComponent(slug)}`, {
        headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' },
      });
      if (res.ok) {
        const d = await res.json();
        console.log('[Kick API v1] 応答:', JSON.stringify(d).slice(0, 300));
        const channel = (Array.isArray(d.data) ? d.data[0] : d.data) || d;
        const chatroomId = channel?.chatroom?.id || channel?.chatroom_id || null;
        if (chatroomId) {
          console.log(`[Kick] chatroomId(v1): ${chatroomId}`);
          return chatroomId;
        }
        console.log('[Kick] v1応答にchatroomIDなし。v2を試します');
      } else {
        console.error('[Kick API v1] HTTP', res.status);
      }
    }
  } catch (e) {
    console.error('[Kick API v1] error:', e.message);
  }

  // 2) 非公式API (kick.com/api/v2) フォールバック
  try {
    const res2 = await fetch(`https://kick.com/api/v2/channels/${encodeURIComponent(slug)}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'ja,en;q=0.9',
        'Referer': `https://kick.com/${slug}`,
      },
    });
    if (!res2.ok) {
      console.error('[Kick API v2] HTTP', res2.status);
    } else {
      const text = await res2.text();
      try {
        const d2 = JSON.parse(text);
        const chatroomId = d2?.chatroom?.id || null;
        if (chatroomId) {
          console.log(`[Kick] chatroomId(v2): ${chatroomId}`);
          return chatroomId;
        }
        console.error('[Kick API v2] 応答にchatroomIDなし:', text.slice(0, 200));
      } catch {
        console.error('[Kick API v2] JSON以外の応答(Cloudflareブロックの可能性):', text.slice(0, 120));
      }
    }
  } catch (e) {
    console.error('[Kick API v2] error:', e.message);
  }

  // 3) Windows curl.exe フォールバック(TLS指紋がNodeと異なるため通る場合がある)
  try {
    const { execFile } = require('child_process');
    const out = await new Promise((resolve) => {
      execFile(CURL_BIN, [
        '-s', '--max-time', '10',
        '-H', 'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        '-H', 'Accept: application/json',
        '-H', `Referer: https://kick.com/${slug}`,
        `https://kick.com/api/v2/channels/${slug}`,
      ], { windowsHide: true }, (err, stdout) => resolve(err ? '' : stdout));
    });
    if (out) {
      try {
        const d3 = JSON.parse(out);
        const chatroomId = d3?.chatroom?.id || null;
        if (chatroomId) {
          console.log(`[Kick] chatroomId(curl): ${chatroomId}`);
          config.kickChatroomId = String(chatroomId);
          saveConfig(config);
          return chatroomId;
        }
        console.error('[Kick curl] 応答にchatroomIDなし');
      } catch {
        console.error('[Kick curl] JSON以外の応答(Cloudflareブロック)');
      }
    }
  } catch (e) {
    console.error('[Kick curl] error:', e.message);
  }
  return null;
}

async function connectKickChat(slug) {
  if (!slug && !config.kickChatroomId) return;
  if (kickWs) { try { kickWs.destroy(); } catch {} kickWs = null; }
  clearTimeout(kickReconnectTimer);

  // 手動設定のchatroomIDがあれば最優先で使う
  let chatroomId = config.kickChatroomId ? Number(config.kickChatroomId) : null;
  if (!chatroomId) {
    chatroomId = await getKickChatroomId(slug);
  } else {
    console.log(`[Kick] 手動設定のchatroomIDを使用: ${chatroomId}`);
  }
  if (!chatroomId) {
    console.error('[Kick] chatroomId取得失敗。60秒後にリトライ');
    kickReconnectTimer = setTimeout(() => connectKickChat(slug), 60000);
    return;
  }
  kickChatroomId = chatroomId;

  // ---- 依存ゼロWebSocketクライアント(tls直接続) ----
  const tls = require('tls');
  const wsCrypto = require('crypto');
  const PUSHER_APP_KEY = '32cbd69e4b950bf97679';
  const HOST = 'ws-us2.pusher.com';
  const PATH = `/app/${PUSHER_APP_KEY}?protocol=7&client=js&version=7.4.0&flash=false`;

  console.log(`[Kick] Pusher接続中... chatroom: ${chatroomId}`);

  const socket = tls.connect(443, HOST, { servername: HOST }, () => {
    const key = wsCrypto.randomBytes(16).toString('base64');
    socket.write(
      `GET ${PATH} HTTP/1.1\r\n` +
      `Host: ${HOST}\r\n` +
      `Upgrade: websocket\r\n` +
      `Connection: Upgrade\r\n` +
      `Sec-WebSocket-Key: ${key}\r\n` +
      `Sec-WebSocket-Version: 13\r\n` +
      `Origin: https://kick.com\r\n\r\n`
    );
  });
  kickWs = socket;

  function wsSendText(str) {
    const payload = Buffer.from(str, 'utf8');
    const mask = wsCrypto.randomBytes(4);
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.alloc(2);
      header[0] = 0x81;
      header[1] = 0x80 | len;
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x81;
      header[1] = 0x80 | 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x81;
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    const masked = Buffer.alloc(len);
    for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i % 4];
    socket.write(Buffer.concat([header, mask, masked]));
  }

  function wsSendPong(payload) {
    const mask = wsCrypto.randomBytes(4);
    const len = payload.length;
    const header = Buffer.from([0x8A, 0x80 | len]);
    const masked = Buffer.alloc(len);
    for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i % 4];
    socket.write(Buffer.concat([header, mask, masked]));
  }

  let handshakeDone = false;
  let buffer = Buffer.alloc(0);
  let pingInterval = null;

  function handleMessage(str) {
    try {
      const msg = JSON.parse(str);
      if (msg.event === 'pusher:connection_established') {
        console.log('[Kick] Pusher接続完了。チャンネル購読中...');
        wsSendText(JSON.stringify({
          event: 'pusher:subscribe',
          data: { auth: '', channel: `chatrooms.${chatroomId}.v2` },
        }));
        // Pusherのactivity_timeout(Kickは30秒程度)より前にこちらからpingを送り続けないと
        // 無通信とみなされて切断されてしまうため、定期的にクライアント側からpingを送る
        if (pingInterval) clearInterval(pingInterval);
        pingInterval = setInterval(() => {
          try { wsSendText(JSON.stringify({ event: 'pusher:ping', data: {} })); } catch {}
        }, 20000);
      } else if (msg.event === 'pusher_internal:subscription_succeeded') {
        console.log('[Kick] チャンネル購読完了。コメント受信待機中');
      } else if (msg.event === 'pusher:ping') {
        wsSendText(JSON.stringify({ event: 'pusher:pong', data: {} }));
      } else if (msg.event === 'App\\Events\\ChatMessageEvent') {
        const data = typeof msg.data === 'string' ? JSON.parse(msg.data) : msg.data;
        const sender = data.sender || data.user || {};
        const content = data.content || data.message || '';
        if (!content) return;
        addComment({
          name: sender.username || sender.name || '?',
          text: content,
          isItem: false,
          itemLabel: null,
          itemCount: 1,
          itemData: null,
          platform: 'kick',
        });
      }
    } catch (e) {}
  }

  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    if (!handshakeDone) {
      const idx = buffer.indexOf('\r\n\r\n');
      if (idx === -1) return;
      const headerStr = buffer.slice(0, idx).toString();
      if (!/HTTP\/1\.1 101/.test(headerStr)) {
        console.error('[Kick] WSハンドシェイク失敗:', headerStr.split('\r\n')[0]);
        socket.destroy();
        return;
      }
      handshakeDone = true;
      buffer = buffer.slice(idx + 4);
    }
    while (buffer.length >= 2) {
      const opcode = buffer[0] & 0x0f;
      let len = buffer[1] & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (buffer.length < 4) return;
        len = buffer.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (buffer.length < 10) return;
        len = Number(buffer.readBigUInt64BE(2));
        offset = 10;
      }
      if (buffer.length < offset + len) return;
      const payload = buffer.slice(offset, offset + len);
      buffer = buffer.slice(offset + len);
      if (opcode === 0x1) {
        handleMessage(payload.toString('utf8'));
      } else if (opcode === 0x9) {
        wsSendPong(payload);
      } else if (opcode === 0x8) {
        socket.end();
        return;
      }
    }
  });

  socket.on('close', () => {
    console.log('[Kick] Pusher切断。30秒後にリトライ...');
    if (pingInterval) { clearInterval(pingInterval); pingInterval = null; }
    if (kickWs === socket) kickWs = null;
    if (config.kickSlug || config.kickChatroomId) {
      kickReconnectTimer = setTimeout(() => connectKickChat(config.kickSlug), 30000);
    }
  });

  socket.on('error', (e) => {
    console.error('[Kick] WS error:', e.message);
    if (pingInterval) { clearInterval(pingInterval); pingInterval = null; }
  });
}

function disconnectKick() {
  clearTimeout(kickReconnectTimer);
  if (kickWs) { try { kickWs.destroy(); } catch {} kickWs = null; }
  kickChatroomId = null;
  console.log('[Kick] 切断');
}

// 起動時に保存済みslugがあれば接続
if (config.kickSlug) {
  setTimeout(() => connectKickChat(config.kickSlug), 2000);
}

// ============================================================
// TikTok LIVE対応 (tiktok-live-connector, 非公式)
// ============================================================
// このパッケージはESM専用のため、CommonJSからは動的import()で読み込む。
let TikTokLiveConnection = null;
let tiktokLibLoadPromise = null;
function loadTikTokLib() {
  if (TikTokLiveConnection) return Promise.resolve();
  if (!tiktokLibLoadPromise) {
    tiktokLibLoadPromise = import('tiktok-live-connector').then((mod) => {
      TikTokLiveConnection = mod.TikTokLiveConnection;
    });
  }
  return tiktokLibLoadPromise;
}

let tiktokConn = null;
let tiktokReconnectTimer = null;
let tiktokViewerCount = null;
let tiktokConnected = false;

async function connectTikTok(username) {
  if (!username) return;
  try {
    await loadTikTokLib();
  } catch (e) {
    console.error('[TikTok] ライブラリ読み込み失敗:', e.message);
    return;
  }

  disconnectTikTok();

  const uniqueId = String(username).trim().replace(/^@/, '');
  console.log(`[TikTok] 接続試行: @${uniqueId}`);

  const opts = {};
  if (process.env.TIKTOK_SIGN_API_KEY) opts.signApiKey = process.env.TIKTOK_SIGN_API_KEY;
  const conn = new TikTokLiveConnection(uniqueId, opts);
  tiktokConn = conn;

  conn.on('chat', (data) => {
    addComment({
      name: data.user?.nickname || data.user?.uniqueId || '?',
      text: data.comment || '',
      isItem: false,
      platform: 'tiktok',
    });
  });

  conn.on('gift', (data) => {
    const giftType = data.giftDetails?.giftType;
    if (giftType === 1 && !data.repeatEnd) return; // 連打中は完了時のみ計上
    const giftName = data.giftDetails?.giftName || 'ギフト';
    addComment({
      name: data.user?.nickname || data.user?.uniqueId || '?',
      text: `${giftName} ×${data.repeatCount || 1}`,
      isItem: true,
      itemLabel: giftName,
      itemCount: data.repeatCount || 1,
      platform: 'tiktok',
    });
  });

  conn.on('roomUser', (data) => {
    if (Number.isFinite(Number(data.viewerCount))) tiktokViewerCount = Number(data.viewerCount);
  });

  conn.on('disconnected', () => {
    tiktokConnected = false;
    console.log('[TikTok] 切断。30秒後に再接続');
    clearTimeout(tiktokReconnectTimer);
    tiktokReconnectTimer = setTimeout(() => connectTikTok(config.tiktokUsername), 30000);
  });

  conn.on('error', (e) => {
    console.error('[TikTok] error:', e && (e.info || e.exception?.message || e.message));
  });

  try {
    const state = await conn.connect();
    tiktokConnected = true;
    console.log(`[TikTok] 接続完了 roomId=${state.roomId}`);
  } catch (e) {
    tiktokConnected = false;
    console.error('[TikTok] 接続失敗:', e.message);
    clearTimeout(tiktokReconnectTimer);
    tiktokReconnectTimer = setTimeout(() => connectTikTok(config.tiktokUsername), 30000);
  }
}

function disconnectTikTok() {
  clearTimeout(tiktokReconnectTimer);
  if (tiktokConn) { try { tiktokConn.disconnect(); } catch {} tiktokConn = null; }
  tiktokConnected = false;
  tiktokViewerCount = null;
}

if (config.tiktokUsername) {
  setTimeout(() => connectTikTok(config.tiktokUsername), 2000);
}

// ============================================================
// AIトークテーマ生成 (Gemini)
// ============================================================
const GEMINI_MODEL = 'gemini-2.5-flash-lite';

async function generateTopics(count) {
  const apiKey = config.geminiApiKey;
  if (!apiKey) throw new Error('Gemini APIキーが未設定です');

  const log = recentComments
    .slice(-60)
    .filter((c) => !c.isItem && c.text)
    .map((c) => `${c.name}: ${c.text}`)
    .join('\n');

  const prompt = `あなたはライブ配信の構成作家です。以下は配信中のコメント欄の直近ログです。

このコメントの流れ・話題・空気感を読み取って、配信者が今このタイミングで話すと盛り上がる「トークテーマ」を${count || 3}個提案してください。

ルール:
- 1つ25文字以内の短い問いかけ形式にする
- 今出ている話題に自然につながるものを優先する
- 視聴者がコメントで答えたくなる内容にする
- 誹謗中傷、差別、性的な内容、特定個人への攻撃は禁止
- 説明や番号は不要。テーマ本文のみを1行に1つ、改行区切りで出力する

直近のコメント:
${log || '(コメントがまだありません。配信開始直後を想定した一般的な話題にしてください)'}`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
  });
  const data = await res.json();
  if (data.error) throw new Error('Gemini: ' + data.error.message);
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
  const topics = text
    .split('\n')
    .map((t) => t.replace(/^[\-\*\d\.、。\s]+/, '').replace(/^["「『]+|["」』]+$/g, '').trim())
    .filter((t) => t.length > 0 && t.length <= 60)
    .slice(0, count || 3);
  if (topics.length === 0) throw new Error('生成結果が空でした');
  return topics;
}

// ---------- HTTPサーバー ----------
function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch { resolve({}); } });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if ((url.pathname === '/dock' || url.pathname === '/') && req.method === 'GET') {
    const html = fs.readFileSync(path.join(ROOT, 'overlay_dock.html'), 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(html);
    return;
  }

  if ((url.pathname === '/overlay-nico' || url.pathname === '/overlay') && req.method === 'GET') {
    const html = fs.readFileSync(path.join(ROOT, 'overlay_nico.html'), 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(html);
    return;
  }

  // ---- 縦型オーバーレイ ----
  if (url.pathname === '/overlay-vertical' && req.method === 'GET') {
    const html = fs.readFileSync(path.join(ROOT, 'overlay_vertical.html'), 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(html);
    return;
  }

  // ---- 切り替え式オーバーレイ(ドックの設定でニコ生風/縦型が切り替わる) ----
  if (url.pathname === '/overlay-auto' && req.method === 'GET') {
    const isWindowMode = url.searchParams.get('window') === '1';
    const bg = isWindowMode ? '#000' : 'transparent';
    const html = `<!DOCTYPE html>
<html lang="ja">
<head><meta charset="UTF-8"><title>コメントオーバーレイ</title>
<style>html,body{margin:0;padding:0;width:100vw;height:100vh;background:${bg};overflow:hidden}iframe{width:100vw;height:100vh;border:0;background:${bg}}</style>
</head>
<body>
<iframe id="f" allowtransparency="true"></iframe>
<script>
let mode = null;
const qs = location.search; // ?platform=...&window=1 等をそのままiframeへ引き継ぐ
async function check() {
  try {
    const res = await fetch('/api/overlay/status');
    const d = await res.json();
    const m = d.displayMode === 'vertical' ? 'vertical' : 'nico';
    if (m !== mode) {
      mode = m;
      document.getElementById('f').src = (m === 'vertical' ? '/overlay-vertical' : '/overlay-nico') + qs;
    }
  } catch (e) {}
  setTimeout(check, 3000);
}
check();
<\/script>
</body>
</html>`;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(html);
    return;
  }

  if (url.pathname === '/api/overlay/status' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({
      liveId: config.liveId,
      speed: config.speed,
      count: recentComments.length,
      kickSlug: config.kickSlug,
      kickConnected: !!kickWs,
      kickChatroomId,
      verticalPos: config.verticalPos,
      displayMode: config.displayMode,
      bgOpacity: config.bgOpacity,
      topic: config.topicVisible ? config.topic : '',
      topicRaw: config.topic,
      topicVisible: config.topicVisible,
      hasApiKey: !!config.geminiApiKey,
      commentSource: config.commentSource,
      commentSources: config.commentSources,
      showFw: config.showFw,
      showKick: config.showKick,
      tiktokUsername: config.tiktokUsername,
      tiktokConnected,
      tiktokViewerCount,
      goal: (config.goalVisible && config.goalTarget > 0) ? {
        target: config.goalTarget,
        rate: config.goalRate,
        current: config.kickSlug ? kickFollowerCount : followerCount,
        baseline: config.goalBaseline,
      } : null,
      goalTarget: config.goalTarget,
      goalRate: config.goalRate,
      goalVisible: config.goalVisible,
      followerCount,
      fwViewerCount,
      kickFollowerCount,
      kickViewerCount,
      survey: surveyState(),
      quiz: quizState(),
      roulette: rouletteState(),
      scheduleEnabled: config.scheduleEnabled,
      scheduleDisplayWeek: config.scheduleDisplayWeek,
      scheduleByWeek: config.scheduleByWeek,
      scheduleStyle: config.scheduleStyle,
      statsRecording: {
        active: !!currentStream,
        paused: statsPaused,
        startedAt: currentStream ? currentStream.startedAt : null,
        fwTitle: currentStream ? currentStream.fwTitle : '',
        kickTitle: currentStream ? currentStream.kickTitle : '',
      },
      port: PORT,
    }));
    return;
  }

  if (url.pathname === '/api/overlay/config' && req.method === 'POST') {
    const body = await readBody(req);
    let changed = false;

    if (body.liveUrl !== undefined || body.liveId !== undefined) {
      const liveId = extractLiveId(body.liveUrl || body.liveId || '');
      if (!liveId) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '配信URL/IDを認識できませんでした' }));
        return;
      }
      const changingLive = liveId !== config.liveId;
      config.liveId = liveId;
      if (changingLive) {
        fwLastUpdated = 0;
        recentComments = [];
        commentIdCounter = 0;
      }
      // ヘッダー(フォロワー・閲覧数)はふわっち/Kick同時表示可能。
      // コメント欄はconfig.displayModeで選ばれたプラットフォームのみ流す。
      changed = true;
    }

    if (body.speed !== undefined) {
      const s = Number(body.speed);
      if (!isNaN(s) && s >= 2 && s <= 20) { config.speed = s; changed = true; }
    }

    if (body.verticalPos !== undefined) {
      if (body.verticalPos === 'left' || body.verticalPos === 'right') {
        config.verticalPos = body.verticalPos;
        changed = true;
      }
    }

    if (body.goalTarget !== undefined) {
      const v = Number(body.goalTarget);
      if (!isNaN(v) && v >= 0) { config.goalTarget = Math.floor(v); changed = true; }
    }
    if (body.goalRate !== undefined) {
      const v = Number(body.goalRate);
      if (!isNaN(v) && v >= 0) { config.goalRate = v; changed = true; }
    }
    if (body.goalVisible !== undefined) {
      config.goalVisible = !!body.goalVisible;
      // 表示開始時点のフォロワー数を基準にする(ゲージが0から伸びるように)
      if (body.goalVisible) {
        const cur = config.kickSlug ? kickFollowerCount : followerCount;
        if (typeof cur === 'number') config.goalBaseline = cur;
      }
      changed = true;
    }

    if (body.showFw !== undefined) { config.showFw = !!body.showFw; changed = true; }
    if (body.showKick !== undefined) { config.showKick = !!body.showKick; changed = true; }

    if (body.commentSource !== undefined) {
      if (['fw', 'kick', 'tiktok'].includes(body.commentSource)) {
        config.commentSource = body.commentSource;
        changed = true;
      }
    }

    // コメント欄に流すプラットフォーム(複数選択可・チェックボックス)
    if (body.commentSources !== undefined) {
      if (Array.isArray(body.commentSources)) {
        const valid = [...new Set(body.commentSources.filter((s) => ['fw', 'kick', 'tiktok'].includes(s)))];
        if (valid.length > 0) {
          config.commentSources = valid;
          config.commentSource = valid[0]; // 後方互換用に先頭を反映
          changed = true;
        }
      }
    }

    if (body.geminiApiKey !== undefined) {
      config.geminiApiKey = String(body.geminiApiKey).trim();
      changed = true;
    }

    if (body.topic !== undefined) {
      config.topic = String(body.topic).slice(0, 200);
      changed = true;
    }
    if (body.topicVisible !== undefined) {
      config.topicVisible = !!body.topicVisible;
      changed = true;
    }

    if (body.bgOpacity !== undefined) {
      const v = Number(body.bgOpacity);
      if (!isNaN(v) && v >= 0 && v <= 100) { config.bgOpacity = v; changed = true; }
    }

    if (body.displayMode !== undefined) {
      if (body.displayMode === 'nico' || body.displayMode === 'vertical') {
        config.displayMode = body.displayMode;
        changed = true;
      }
    }

    // ---- 配信スケジュール(週ごとの配信時間・内容) ----
    if (body.scheduleEnabled !== undefined) { config.scheduleEnabled = !!body.scheduleEnabled; changed = true; }
    if (body.scheduleDisplayWeek !== undefined) {
      const w = body.scheduleDisplayWeek;
      if (w === '' || (typeof w === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(w))) {
        config.scheduleDisplayWeek = w;
        changed = true;
      }
    }
    if (
      body.schedule !== undefined && typeof body.schedule === 'object' && body.schedule !== null &&
      typeof body.scheduleWeek === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.scheduleWeek)
    ) {
      const wk = body.scheduleWeek;
      const base = config.scheduleByWeek[wk] || sanitizeWeekMap({});
      for (const key of SCHEDULE_DAYS) {
        const d = body.schedule[key];
        if (d && typeof d === 'object') {
          base[key] = {
            time: typeof d.time === 'string' ? d.time.slice(0, 40) : base[key].time,
            text: typeof d.text === 'string' ? d.text.slice(0, 100) : base[key].text,
            color: (typeof d.color === 'string' && (d.color === '' || /^#[0-9a-fA-F]{6}$/.test(d.color))) ? d.color : base[key].color,
          };
        }
      }
      config.scheduleByWeek[wk] = base;
      changed = true;
    }

    // ---- 配信スケジュール表示の見た目 ----
    if (body.scheduleStyle !== undefined && typeof body.scheduleStyle === 'object' && body.scheduleStyle !== null) {
      const st = body.scheduleStyle;
      if (typeof st.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(st.color)) config.scheduleStyle.color = st.color;
      if (st.fontSize !== undefined) {
        const v = Number(st.fontSize);
        if (!isNaN(v) && v >= 10 && v <= 60) config.scheduleStyle.fontSize = v;
      }
      if (st.opacity !== undefined) {
        const v = Number(st.opacity);
        if (!isNaN(v) && v >= 0 && v <= 100) config.scheduleStyle.opacity = v;
      }
      if (st.width !== undefined) {
        const v = Number(st.width);
        if (!isNaN(v) && v >= 120 && v <= 2000) config.scheduleStyle.width = v;
      }
      if (st.scale !== undefined) {
        const v = Number(st.scale);
        if (!isNaN(v) && v >= 50 && v <= 300) config.scheduleStyle.scale = v;
      }
      changed = true;
    }

    if (body.kickChatroomId !== undefined) {
      const v = String(body.kickChatroomId).trim();
      config.kickChatroomId = v;
      changed = true;
      if (v || config.kickSlug) {
        connectKickChat(config.kickSlug);
      } else {
        disconnectKick();
      }
    }

    if (body.kickSlug !== undefined) {
      const slug = String(body.kickSlug).trim().replace(/^https?:\/\/kick\.com\//i, '').replace(/\/$/, '');
      const changingSlug = slug !== config.kickSlug;
      config.kickSlug = slug;
      if (changingSlug) config.kickChatroomId = ''; // チャンネルが変わったら古いIDは破棄
      changed = true;
      if (slug) {
        if (changingSlug) connectKickChat(slug);
      } else {
        disconnectKick();
      }
    }

    if (body.tiktokUsername !== undefined) {
      const uname = String(body.tiktokUsername).trim()
        .replace(/^https?:\/\/(www\.)?tiktok\.com\//i, '')
        .replace(/\/live\/?$/i, '')
        .replace(/^@/, '');
      const changingUname = uname !== config.tiktokUsername;
      config.tiktokUsername = uname;
      changed = true;
      if (uname) {
        if (changingUname) connectTikTok(uname);
      } else {
        disconnectTikTok();
      }
    }

    if (changed) saveConfig(config);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, liveId: config.liveId, speed: config.speed, kickSlug: config.kickSlug, tiktokUsername: config.tiktokUsername }));
    return;
  }

  // ---- Kickフォロワー数をブラウザ(ドック)経由で受け取る ----
  // Render等のクラウドIPはKickの非公式API(v2)がCloudflareでブロックするため、
  // ドックを開いているPC(通常の回線)側からfetchして送ってもらう方式。
  if (url.pathname === '/api/overlay/kick-report' && req.method === 'POST') {
    const body = await readBody(req);
    if (Number.isFinite(Number(body.followerCount))) {
      kickFollowerCount = Number(body.followerCount);
    }
    // chatroomIdが未設定 or 未接続なら、ブラウザ側から取得したIDで接続を試みる
    // (再デプロイでconfigがリセットされた場合の自動復旧)
    if (body.chatroomId && !kickWs && String(body.chatroomId) !== String(config.kickChatroomId)) {
      config.kickChatroomId = String(body.chatroomId);
      saveConfig(config);
      connectKickChat(config.kickSlug);
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (url.pathname === '/api/overlay/comments' && req.method === 'GET') {
    const afterId = Number(url.searchParams.get('afterId') || '0');
    // ?platform= が指定されていればそちらを優先(TikTok用キャプチャウィンドウなど、
    // メインのOBSオーバーレイとは別のプラットフォームを同時に表示するため)
    const platformOverride = url.searchParams.get('platform');
    const activeSources = (platformOverride === 'fw' || platformOverride === 'kick' || platformOverride === 'tiktok')
      ? [platformOverride]
      : (Array.isArray(config.commentSources) && config.commentSources.length ? config.commentSources : [config.commentSource]);
    const newComments = recentComments.filter(
      (c) => c.id > afterId && (!c.platform || activeSources.includes(c.platform))
    );
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ comments: newComments, lastId: commentIdCounter }));
    return;
  }

  if (url.pathname === '/api/overlay/gift' && req.method === 'POST') {
    const body = await readBody(req);
    handleIncomingGift(body);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // ---- アイテム履歴取得 ----
  if (url.pathname === '/api/overlay/giftlog' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ gifts: giftLog.slice().reverse() })); // 新着順
    return;
  }

  // ---- 配信統計: 配信一覧(カレンダー・期間指定グラフ用) ----
  // from/to は YYYY-MM-DD (JST基準・両端含む)。full=1 で閲覧数の時系列サンプルも含める
  if (url.pathname === '/api/overlay/stats/streams' && req.method === 'GET') {
    const from = url.searchParams.get('from');
    const to = url.searchParams.get('to');
    const full = url.searchParams.get('full') === '1';
    let list = stats.streams;
    if (from) list = list.filter((s) => toJstDateStr(s.startedAt) >= from);
    if (to) list = list.filter((s) => toJstDateStr(s.startedAt) <= to);
    const out = list.slice().reverse().map((s) => summarizeStream(s, full)); // 新しい順
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ streams: out }));
    return;
  }

  // ---- 配信統計: ローカルバックアップ用エクスポート(内部形式そのまま・復元との往復に対応) ----
  if (url.pathname === '/api/overlay/stats/export' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ streams: stats.streams, exportedAt: Date.now() }));
    return;
  }

  // ---- 配信統計: CSVエクスポート(Excel/スプレッドシートでの独自分析用) ----
  if (url.pathname === '/api/overlay/stats/export.csv' && req.method === 'GET') {
    const csvEscape = (v) => {
      const s = v === null || v === undefined ? '' : String(v);
      return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const header = [
      '日付', '開始時刻', '終了時刻', '配信時間(分)',
      'ふわっちタイトル', 'Kickタイトル',
      'ふわっち最高同接', 'Kick最高同接', 'ふわっち平均同接', 'Kick平均同接',
      'ふわっちフォロワー開始', 'ふわっちフォロワー終了', 'ふわっち増減',
      'Kickフォロワー開始', 'Kickフォロワー終了', 'Kick増減',
      'コメント最多時刻', 'コメント最多件数(件/分)', 'メモ',
    ];
    const rows = stats.streams.map((s) => {
      const sum = summarizeStream(s, false);
      const fmtDt = (ms) => (ms ? new Date(ms).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', hour12: false }) : '');
      return [
        sum.date,
        fmtDt(sum.startedAt),
        sum.endedAt ? fmtDt(sum.endedAt) : '(継続中)',
        Math.round(sum.durationMs / 60000),
        sum.fwTitle || '',
        sum.kickTitle || '',
        sum.peakFwViewers ?? '',
        sum.peakKickViewers ?? '',
        sum.avgFwViewers ?? '',
        sum.avgKickViewers ?? '',
        sum.fwFollowerStart ?? '',
        sum.fwFollowerEnd ?? '',
        sum.fwFollowerGain ?? '',
        sum.kickFollowerStart ?? '',
        sum.kickFollowerEnd ?? '',
        sum.kickFollowerGain ?? '',
        sum.peakCommentAt ? fmtDt(sum.peakCommentAt) : '',
        sum.peakCommentCount || '',
        sum.note || '',
      ];
    });
    // ExcelでUTF-8の日本語が文字化けしないようBOMを付与
    const BOM = String.fromCharCode(0xFEFF);
    const csv = BOM + [header, ...rows].map((r) => r.map(csvEscape).join(',')).join('\r\n') + '\r\n';
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="nicolive_stats_${toJstDateStr(Date.now())}.csv"`,
    });
    res.end(csv);
    return;
  }

  // ---- 配信統計: ローカルバックアップからの復元(Renderの無料プランは再デプロイで消えるための救済) ----
  if (url.pathname === '/api/overlay/stats/restore' && req.method === 'POST') {
    const body = await readBody(req);
    if (!Array.isArray(body.streams)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'streamsが配列ではありません' }));
      return;
    }
    const byId = new Map();
    for (const s of stats.streams) byId.set(s.id, s);
    let restored = 0;
    for (const s of body.streams) {
      if (!s || typeof s.id !== 'string' || typeof s.startedAt !== 'number') continue;
      if (currentStream && s.id === currentStream.id) continue; // 進行中の記録は上書きしない
      byId.set(s.id, s);
      restored++;
    }
    stats.streams = Array.from(byId.values()).sort((a, b) => a.startedAt - b.startedAt);
    if (stats.streams.length > STATS_MAX_STREAMS) stats.streams = stats.streams.slice(-STATS_MAX_STREAMS);
    saveStats();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, restored, total: stats.streams.length }));
    return;
  }

  // ---- 配信統計: 指定した配信データの削除 ----
  if (url.pathname === '/api/overlay/stats/delete' && req.method === 'POST') {
    const body = await readBody(req);
    if (typeof body.id !== 'string' || !body.id) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'idが指定されていません' }));
      return;
    }
    if (currentStream && body.id === currentStream.id) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '計測中の配信は削除できません(先に計測を停止してください)' }));
      return;
    }
    const before = stats.streams.length;
    stats.streams = stats.streams.filter((s) => s.id !== body.id);
    const deleted = before !== stats.streams.length;
    saveStats();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, deleted, total: stats.streams.length }));
    return;
  }

  // ---- 配信統計: 手動での計測停止/再開 ----
  // paused:true にすると進行中の記録を即座に確定させ、以後は配信中でも自動記録しない。
  // paused:false に戻すと通常の自動判定に戻る(配信中なら次のtickで新規記録を開始)
  if (url.pathname === '/api/overlay/stats/pause' && req.method === 'POST') {
    const body = await readBody(req);
    statsPaused = !!body.paused;
    if (statsPaused) finalizeCurrentStream();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, paused: statsPaused }));
    return;
  }

  // ---- AI: トークテーマ生成 ----
  if (url.pathname === '/api/overlay/topic/generate' && req.method === 'POST') {
    const body = await readBody(req);
    try {
      const topics = await generateTopics(Number(body.count) || 3);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, topics }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ---- クイズ: 出題 ----
  if (url.pathname === '/api/overlay/quiz/show' && req.method === 'POST') {
    const body = await readBody(req);
    const ok = showQuiz(body.question, body.options || [], body.correct);
    if (!ok) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '問題文と選択肢2つ以上を入力してください' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, quiz: quizState() }));
    return;
  }

  // ---- クイズ: オーディエンス開始 ----
  if (url.pathname === '/api/overlay/quiz/audience' && req.method === 'POST') {
    const body = await readBody(req);
    const ok = startAudience(Number(body.duration) || 60);
    if (!ok) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '先に出題してください' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, quiz: quizState() }));
    return;
  }

  // ---- クイズ: オーディエンス締切 ----
  if (url.pathname === '/api/overlay/quiz/audience-stop' && req.method === 'POST') {
    stopAudience();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, quiz: quizState() }));
    return;
  }

  // ---- クイズ: 正解発表 ----
  if (url.pathname === '/api/overlay/quiz/reveal' && req.method === 'POST') {
    revealQuiz();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, quiz: quizState() }));
    return;
  }

  // ---- クイズ: 非表示 ----
  if (url.pathname === '/api/overlay/quiz/clear' && req.method === 'POST') {
    clearQuiz();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // ---- アンケート: 開始 ----
  if (url.pathname === '/api/overlay/survey/start' && req.method === 'POST') {
    const body = await readBody(req);
    const ok = startSurvey(body.options || [], Number(body.duration) || 60);
    if (!ok) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '選択肢を2つ以上入力してください' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, survey: surveyState() }));
    return;
  }

  // ---- アンケート: 終了 ----
  if (url.pathname === '/api/overlay/survey/stop' && req.method === 'POST') {
    stopSurvey();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, survey: surveyState() }));
    return;
  }

  // ---- アンケート: 非表示(消す) ----
  if (url.pathname === '/api/overlay/survey/clear' && req.method === 'POST') {
    clearSurvey();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // ---- ルーレット: 項目追加 ----
  if (url.pathname === '/api/overlay/roulette/add' && req.method === 'POST') {
    const body = await readBody(req);
    const ok = addRouletteItem(body.text);
    if (!ok) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `項目は${ROULETTE_MAX_ITEMS}個までです`, roulette: rouletteState() }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, roulette: rouletteState() }));
    return;
  }

  // ---- ルーレット: 項目削除 ----
  if (url.pathname === '/api/overlay/roulette/remove' && req.method === 'POST') {
    const body = await readBody(req);
    removeRouletteItem(body.index);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, roulette: rouletteState() }));
    return;
  }

  // ---- ルーレット: リセット(全項目クリア) ----
  if (url.pathname === '/api/overlay/roulette/reset' && req.method === 'POST') {
    resetRoulette();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, roulette: rouletteState() }));
    return;
  }

  // ---- ルーレット: 表示/非表示 ----
  if (url.pathname === '/api/overlay/roulette/visible' && req.method === 'POST') {
    const body = await readBody(req);
    roulette.visible = !!body.visible;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, roulette: rouletteState() }));
    return;
  }

  // ---- ルーレット: 回す ----
  if (url.pathname === '/api/overlay/roulette/spin' && req.method === 'POST') {
    const ok = spinRoulette();
    if (!ok) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '項目が2個以上必要です、または既に回転中です', roulette: rouletteState() }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, roulette: rouletteState() }));
    return;
  }

  // ---- アイテム履歴クリア ----
  if (url.pathname === '/api/overlay/giftlog/clear' && req.method === 'POST') {
    giftLog = [];
    saveGiftLog();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
});

server.listen(PORT, () => {
  console.log(`==============================================`);
  console.log(` ニコ生風コメントオーバーレイ`);
  console.log(` ドック    : http://localhost:${PORT}/dock`);
  console.log(` オーバーレイ: http://localhost:${PORT}/overlay-nico`);
  console.log(` ふわっちID: ${config.liveId || '(未設定)'}`);
  console.log(` KickスラッグG: ${config.kickSlug || '(未設定)'}`);
  console.log(` データ保存先: ${DATA_DIR === ROOT ? 'アプリ本体と同じ場所(再デプロイで消えます)' : DATA_DIR + '(Persistent Disk)'}`);
  console.log(`==============================================`);
});
