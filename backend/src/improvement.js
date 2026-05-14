// Self-improvement loop : analyse quotidienne + propositions par email avec magic-link
import express from 'express';
import cron from 'node-cron';
import crypto from 'crypto';
import fetch from 'node-fetch';
import nodemailer from 'nodemailer';

const SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');

function signToken(payload) {
  const data = JSON.stringify({ ...payload, exp: Date.now() + 7 * 86400000 });
  const sig = crypto.createHmac('sha256', SECRET).update(data).digest('hex');
  return Buffer.from(data).toString('base64url') + '.' + sig;
}

function verifyToken(token) {
  if (!token || !token.includes('.')) return null;
  const [b64, sig] = token.split('.');
  const data = Buffer.from(b64, 'base64url').toString();
  const expected = crypto.createHmac('sha256', SECRET).update(data).digest('hex');
  if (sig !== expected) return null;
  const payload = JSON.parse(data);
  if (payload.exp < Date.now()) return null;
  return payload;
}

function transporter() {
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: parseInt(process.env.SMTP_PORT || '587'),
    secure: false,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
  });
}

async function generateProposals(db) {
  if (!process.env.GEMINI_API_KEY) throw new Error('No Gemini key');

  // Collecte des stats
  const stats = {
    leads: db.prepare('SELECT COUNT(*) AS c FROM leads').get().c,
    won: db.prepare(`SELECT COUNT(*) AS c, COALESCE(SUM(amount),0) AS t FROM deals WHERE stage='won'`).get(),
    lost: db.prepare(`SELECT COUNT(*) AS c FROM deals WHERE stage='lost'`).get().c,
    factures: db.prepare(`SELECT COUNT(*) AS c, COALESCE(SUM(total_ttc),0) AS t FROM factures`).get(),
    overdue: db.prepare(`SELECT COUNT(*) AS c FROM factures WHERE status='overdue'`).get().c
  };

  const prompt = `Tu es l'agent senior PixeeSales-Alpha qui analyse les perfs et propose des améliorations concrètes.

STATS DERNIÈRES 24H :
- Leads totaux : ${stats.leads}
- Deals won : ${stats.won.c} (CA ${stats.won.t}€)
- Deals lost : ${stats.lost}
- Factures émises : ${stats.factures.c} (${stats.factures.t}€)
- Factures en retard : ${stats.overdue}

Propose 3 améliorations concrètes à apporter au système pour augmenter les performances commerciales et opérationnelles.

Pour chaque proposition, retourne UNIQUEMENT un JSON valide :
[
  {
    "id": "uuid-court",
    "title": "Titre court actionnable",
    "category": "feature|fix|process|content",
    "rationale": "1-2 phrases pourquoi ça aide",
    "impact": "+15% taux réponse cold email",
    "effort": "30min|2h|1j",
    "implementation": "Description claire en 3-4 lignes de ce qu'il faut faire"
  }
]

3 propositions max, pas plus. Priorise les hauts impact / faible effort.`;

  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${process.env.GEMINI_MODEL||'gemini-2.5-flash'}:generateContent?key=${process.env.GEMINI_API_KEY}`, {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ contents:[{parts:[{text:prompt}]}] })
  });
  const data = await r.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) throw new Error('No JSON in response');
  return JSON.parse(match[0]);
}

async function sendProposalsEmail(db, proposals) {
  if (!process.env.SMTP_USER) return console.log('[self-improve] No SMTP, skip email');
  const to = process.env.REPORT_TO || 'arnaud@pixeeplay.com';
  const baseUrl = process.env.PUBLIC_BASE_URL || 'https://api.pixeeplay.com';

  const html = `
    <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
      <h2 style="color: #7C3AED;">🤖 PixeeSales-Alpha — Propositions d'évolution du jour</h2>
      <p>L'agent a analysé les performances des dernières 24h et propose ${proposals.length} améliorations :</p>
      ${proposals.map(p => {
        const approveToken = signToken({ action: 'approve', id: p.id, title: p.title });
        const rejectToken = signToken({ action: 'reject', id: p.id });
        const scheduleToken = signToken({ action: 'schedule', id: p.id });
        return `
          <div style="background: #F5F4EF; border-left: 4px solid #7C3AED; padding: 16px; margin: 16px 0; border-radius: 8px;">
            <h3 style="margin: 0 0 8px;">${p.title} <span style="font-size: 11px; color: #888;">(${p.category} · ${p.effort})</span></h3>
            <p><strong>Pourquoi :</strong> ${p.rationale}</p>
            <p><strong>Impact attendu :</strong> ${p.impact}</p>
            <p><strong>Implémentation :</strong> ${p.implementation}</p>
            <div style="margin-top: 12px;">
              <a href="${baseUrl}/api/improvement/decide?token=${approveToken}" style="display: inline-block; padding: 10px 18px; background: #10B981; color: white; text-decoration: none; border-radius: 6px; margin-right: 8px;">✓ Approuver maintenant</a>
              <a href="${baseUrl}/api/improvement/decide?token=${scheduleToken}" style="display: inline-block; padding: 10px 18px; background: #6366F1; color: white; text-decoration: none; border-radius: 6px; margin-right: 8px;">⏰ Pour ce soir 23h</a>
              <a href="${baseUrl}/api/improvement/decide?token=${rejectToken}" style="display: inline-block; padding: 10px 18px; background: #EF4444; color: white; text-decoration: none; border-radius: 6px;">✕ Refuser</a>
            </div>
          </div>
        `;
      }).join('')}
      <p style="font-size: 11px; color: #888; margin-top: 24px;">Magic links valides 7 jours. Une seule décision possible par proposition.</p>
    </div>
  `;

  await transporter().sendMail({
    from: process.env.SMTP_FROM || `"PixeeSales-Alpha" <${process.env.SMTP_USER}>`,
    to,
    subject: `🤖 ${proposals.length} propositions d'évolution pour PixeeSales-Alpha`,
    html
  });
  console.log('[self-improve] ✓ Email envoyé à', to);
}

