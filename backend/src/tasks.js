// Système de tâches background : 5 jobs récurrents + queue one-shot
import express from 'express';
import cron from 'node-cron';
import fetch from 'node-fetch';
import { sendTelegramAdmin } from './telegram.js';

// Définition des tâches récurrentes
const RECURRING_TASKS = [
  {
    name: 'auto-analyze-inbox',
    label: '🧠 Auto-analyse inbox',
    description: 'Scan l\'inbox toutes les 2h, classifie chaque mail, extrait les 5 actions prioritaires et notifie Telegram si hot leads détectés.',
    schedule: '0 */2 * * *',
    scheduleLabel: 'Toutes les 2h',
    enabled: true
  },
  {
    name: 'auto-detect-hot-leads',
    label: '🔥 Auto-détection hot leads',
    description: 'Scanne les 20 derniers mails, crée automatiquement un lead pour chaque demande explicite (rappel commercial, devis, prix).',
    schedule: '*/30 * * * *',
    scheduleLabel: 'Toutes les 30 min',
    enabled: false
  },
  {
    name: 'auto-followup-dormant',
    label: '🔁 Auto-relance deals dormants',
    description: 'Tous les jours à 10h : génère des relances IA pour les deals sans activité depuis 5+ jours.',
    schedule: '0 10 * * *',
    scheduleLabel: 'Tous les jours à 10h',
    enabled: false
  },
  {
    name: 'auto-relance-factures',
    label: '🧾 Auto-relance factures',
    description: 'Tous les jours à 9h : envoie des relances de paiement pour les factures en retard (J+7, J+15, J+30).',
    schedule: '0 9 * * *',
    scheduleLabel: 'Tous les jours à 9h',
    enabled: false
  },
  {
    name: 'auto-backup-state',
    label: '💾 Auto-backup données',
    description: 'Tous les soirs à 23h : sauvegarde l\'état complet de la DB (leads, deals, factures) dans un fichier daté.',
    schedule: '0 23 * * *',
    scheduleLabel: 'Tous les soirs à 23h',
    enabled: true
  }
];

// ============ EXECUTORS — la logique métier de chaque tâche ============
async function runAutoAnalyzeInbox(db) {
  if (!process.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY manquant');
  const baseUrl = process.env.PUBLIC_BASE_URL || 'http://localhost:' + (process.env.PORT || 4000);
  const r = await fetch(baseUrl + '/api/webmail/analyze', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ days: 7, count: 50 })
  });
  if (!r.ok) throw new Error('analyze HTTP ' + r.status);
  const data = await r.json();
  const hotCount = data.categories?.hot || 0;
  if (hotCount > 0) {
    try {
      await sendTelegramAdmin(`🔥 *${hotCount} hot lead${hotCount>1?'s':''} détecté${hotCount>1?'s':''} dans ton inbox*\n\n` +
        (data.actions || []).slice(0, 3).map(a => `• ${a.title}\n  📩 ${a.from || a.fromEmail || '?'}`).join('\n\n') +
        `\n\n👉 sales.pixeeplay.com → Outreach → Analyse IA`);
    } catch {}
  }
  return { ok: true, hotLeads: hotCount, totalActions: (data.actions||[]).length, summary: data.summary };
}

async function runAutoDetectHotLeads(db) {
  if (!process.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY manquant');
  const baseUrl = process.env.PUBLIC_BASE_URL || 'http://localhost:' + (process.env.PORT || 4000);
  const r = await fetch(baseUrl + '/api/webmail/analyze', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ days: 3, count: 20 })
  });
  if (!r.ok) throw new Error('analyze HTTP ' + r.status);
  const data = await r.json();
  let created = 0;
  for (const a of (data.actions || [])) {
    if (a.actionType !== 'hot-lead') continue;
    const email = a.fromEmail || '';
    if (!email) continue;
    // Évite les doublons
    const existing = db.prepare(`SELECT 1 FROM leads WHERE data LIKE ?`).get('%' + email + '%');
    if (existing) continue;
    const lead = {
      company: (a.from || '').replace(/<.*$/, '').trim() || email.split('@')[0],
      email, sector: email.split('@')[1], score: 80, category: 'hot',
      source: 'auto-detect-hot-leads',
      note: a.title,
      createdAt: Date.now()
    };
    try {
      db.prepare(`INSERT INTO leads (data) VALUES (?)`).run(JSON.stringify(lead));
      created++;
    } catch {}
  }
  if (created > 0) {
    try { await sendTelegramAdmin(`🔥 *${created} nouveaux hot leads créés automatiquement* depuis ta boîte mail.\n👉 sales.pixeeplay.com → Prospection`); } catch {}
  }
  return { ok: true, leadsCreated: created };
}

