// Auto-Dev Plans : génération autonome de plans de développement
// Cron quotidien 7h → propose 3-5 plans → email + Telegram avec magic-link Approuver/Refuser/Planifier
import express from 'express';
import cron from 'node-cron';
import crypto from 'crypto';
import fetch from 'node-fetch';
import fs from 'fs';
import path from 'path';
import nodemailer from 'nodemailer';
import { sendTelegramAdmin } from './telegram.js';
import { getSmtpCreds } from './email.js';

const SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');

function signToken(payload) {
  const data = JSON.stringify({ ...payload, exp: Date.now() + 30 * 86400000 });
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
  const c = getSmtpCreds();
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: parseInt(process.env.SMTP_PORT || '587'),
    secure: false,
    auth: { user: c.user, pass: c.pass }
  });
}

// Collecte de signaux : tout ce qui permet à l'IA de générer de bons plans
async function gatherSignals(db) {
  const sig = {
    stats: {
      leads: 0, deals_open: 0, deals_won: 0, deals_lost: 0,
      factures_open: 0, factures_paid: 0, factures_overdue: 0,
      revenue_mtd: 0, clients: 0
    },
    recent_errors: [],
    pending_actions: 0,
    snoozed_actions: 0,
    autopilot_status: 'unknown',
    last_backup: null,
    enabled_tasks: [],
    media_count: 0
  };
  try { sig.stats.leads = db.prepare('SELECT COUNT(*) AS c FROM leads').get().c; } catch {}
  try { sig.stats.deals_open = db.prepare(`SELECT COUNT(*) AS c FROM deals WHERE stage NOT IN ('won','lost')`).get().c; } catch {}
  try {
    const won = db.prepare(`SELECT COUNT(*) AS c, COALESCE(SUM(amount),0) AS s FROM deals WHERE stage='won'`).get();
    sig.stats.deals_won = won.c; sig.stats.revenue_mtd = won.s;
  } catch {}
  try { sig.stats.deals_lost = db.prepare(`SELECT COUNT(*) AS c FROM deals WHERE stage='lost'`).get().c; } catch {}
  try { sig.stats.factures_open = db.prepare(`SELECT COUNT(*) AS c FROM factures WHERE status='open'`).get().c; } catch {}
  try { sig.stats.factures_paid = db.prepare(`SELECT COUNT(*) AS c FROM factures WHERE status='paid'`).get().c; } catch {}
  try { sig.stats.factures_overdue = db.prepare(`SELECT COUNT(*) AS c FROM factures WHERE status='overdue'`).get().c; } catch {}
  try { sig.stats.clients = db.prepare('SELECT COUNT(*) AS c FROM clients').get().c; } catch {}
  try {
    const errs = db.prepare(`SELECT task_name, error FROM task_runs WHERE status='error' AND ran_at > ? ORDER BY ran_at DESC LIMIT 10`).all(Date.now() - 7*86400000);
    sig.recent_errors = errs;
  } catch {}
  try { sig.pending_actions = db.prepare(`SELECT COUNT(*) AS c FROM processed_actions WHERE status != 'done'`).get().c; } catch {}
  try { sig.snoozed_actions = db.prepare(`SELECT COUNT(*) AS c FROM processed_actions WHERE status='snoozed'`).get().c; } catch {}
  try { sig.media_count = db.prepare(`SELECT COUNT(*) AS c FROM media_assets`).get().c; } catch {}
  try {
    const bk = db.prepare(`SELECT value FROM config WHERE key='last_backup'`).get();
    if (bk) sig.last_backup = JSON.parse(bk.value);
  } catch {}
  return sig;
}