export function improvementRoutes(db) {
  const r = express.Router();

  // Génération manuelle (pour tests)
  r.post('/propose', async (req, res) => {
    try {
      const proposals = await generateProposals(db);
      // Sauvegarder
      const stmt = db.prepare(`INSERT INTO improvement_proposals (proposal_id, title, category, rationale, impact, effort, implementation, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`);
      for (const p of proposals) {
        try { stmt.run(p.id, p.title, p.category, p.rationale, p.impact, p.effort, p.implementation); } catch {}
      }
      if (req.body.send !== false) await sendProposalsEmail(db, proposals);
      res.json({ proposals, sent: req.body.send !== false });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // Décision via magic-link (depuis email)
  r.get('/decide', (req, res) => {
    const payload = verifyToken(req.query.token);
    if (!payload) return res.status(400).send('Token invalide ou expiré.');
    const { action, id, title } = payload;
    const validActions = ['approve', 'reject', 'schedule'];
    if (!validActions.includes(action)) return res.status(400).send('Action invalide.');

    try {
      db.prepare(`UPDATE improvement_proposals SET status = ?, decided_at = ? WHERE proposal_id = ?`).run(action, Date.now(), id);
    } catch {}

    const msg = {
      approve: { title: '✅ Approuvé', body: `La proposition "${title}" sera implémentée immédiatement par l'agent.` },
      schedule: { title: '⏰ Planifié pour 23h', body: `La proposition "${title}" sera implémentée ce soir à 23h.` },
      reject:  { title: '✕ Refusé', body: 'La proposition a été archivée.' }
    }[action];
    res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>${msg.title}</title>
      <style>body{font-family:sans-serif;background:#0A0510;color:#F5F3FF;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}.card{background:rgba(167,139,250,0.1);padding:48px;border-radius:20px;text-align:center;max-width:400px;border:1px solid rgba(167,139,250,0.2)}h1{margin:0 0 16px}p{color:#C4B5FD}a{color:#A78BFA;display:inline-block;margin-top:16px}</style>
      </head><body><div class="card"><h1>${msg.title}</h1><p>${msg.body}</p><a href="https://sales.pixeeplay.com">→ Retour au dashboard</a></div></body></html>`);
  });

  // Liste des propositions
  r.get('/list', (req, res) => {
    const rows = db.prepare(`SELECT * FROM improvement_proposals ORDER BY created_at DESC LIMIT 50`).all();
    res.json(rows);
  });

  return r;
}

// Cron quotidien 19h
export function scheduleSelfImprovement(db) {
  cron.schedule('0 19 * * *', async () => {
    try {
      const proposals = await generateProposals(db);
      const stmt = db.prepare(`INSERT INTO improvement_proposals (proposal_id, title, category, rationale, impact, effort, implementation, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`);
      for (const p of proposals) {
        try { stmt.run(p.id, p.title, p.category, p.rationale, p.impact, p.effort, p.implementation); } catch {}
      }
      await sendProposalsEmail(db, proposals);
      console.log('[cron self-improve] ✓ Propositions générées et envoyées');
    } catch(e) {
      console.error('[cron self-improve]', e.message);
    }
  }, { timezone: 'Europe/Paris' });
}