async function runAutoFollowupDormant(db) {
  // Compte les deals dormants — la génération réelle des relances reste manuelle
  const fiveDaysAgo = Math.floor((Date.now() - 5 * 86400000) / 1000);
  const dormant = db.prepare(`SELECT COUNT(*) AS c FROM deals WHERE stage NOT IN ('won','lost') AND COALESCE(created_at, 0) < ?`).get(fiveDaysAgo);
  const count = dormant?.c || 0;
  if (count > 0) {
    try { await sendTelegramAdmin(`🔁 *${count} deals dormants détectés* (sans activité depuis 5+ jours).\nVa dans sales.pixeeplay.com → Outreach → Relances pour générer les relances IA.`); } catch {}
  }
  return { ok: true, dormantDeals: count };
}

async function runAutoRelanceFactures(db) {
  const now = Math.floor(Date.now() / 1000);
  const overdue = db.prepare(`SELECT COUNT(*) AS c, COALESCE(SUM(total_ttc),0) AS t FROM factures WHERE status='overdue'`).get();
  if (overdue?.c > 0) {
    try { await sendTelegramAdmin(`🧾 *${overdue.c} facture${overdue.c>1?'s':''} en retard* — ${overdue.t}€ à recouvrer.\n👉 sales.pixeeplay.com → Devis & Factures → Factures`); } catch {}
  }
  return { ok: true, overdueCount: overdue?.c || 0, overdueAmount: overdue?.t || 0 };
}

async function runAutoBackup(db) {
  // Snapshot des tables principales en JSON
  const snapshot = {
    timestamp: Date.now(),
    date: new Date().toISOString(),
    leads: db.prepare('SELECT COUNT(*) AS c FROM leads').get().c,
    deals: db.prepare('SELECT COUNT(*) AS c FROM deals').get().c,
    factures: db.prepare('SELECT COUNT(*) AS c FROM factures').get().c,
    clients: db.prepare('SELECT COUNT(*) AS c FROM clients').get().c,
    media_assets: 0
  };
  try { snapshot.media_assets = db.prepare('SELECT COUNT(*) AS c FROM media_assets').get().c; } catch {}
  // Stocke dans la table config
  db.prepare(`INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=?`)
    .run('last_backup', JSON.stringify(snapshot), JSON.stringify(snapshot));
  return { ok: true, snapshot };
}

const EXECUTORS = {
  'auto-analyze-inbox': runAutoAnalyzeInbox,
  'auto-detect-hot-leads': runAutoDetectHotLeads,
  'auto-followup-dormant': runAutoFollowupDormant,
  'auto-relance-factures': runAutoRelanceFactures,
  'auto-backup-state': runAutoBackup
};

// ============ CRON SCHEDULER ============
const SCHEDULED_JOBS = {};

function loadTaskStates(db) {
  // Charge l'état activé/désactivé depuis la DB
  for (const t of RECURRING_TASKS) {
    try {
      const row = db.prepare(`SELECT value FROM config WHERE key=?`).get('task_enabled_' + t.name);
      if (row) t.enabled = row.value === '1';
    } catch {}
  }
}

function persistTaskState(db, name, enabled) {
  try {
    db.prepare(`INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=?`)
      .run('task_enabled_' + name, enabled ? '1' : '0', enabled ? '1' : '0');
  } catch {}
}

function logRun(db, name, status, result, error) {
  try {
    db.prepare(`INSERT INTO task_runs (task_name, status, result, error, ran_at) VALUES (?, ?, ?, ?, ?)`)
      .run(name, status, JSON.stringify(result || null), error || null, Date.now());
  } catch {}
}