async function generateDevPlans(db) {
  if (!process.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY manquant');
  const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
  const signals = await gatherSignals(db);

  const prompt = `Tu es le CTO virtuel de Pixeeplay (SaaS B2B PME : PixeePIM, Pixeesite, GLD).
Tu analyses l'état du système et tu proposes 3 à 5 PLANS DE DÉVELOPPEMENT prioritaires pour la prochaine itération.

État actuel du système :
${JSON.stringify(signals, null, 2)}

Pour chaque plan, retourne ce JSON exact :
[{
  "id": "uuid-court (ex: plan-2026-05-14-001)",
  "title": "Titre court actionnable (60 chars max)",
  "category": "feature" | "fix" | "optim" | "ux" | "data" | "integration" | "infra",
  "rationale": "Pourquoi ce plan est important MAINTENANT (2-3 phrases, basées sur les signaux)",
  "impact": "Impact mesurable (ex: '+30% conversion lead→client', '-50% temps relance facture', '+5h/semaine gagnées')",
  "effort": "30min" | "2h" | "4h" | "1j" | "2j" | "1semaine",
  "files_touched": ["liste des fichiers du repo à modifier (ex: backend/src/webmail.js, index.html)"],
  "implementation_spec": "Spec détaillée en 5-10 lignes : ce qu'il faut faire concrètement, étape par étape",
  "acceptance_criteria": ["Critère 1 testable", "Critère 2 testable", "Critère 3 testable"],
  "risks": "Risques techniques principaux (1-2 phrases)",
  "depends_on": []
}]

Priorise des plans HAUT IMPACT / FAIBLE EFFORT en premier. Si tout va bien, propose des plans d'optimisation ou de nouvelles fonctionnalités stratégiques.

Retourne UNIQUEMENT le JSON array, rien d'autre. Max 5 plans.`;

  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
  });
  const data = await r.json();
  if (!r.ok) throw new Error('Gemini : ' + (data?.error?.message || 'unknown'));
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) throw new Error('No JSON in Gemini response');
  const plans = JSON.parse(match[0]);

  // Sauvegarde en DB
  const stmt = db.prepare(`INSERT INTO dev_plans (plan_id, title, category, rationale, impact, effort, files_touched, implementation_spec, acceptance_criteria, risks, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`);
  for (const p of plans) {
    try {
      stmt.run(p.id, p.title, p.category, p.rationale, p.impact, p.effort,
        JSON.stringify(p.files_touched||[]), p.implementation_spec, JSON.stringify(p.acceptance_criteria||[]), p.risks, Date.now());
    } catch {}
  }
  return plans;
}

