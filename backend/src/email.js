// Email via Gmail SMTP (Nodemailer) + cron 8h/12h/18h
import express from 'express';
import nodemailer from 'nodemailer';
import cron from 'node-cron';
import fetch from 'node-fetch';

function transporter() {
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: parseInt(process.env.SMTP_PORT || '587'),
    secure: false,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    }
  });
}

export function emailRoutes(db) {
  const r = express.Router();

  r.post('/send', async (req, res) => {
    try {
      const { to, subject, body, html } = req.body;
      if (!to || !subject) return res.status(400).json({ error: 'to + subject required' });
      const info = await transporter().sendMail({
        from: process.env.SMTP_FROM || `"PixeeSales-Alpha" <${process.env.SMTP_USER}>`,
        to, subject,
        text: body,
        html: html || `<pre style="font-family: sans-serif; white-space: pre-wrap;">${(body||'').replace(/&/g,'&amp;').replace(/</g,'&lt;')}</pre>`
      });
      res.json({ ok: true, messageId: info.messageId });
    } catch(e) {
      res.status(500).json({ error: e.message });
    }
  });

  r.get('/test', async (req, res) => {
    try {
      await transporter().verify();
      res.json({ ok: true, smtp: process.env.SMTP_HOST, user: process.env.SMTP_USER });
    } catch(e) {
      res.status(500).json({ error: e.message });
    }
  });

  return r;
}

// Cron rapports : 8h, 12h, 18h (Europe/Paris)
export function scheduleReports(db) {
  const SLOTS = [
    { cron: '0 8 * * *',  slot: 'morning',  title: 'Plan du jour 8h' },
    { cron: '0 12 * * *', slot: 'noon',     title: 'Bilan mi-journée 12h' },
    { cron: '0 18 * * *', slot: 'evening',  title: 'Synthèse fin de journée 18h' }
  ];

  for (const s of SLOTS) {
    cron.schedule(s.cron, async () => {
      try { await runReport(db, s.slot, s.title); }
      catch(e) { console.error('[cron report '+s.slot+']', e); }
    }, { timezone: 'Europe/Paris' });
  }
}

async function runReport(db, slot, title) {
  if (!process.env.GEMINI_API_KEY) return console.warn('[cron] No Gemini key');
  const to = process.env.REPORT_TO || 'arnaud@pixeeplay.com';

  // Stats DB
  const leads = db.prepare('SELECT COUNT(*) AS c FROM leads').get().c;
  const deals = db.prepare(`SELECT stage, COUNT(*) AS c, COALESCE(SUM(amount),0) AS total FROM deals GROUP BY stage`).all();
  const won = deals.find(d=>d.stage==='won') || {c:0, total:0};
  const factures = db.prepare(`SELECT COUNT(*) AS c, COALESCE(SUM(total_ttc),0) AS total FROM factures WHERE status != 'paid'`).get();

  const prompt = `Tu es PixeeSales-Alpha. Rédige un email court (12 lignes max) en français pour ${to}.

CONTEXTE : ${title} · objectif mensuel 10000€ · CA signé ${won.total}€ (${won.c} deals)
LEADS: ${leads}
PIPELINE: ${deals.filter(d=>d.stage!=='won').reduce((s,d)=>s+d.total,0)}€
FACTURES À ENCAISSER: ${factures.c} (${factures.total}€)

Format: intro 1 ligne · KPIs en bullets · 3 actions priorisées · signature "— PixeeSales-Alpha".`;

  const geminiRes = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${process.env.GEMINI_MODEL||'gemini-2.5-flash'}:generateContent?key=${process.env.GEMINI_API_KEY}`,
    { method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ contents:[{parts:[{text:prompt}]}] }) }
  );
  const data = await geminiRes.json();
  const body = data.candidates?.[0]?.content?.parts?.[0]?.text || '(Gemini vide)';
  const subject = 'PixeeSales-Alpha — '+title;

  try {
    const info = await transporter().sendMail({
      from: process.env.SMTP_FROM || `"PixeeSales-Alpha" <${process.env.SMTP_USER}>`,
      to, subject, text: body
    });
    db.prepare(`INSERT INTO reports (slot, subject, body, sent_to, sent_at) VALUES (?, ?, ?, ?, ?)`)
      .run(slot, subject, body, to, Date.now());
    console.log('[cron] ✓ Rapport '+slot+' envoyé à '+to);
  } catch(e) {
    console.error('[cron] envoi mail échec:', e.message);
    db.prepare(`INSERT INTO reports (slot, subject, body, sent_to, sent_at) VALUES (?, ?, ?, ?, NULL)`)
      .run(slot, subject, body, to);
  }
}
