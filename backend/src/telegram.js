// Bot Telegram bidirectionnel — webhook entrant + envoi sortant + réponse RAG augmentée
import express from 'express';
import fetch from 'node-fetch';

let BOT_TOKEN = null;
let ADMIN_CHAT_ID = null;

const TELEGRAM_BASE = 'https://api.telegram.org';

function loadTelegramConfig(db) {
  try {
    const rows = db.prepare(`SELECT key, value FROM config WHERE key LIKE 'telegram_%'`).all();
    rows.forEach(r => {
      if (r.key === 'telegram_bot_token') BOT_TOKEN = r.value;
      if (r.key === 'telegram_admin_chat_id') ADMIN_CHAT_ID = r.value;
    });
    if (BOT_TOKEN) console.log('[telegram] Bot token loaded');
  } catch(e) { console.error('[telegram] loadConfig:', e.message); }
}

async function tg(method, body) {
  if (!BOT_TOKEN) throw new Error('Telegram bot token not configured');
  const res = await fetch(`${TELEGRAM_BASE}/bot${BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await res.json();
  if (!data.ok) throw new Error('Telegram '+method+': '+JSON.stringify(data));
  return data.result;
}

async function callGemini(prompt) {
  if (!process.env.GEMINI_API_KEY) throw new Error('No Gemini key');
  const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.7, maxOutputTokens: 1024 }
    })
  });
  const data = await r.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text || '(réponse vide)';
}

async function ragRetrieve(db, query, topK = 3) {
  try {
    const docs = db.prepare(`SELECT title, content, source FROM rag_docs ORDER BY created_at DESC LIMIT 50`).all();
    if (!docs.length) return [];
    // Recherche par mots-clés (sans embedding pour aller vite côté Telegram)
    const keywords = query.toLowerCase().split(/\s+/).filter(w => w.length > 3);
    return docs
      .map(d => {
        const text = (d.title+' '+d.content).toLowerCase();
        const score = keywords.reduce((s, k) => s + (text.includes(k) ? 1 : 0), 0);
        return { ...d, score };
      })
      .filter(d => d.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  } catch { return []; }
}

function getStats(db) {
  try {
    const leads = db.prepare('SELECT COUNT(*) AS c FROM leads').get().c;
    const won = db.prepare(`SELECT COUNT(*) AS c, COALESCE(SUM(amount),0) AS t FROM deals WHERE stage='won'`).get();
    const pipeline = db.prepare(`SELECT COALESCE(SUM(amount),0) AS t FROM deals WHERE stage NOT IN ('won','lost')`).get().t;
    const factures = db.prepare(`SELECT COUNT(*) AS c FROM factures WHERE status != 'paid'`).get().c;
    return { leads, won: won.c, ca: won.t, pipeline, factures_open: factures };
  } catch { return { leads:0, won:0, ca:0, pipeline:0, factures_open:0 }; }
}

async function handleTelegramMessage(db, message) {
  const chatId = message.chat.id;
  const text = (message.text || '').trim();
  const userName = message.from.first_name || 'user';

  // Sauvegarde du message entrant
  try {
    db.prepare(`INSERT INTO telegram_messages (chat_id, direction, text, user_name) VALUES (?, 'in', ?, ?)`).run(chatId, text, userName);
  } catch {}

  // Commandes spéciales
  if (text === '/start') {
    const welcome = `👋 Salut ${userName} !\n\nJe suis PixeeSales-Alpha, ton agent commercial augmenté.\n\nJe peux t'aider sur :\n• /stats — état du business\n• /leads — top 5 leads\n• /deals — pipeline\n• /report — rapport instantané\n• ou pose-moi n'importe quelle question business\n\nQue veux-tu faire ?`;
    await tg('sendMessage', { chat_id: chatId, text: welcome });
    return;
  }

  if (text === '/stats') {
    const s = getStats(db);
    const msg = `📊 *PixeeSales-Alpha — Stats*\n\n• Leads : ${s.leads}\n• Deals signés : ${s.won}\n• CA signé : ${s.ca} €\n• Pipeline ouvert : ${s.pipeline} €\n• Factures en attente : ${s.factures_open}`;
    await tg('sendMessage', { chat_id: chatId, text: msg, parse_mode: 'Markdown' });
    return;
  }

  if (text === '/leads') {
    const leads = db.prepare(`SELECT data FROM leads ORDER BY created_at DESC LIMIT 5`).all();
    if (!leads.length) {
      await tg('sendMessage', { chat_id: chatId, text: 'Aucun lead pour l\'instant.' });
    } else {
      const parsed = leads.map(l => { try { return JSON.parse(l.data); } catch { return null; } }).filter(Boolean);
      const msg = '🎯 *Top 5 leads*\n\n' + parsed.map((l,i) => `${i+1}. *${l.company || '?'}* — score ${l.score || '?'}/100 · ${l.category || '?'}\n   ${l.sector || ''} · panier estimé ${l.basket_eur || '?'} €`).join('\n\n');
      await tg('sendMessage', { chat_id: chatId, text: msg, parse_mode: 'Markdown' });
    }
    return;
  }

  if (text === '/deals') {
    const deals = db.prepare(`SELECT data, stage, amount FROM deals ORDER BY amount DESC LIMIT 5`).all();
    if (!deals.length) {
      await tg('sendMessage', { chat_id: chatId, text: 'Pipeline vide.' });
    } else {
      const stageEmoji = { prospect:'🔵', contact:'🟠', meeting:'🟣', quote:'🩷', won:'✅', lost:'❌' };
      const msg = '💼 *Top 5 deals*\n\n' + deals.map((d,i) => {
        let data; try { data = JSON.parse(d.data); } catch { data = {}; }
        return `${i+1}. ${stageEmoji[d.stage]||'•'} *${data.company || '?'}* — ${d.amount} € (${d.stage})`;
      }).join('\n');
      await tg('sendMessage', { chat_id: chatId, text: msg, parse_mode: 'Markdown' });
    }
    return;
  }

  if (text === '/report') {
    const s = getStats(db);
    const prompt = `Tu es PixeeSales-Alpha. Rédige un rapport flash en 5 lignes max pour Telegram. État: ${s.leads} leads, ${s.won} deals won (${s.ca}€), ${s.pipeline}€ pipeline ouvert, ${s.factures_open} factures à encaisser. Format court, punchy, avec 1 action prioritaire.`;
    await tg('sendChatAction', { chat_id: chatId, action: 'typing' });
    try {
      const reply = await callGemini(prompt);
      await tg('sendMessage', { chat_id: chatId, text: reply });
    } catch(e) {
      await tg('sendMessage', { chat_id: chatId, text: '⚠ Erreur Gemini : '+e.message });
    }
    return;
  }

  // Question libre → RAG + Gemini
  await tg('sendChatAction', { chat_id: chatId, action: 'typing' });
  try {
    const sources = await ragRetrieve(db, text, 3);
    const context = sources.length
      ? '\n\nCONTEXTE DISPONIBLE (extraits base de connaissances) :\n' + sources.map((s,i) => `[${i+1}] ${s.title}: ${s.content.slice(0,500)}`).join('\n')
      : '';
    const stats = getStats(db);
    const prompt = `Tu es PixeeSales-Alpha, agent commercial IA de Pixeeplay, qui chatte sur Telegram.
État business : ${stats.leads} leads · ${stats.won} signés (${stats.ca}€) · ${stats.pipeline}€ pipeline.
${context}

Question de ${userName} : ${text}

Réponds en français, court (3-5 phrases max, format Telegram), concret. Pas de markdown lourd.`;
    const reply = await callGemini(prompt);
    await tg('sendMessage', { chat_id: chatId, text: reply });
    // Sauvegarde de la réponse
    try {
      db.prepare(`INSERT INTO telegram_messages (chat_id, direction, text, user_name) VALUES (?, 'out', ?, 'bot')`).run(chatId, reply);
    } catch {}
  } catch(e) {
    await tg('sendMessage', { chat_id: chatId, text: '⚠ Erreur : '+e.message });
  }
}

export function telegramRoutes(db) {
  loadTelegramConfig(db);
  // Crée la table si pas existante
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS telegram_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT,
      direction TEXT,
      text TEXT,
      user_name TEXT,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    )`);
  } catch(e) { console.error('[telegram] create table:', e.message); }

  const r = express.Router();

  // Sauvegarde config bot
  r.post('/config', async (req, res) => {
    try {
      const { bot_token, admin_chat_id } = req.body;
      if (!bot_token) return res.status(400).json({ error: 'bot_token required' });
      BOT_TOKEN = bot_token;
      if (admin_chat_id) ADMIN_CHAT_ID = admin_chat_id;
      const stmt = db.prepare(`INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?`);
      stmt.run('telegram_bot_token', bot_token, bot_token);
      if (admin_chat_id) stmt.run('telegram_admin_chat_id', admin_chat_id, admin_chat_id);
      // Vérifie le bot
      const me = await tg('getMe');
      res.json({ ok: true, bot: me });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // Setup webhook (enregistre l'URL chez Telegram)
  r.post('/setup', async (req, res) => {
    try {
      const webhookUrl = req.body.url || (process.env.PUBLIC_BASE_URL || 'https://api.pixeeplay.com') + '/api/telegram/webhook';
      const result = await tg('setWebhook', { url: webhookUrl, allowed_updates: ['message', 'callback_query'] });
      const info = await tg('getWebhookInfo');
      res.json({ ok: true, webhook: webhookUrl, info });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // Webhook entrant (Telegram POST ici à chaque message reçu)
  r.post('/webhook', async (req, res) => {
    res.status(200).json({ ok: true }); // Répondre vite à Telegram
    try {
      const update = req.body;
      if (update.message && update.message.text) {
        await handleTelegramMessage(db, update.message);
      }
    } catch(e) { console.error('[telegram webhook]', e.message); }
  });

  // Envoi proactif (pour notifier l'admin)
  r.post('/send', async (req, res) => {
    try {
      const { chat_id, text, parse_mode } = req.body;
      const target = chat_id || ADMIN_CHAT_ID;
      if (!target) return res.status(400).json({ error: 'chat_id required (or set admin)' });
      const result = await tg('sendMessage', { chat_id: target, text, parse_mode: parse_mode || 'Markdown' });
      res.json({ ok: true, result });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // Info bot
  r.get('/info', async (req, res) => {
    try {
      if (!BOT_TOKEN) return res.json({ configured: false });
      const me = await tg('getMe');
      const wh = await tg('getWebhookInfo');
      res.json({ configured: true, bot: me, webhook: wh, admin_chat_id: ADMIN_CHAT_ID });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // Historique
  r.get('/history', (req, res) => {
    const chatId = req.query.chat_id;
    const rows = chatId
      ? db.prepare(`SELECT * FROM telegram_messages WHERE chat_id = ? ORDER BY created_at DESC LIMIT 100`).all(chatId)
      : db.prepare(`SELECT * FROM telegram_messages ORDER BY created_at DESC LIMIT 100`).all();
    res.json(rows);
  });

  return r;
}

// Export pour permettre aux autres modules (cron, autopilote) d'envoyer
export async function sendTelegramAdmin(text) {
  if (!BOT_TOKEN || !ADMIN_CHAT_ID) return;
  try {
    await tg('sendMessage', { chat_id: ADMIN_CHAT_ID, text, parse_mode: 'Markdown' });
  } catch(e) { console.error('[telegram sendAdmin]', e.message); }
}