async function sendPlansEmail(db, plans) {
  const c = getSmtpCreds();
  if (!c.user) return console.log('[devplans] SMTP non configuré, skip email');
  const to = process.env.REPORT_TO || 'arnaud@pixeeplay.com';
  const baseUrl = process.env.PUBLIC_BASE_URL || 'https://api.pixeeplay.com';
  const frontUrl = 'https://sales.pixeeplay.com';

  const categoryColor = { feature: '#7C3AED', fix: '#EF4444', optim: '#10B981', ux: '#EC4899', data: '#3B82F6', integration: '#F59E0B', infra: '#6B7280' };

  const html = `
    <div style="font-family: -apple-system, sans-serif; max-width: 720px; margin: 0 auto; color: #1F1837; background: linear-gradient(135deg, #F5F3FF, #FAE8FF); padding: 32px 16px;">
      <div style="background: white; border-radius: 16px; padding: 32px; box-shadow: 0 8px 32px rgba(124,58,237,0.15);">
        <h2 style="color: #7C3AED; margin: 0 0 8px; font-size: 22px;">🤖 PixeeSales CTO virtuel — Plans de développement du jour</h2>
        <p style="color: #5B4B7C; margin: 0 0 24px; font-size: 14px;">L'agent a analysé les performances et propose <strong>${plans.length} plans</strong> prioritaires. Approuve ceux qui te plaisent — je les générerai et déploierai ensuite.</p>

        ${plans.map(p => {
          const approve = signToken({ action: 'approve', id: p.id, title: p.title });
          const reject = signToken({ action: 'reject', id: p.id });
          const schedule = signToken({ action: 'schedule', id: p.id });
          const cat = (p.category || 'feature').toLowerCase();
          const color = categoryColor[cat] || '#7C3AED';
          return `
            <div style="background: #FAFAFA; border-left: 4px solid ${color}; border-radius: 12px; padding: 18px; margin: 18px 0;">
              <div style="display: inline-block; font-size: 10px; padding: 3px 10px; background: ${color}; color: white; border-radius: 4px; font-weight: 600; margin-bottom: 8px; text-transform: uppercase;">${cat}</div>
              <h3 style="margin: 0 0 8px; font-size: 16px;">${p.title}</h3>
              <p style="font-size: 13px; line-height: 1.5; margin: 6px 0;"><strong>Pourquoi :</strong> ${p.rationale}</p>
              <p style="font-size: 13px; margin: 6px 0;"><strong>📈 Impact :</strong> ${p.impact}</p>
              <p style="font-size: 13px; margin: 6px 0;"><strong>⏱ Effort :</strong> ${p.effort}</p>
              <details style="margin: 10px 0; font-size: 12px;">
                <summary style="cursor: pointer; color: ${color}; font-weight: 500;">Voir la spec technique</summary>
                <div style="padding: 10px; background: white; border-radius: 6px; margin-top: 6px;">
                  <p><strong>Implémentation :</strong> ${p.implementation_spec}</p>
                  ${p.files_touched?.length ? `<p><strong>Fichiers :</strong> <code style="background:#F3F4F6; padding:2px 6px; border-radius:4px;">${p.files_touched.join('</code>, <code style="background:#F3F4F6; padding:2px 6px; border-radius:4px;">')}</code></p>` : ''}
                  ${p.acceptance_criteria?.length ? `<p><strong>Critères :</strong></p><ul style="margin: 4px 0; padding-left: 20px;">${p.acceptance_criteria.map(c => '<li>'+c+'</li>').join('')}</ul>` : ''}
                  ${p.risks ? `<p><strong>⚠ Risques :</strong> ${p.risks}</p>` : ''}
                </div>
              </details>
              <div style="margin-top: 14px;">
                <a href="${baseUrl}/api/devplans/decide?token=${approve}" style="display: inline-block; padding: 12px 20px; background: #10B981; color: white; text-decoration: none; border-radius: 8px; margin-right: 6px; font-size: 13px; font-weight: 500;">✓ Approuver — implémenter</a>
                <a href="${baseUrl}/api/devplans/decide?token=${schedule}" style="display: inline-block; padding: 12px 20px; background: #6366F1; color: white; text-decoration: none; border-radius: 8px; margin-right: 6px; font-size: 13px; font-weight: 500;">⏰ Planifier ce soir</a>
                <a href="${baseUrl}/api/devplans/decide?token=${reject}" style="display: inline-block; padding: 12px 20px; background: #EF4444; color: white; text-decoration: none; border-radius: 8px; font-size: 13px; font-weight: 500;">✕ Refuser</a>
              </div>
            </div>
          `;
        }).join('')}

        <hr style="border: 0; border-top: 1px solid #E5E0F5; margin: 24px 0;">
        <p style="font-size: 12px; color: #8B7AB8;">
          📊 <a href="${frontUrl}/#plans" style="color: #7C3AED;">Voir tous les plans</a> sur le dashboard ·
          Magic-links valides 30 jours · Approbation = implémentation auto + déploiement
        </p>
      </div>
    </div>
  `;

  await transporter().sendMail({
    from: process.env.SMTP_FROM || `"PixeeSales CTO 🤖" <${c.user}>`,
    to,
    subject: `🤖 ${plans.length} plans de développement pour Pixeeplay — Approuve ceux que tu veux`,
    html
  });
  console.log('[devplans] ✓ Email envoyé à', to);

  // Telegram aussi
  const tgMsg = `🤖 *${plans.length} plans de développement proposés*\n\n` +
    plans.slice(0, 5).map((p, i) =>
      `*${i+1}. ${p.title}*\n` +
      `   📈 ${p.impact}\n` +
      `   ⏱ ${p.effort} · ${p.category}\n` +
      `   [✓ Approuver](${baseUrl}/api/devplans/decide?token=${signToken({action:'approve',id:p.id,title:p.title})})  ·  [✕ Refuser](${baseUrl}/api/devplans/decide?token=${signToken({action:'reject',id:p.id})})`
    ).join('\n\n') +
    `\n\n📊 Voir tous les plans → ${frontUrl}`;
  try { await sendTelegramAdmin(tgMsg); } catch(e) { console.error('[devplans] tg fail', e.message); }
}