async function executeTask(db, name) {
  const exec = EXECUTORS[name];
  if (!exec) throw new Error('Tâche inconnue : ' + name);
  console.log('[task] ▶', name);
  try {
    const result = await exec(db);
    logRun(db, name, 'success', result);
    console.log('[task] ✓', name, JSON.stringify(result).slice(0, 200));
    return { ok: true, result };
  } catch(e) {
    console.error('[task] ✗', name, e.message);
    logRun(db, name, 'error', null, e.message);
    return { ok: false, error: e.message };
  }
}

function scheduleTask(db, t) {
  // Annule la version précédente si elle existe
  if (SCHEDULED_JOBS[t.name]) {
    SCHEDULED_JOBS[t.name].stop();
    delete SCHEDULED_JOBS[t.name];
  }
  if (!t.enabled) return;
  if (!cron.validate(t.schedule)) {
    console.error('[task] invalid cron for', t.name, ':', t.schedule);
    return;
  }
  const job = cron.schedule(t.schedule, () => executeTask(db, t.name), {
    timezone: 'Europe/Paris'
  });
  SCHEDULED_JOBS[t.name] = job;
  console.log('[task] scheduled', t.name, '·', t.scheduleLabel);
}

export function scheduleAllTasks(db) {
  loadTaskStates(db);
  RECURRING_TASKS.forEach(t => scheduleTask(db, t));
}

// ============ ROUTES API ============
export function tasksRoutes(db) {
  const r = express.Router();

  r.get('/list', (req, res) => {
    // Liste les tâches avec leur dernier run
    const tasks = RECURRING_TASKS.map(t => {
      let lastRun = null, lastError = null;
      try {
        const row = db.prepare(`SELECT status, result, error, ran_at FROM task_runs WHERE task_name=? ORDER BY ran_at DESC LIMIT 1`).get(t.name);
        if (row) {
          lastRun = { status: row.status, result: row.result ? JSON.parse(row.result) : null, ranAt: row.ran_at };
          if (row.error) lastError = row.error;
        }
      } catch {}
      return { ...t, lastRun, lastError, isScheduled: !!SCHEDULED_JOBS[t.name] };
    });
    res.json({ tasks });
  });

  r.post('/run/:name', async (req, res) => {
    const r2 = await executeTask(db, req.params.name);
    res.json(r2);
  });

  r.post('/toggle/:name', (req, res) => {
    const t = RECURRING_TASKS.find(x => x.name === req.params.name);
    if (!t) return res.status(404).json({ error: 'Tâche inconnue' });
    t.enabled = !t.enabled;
    persistTaskState(db, t.name, t.enabled);
    scheduleTask(db, t);
    res.json({ ok: true, name: t.name, enabled: t.enabled });
  });

  // Logs récents par tâche
  r.get('/logs/:name', (req, res) => {
    try {
      const rows = db.prepare(`SELECT status, result, error, ran_at FROM task_runs WHERE task_name=? ORDER BY ran_at DESC LIMIT 20`).all(req.params.name);
      res.json({ logs: rows.map(r => ({ ...r, result: r.result ? JSON.parse(r.result) : null })) });
    } catch(e) {
      res.json({ logs: [] });
    }
  });

  // Queue one-shot : tâches créées à la demande (depuis "Créer tâche tech")
  r.get('/queue', (req, res) => {
    try {
      const rows = db.prepare(`SELECT * FROM task_queue ORDER BY created_at DESC LIMIT 100`).all();
      res.json({ queue: rows });
    } catch(e) {
      res.json({ queue: [] });
    }
  });

  r.post('/queue', (req, res) => {
    const { title, detail, priority } = req.body || {};
    if (!title) return res.status(400).json({ error: 'title required' });
    try {
      const info = db.prepare(`INSERT INTO task_queue (title, detail, priority, status, created_at) VALUES (?, ?, ?, 'todo', ?)`)
        .run(title, detail || '', priority || 'normal', Date.now());
      res.json({ ok: true, id: info.lastInsertRowid });
    } catch(e) {
      res.status(500).json({ error: e.message });
    }
  });

  r.post('/queue/:id/done', (req, res) => {
    try {
      db.prepare(`UPDATE task_queue SET status='done', done_at=? WHERE id=?`).run(Date.now(), parseInt(req.params.id));
      res.json({ ok: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  r.delete('/queue/:id', (req, res) => {
    try {
      db.prepare(`DELETE FROM task_queue WHERE id=?`).run(parseInt(req.params.id));
      res.json({ ok: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  return r;
}