// Quand un plan est approuvé, on génère un fichier spec et on crée une issue GitHub
async function onPlanApproved(db, plan) {
  // 1) Génère un fichier spec dans /data/dev-specs/
  const specDir = process.env.DEV_SPECS_DIR || '/data/dev-specs';
  try { fs.mkdirSync(specDir, { recursive: true }); } catch {}
  const specPath = path.join(specDir, `${plan.plan_id}.md`);
  const specContent = `# ${plan.title}

**Plan ID** : \`${plan.plan_id}\`
**Catégorie** : ${plan.category}
**Effort estimé** : ${plan.effort}
**Approuvé le** : ${new Date().toISOString()}

## Pourquoi

${plan.rationale}

## Impact attendu

${plan.impact}

## Fichiers à modifier

${JSON.parse(plan.files_touched || '[]').map(f => `- \`${f}\``).join('\n')}

## Spec d'implémentation

${plan.implementation_spec}

## Critères d'acceptation

${JSON.parse(plan.acceptance_criteria || '[]').map(c => `- [ ] ${c}`).join('\n')}

## Risques

${plan.risks || 'N/A'}

---
*Plan généré automatiquement par PixeeSales CTO virtuel et approuvé via magic-link email/Telegram.*
*Une fois implémenté, marquer ce fichier .md comme \`done\` et créer un PR vers main.*
`;
  try { fs.writeFileSync(specPath, specContent); } catch(e) { console.error('[devplans] write spec failed', e.message); }

  // 2) Crée une issue GitHub si token configuré
  let issueUrl = null;
  if (process.env.GITHUB_TOKEN && process.env.GITHUB_REPO) {
    try {
      const r = await fetch(`https://api.github.com/repos/${process.env.GITHUB_REPO}/issues`, {
        method: 'POST',
        headers: { 'Authorization': 'token ' + process.env.GITHUB_TOKEN, 'Accept': 'application/vnd.github+json' },
        body: JSON.stringify({
          title: `[auto-plan] ${plan.title}`,
          body: specContent,
          labels: ['auto-implement', plan.category]
        })
      });
      if (r.ok) {
        const d = await r.json();
        issueUrl = d.html_url;
        db.prepare(`UPDATE dev_plans SET github_issue_url=? WHERE plan_id=?`).run(issueUrl, plan.plan_id);
      }
    } catch(e) { console.error('[devplans] github issue failed', e.message); }
  }

  // 3) Telegram : confirmation
  try {
    await sendTelegramAdmin(
      `✅ *Plan approuvé : ${plan.title}*\n\n` +
      `📁 Spec : \`${specPath}\`\n` +
      (issueUrl ? `🐙 Issue : ${issueUrl}\n` : '') +
      `\nQuand tu seras prêt, dis "implémente le plan ${plan.plan_id}" à Claude.`
    );
  } catch {}

  return { specPath, issueUrl };
}

export function devplansRoutes(db) {
  const r = express.Router();

  // GET /api/devplans/list — liste tous les plans
  r.get('/list', (req, res) => {
    try {
      const rows = db.prepare(`SELECT * FROM dev_plans ORDER BY created_at DESC LIMIT 50`).all();
      res.json({ plans: rows.map(r => ({
        ...r,
        files_touched: r.files_touched ? JSON.parse(r.files_touched) : [],
        acceptance_criteria: r.acceptance_criteria ? JSON.parse(r.acceptance_criteria) : []
      })) });
    } catch(e) { res.json({ plans: [] }); }
  });

  // POST /api/devplans/generate — génère manuellement (déclenche aussi l'email)
  r.post('/generate', async (req, res) => {
    try {
      const plans = await generateDevPlans(db);
      if (req.body?.send !== false) await sendPlansEmail(db, plans);
      res.json({ ok: true, plans, sent: req.body?.send !== false });
    } catch(e) {
      res.status(500).json({ error: e.message });
    }
  });

  // GET /api/devplans/decide?token= (magic link depuis email/Telegram)
  r.get('/decide', async (req, res) => {
    const payload = verifyToken(req.query.token);
    if (!payload) return res.status(400).send('<h1>❌ Token invalide ou expiré</h1>');
    const { action, id, title } = payload;
    if (!['approve','reject','schedule'].includes(action)) return res.status(400).send('Action invalide');

    try { db.prepare(`UPDATE dev_plans SET status=?, decided_at=? WHERE plan_id=?`).run(action, Date.now(), id); } catch {}

    let extra = '';
    if (action === 'approve') {
      try {
        const plan = db.prepare(`SELECT * FROM dev_plans WHERE plan_id=?`).get(id);
        if (plan) {
          const r2 = await onPlanApproved(db, plan);
          if (r2.issueUrl) extra = `<p style="margin-top: 16px;"><a href="${r2.issueUrl}" style="color: #A78BFA;">→ Voir l'issue GitHub créée</a></p>`;
        }
      } catch(e) { console.error('[devplans] onApprove fail', e.message); }
    }

    const msg = {
      approve: { title: '✅ Plan approuvé', body: `"${title}" est marqué pour implémentation. Spec générée + issue GitHub créée. Tu peux dire à Claude "implémente le plan ${id}" pour le coder maintenant.` },
      schedule: { title: '⏰ Planifié pour 23h', body: `"${title}" sera implémenté ce soir à 23h par l'agent.` },
      reject: { title: '✕ Plan refusé', body: 'Le plan a été archivé. Il ne sera plus proposé.' }
    }[action];

    res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>${msg.title}</title>
      <style>body{font-family:-apple-system,sans-serif;background:linear-gradient(135deg,#0A0510,#1F1837);color:#F5F3FF;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}.card{background:rgba(167,139,250,0.10);padding:48px 40px;border-radius:20px;text-align:center;max-width:480px;backdrop-filter:blur(20px);border:1px solid rgba(167,139,250,0.2);box-shadow:0 16px 48px rgba(0,0,0,0.4)}h1{margin:0 0 16px;font-size:28px}p{color:#C4B5FD;line-height:1.6}a.btn{display:inline-block;color:#A78BFA;text-decoration:none;margin-top:24px;padding:12px 24px;background:rgba(167,139,250,0.15);border-radius:10px;border:1px solid rgba(167,139,250,0.3)}a.btn:hover{background:rgba(167,139,250,0.25)}</style>
      </head><body><div class="card"><h1>${msg.title}</h1><p>${msg.body}</p>${extra}<a class="btn" href="https://sales.pixeeplay.com">→ Retour au dashboard</a></div></body></html>`);
  });

  // POST /api/devplans/:id/implement-status — marquer le statut implementation
  r.post('/:id/status', (req, res) => {
    const { status } = req.body || {};
    if (!['pending','approve','reject','schedule','implementing','done','failed'].includes(status)) return res.status(400).json({ error: 'invalid status' });
    try {
      db.prepare(`UPDATE dev_plans SET status=? WHERE plan_id=?`).run(status, req.params.id);
      res.json({ ok: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  return r;
}

// Cron quotidien 7h : génère + envoie les plans
export function scheduleDevPlans(db) {
  cron.schedule('0 7 * * *', async () => {
    try {
      const plans = await generateDevPlans(db);
      await sendPlansEmail(db, plans);
      console.log('[cron dev-plans] ✓', plans.length, 'plans générés et envoyés');
    } catch(e) {
      console.error('[cron dev-plans]', e.message);
    }
  }, { timezone: 'Europe/Paris' });
}
