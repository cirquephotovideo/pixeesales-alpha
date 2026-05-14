// Webmail : IMAP (lecture) + nodemailer (envoi) + analyse IA Gemini
import express from 'express';
import nodemailer from 'nodemailer';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import fetch from 'node-fetch';
import { getSmtpCreds } from './email.js';

function imapConfig() {
  const creds = getSmtpCreds();
  if (!creds.user || !creds.pass) return null;
  return {
    host: process.env.IMAP_HOST || 'imap.gmail.com',
    port: parseInt(process.env.IMAP_PORT || '993'),
    secure: true,
    auth: { user: creds.user, pass: creds.pass },
    logger: false
  };
}

function smtpTransporter() {
  const creds = getSmtpCreds();
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: parseInt(process.env.SMTP_PORT || '587'),
    secure: false,
    auth: { user: creds.user, pass: creds.pass }
  });
}

// Cache léger des messages (par UID) pour éviter de re-fetch
const MSG_CACHE = new Map();
const CACHE_TTL = 5 * 60 * 1000;

function categorize(msg) {
  const subj = (msg.subject || '').toLowerCase();
  const from = (msg.from || '').toLowerCase();
  const body = (msg.preview || '').toLowerCase();
  const txt = subj + ' ' + from + ' ' + body;
  if (/spam|unsubscribe|désabonner|promo|sale|black friday|newsletter|noreply|no-reply/i.test(txt)) return 'spam';
  if (/facture|paiement|invoice|payment|due|impayé|relance/i.test(txt)) return 'client';
  if (/support|bug|aide|help|problem|incident|panne/i.test(txt)) return 'support';
  if (/devis|tarif|prix|quote|pricing|combien|coût|cout|info produit|demande info|intéress|interesse/i.test(txt)) return 'hot';
  if (/rdv|rendez-vous|call|meeting|disponible|réunion|reunion|demo|présentation|presentation/i.test(txt)) return 'lead';
  return null;
}

export function webmailRoutes(db) {
  const r = express.Router();

  // ----------- LIST INBOX -----------
  // GET /api/webmail/list?folder=INBOX&q=&limit=50
  r.get('/list', async (req, res) => {
    const cfg = imapConfig();
    if (!cfg) return res.status(503).json({
      error: 'IMAP non configuré',
      hint: 'Ajoute SMTP_USER + SMTP_PASS (App Password Gmail 16 caractères) dans les Environment Variables Coolify du backend. L\'IMAP réutilise ces credentials.'
    });

    const folder = req.query.folder || 'INBOX';
    const q = (req.query.q || '').trim();
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);

    const client = new ImapFlow(cfg);
    try {
      await client.connect();
      await client.mailboxOpen(folder);

      // Critères : si q, full-text search sinon les N derniers
      let uids;
      if (q) {
        uids = await client.search({ or: [{ subject: q }, { from: q }, { body: q }] });
      } else {
        const status = await client.status(folder, { messages: true });
        const total = status.messages || 0;
        if (!total) { await client.logout(); return res.json({ messages: [], total: 0 }); }
        // Récupère les UIDs des N derniers (par seq inversée)
        uids = [];
        const start = Math.max(1, total - limit + 1);
        for (let seq = total; seq >= start; seq--) uids.push(seq);
      }

      const items = [];
      const fetched = await client.fetch(
        q ? uids.slice(-limit).reverse() : uids,
        { envelope: true, flags: true, bodyStructure: true, bodyParts: ['TEXT'], uid: true }
      );

      for await (const msg of fetched) {
        const env = msg.envelope || {};
        const fromObj = (env.from || [])[0] || {};
        const fromName = fromObj.name || '';
        const fromAddress = (fromObj.address || '').toLowerCase();
        // Body preview (max 200 chars)
        let preview = '';
        try {
          const txtPart = msg.bodyParts?.get('TEXT');
          if (txtPart) preview = txtPart.toString('utf8').replace(/<[^>]+>/g,'').replace(/\s+/g,' ').trim().slice(0, 200);
        } catch {}
        const item = {
          uid: msg.uid,
          subject: env.subject || '',
          from: fromAddress || (fromName ? fromName : ''),
          fromName: fromName || fromAddress,
          fromAddress,
          date: env.date,
          messageId: env.messageId,
          unread: !msg.flags?.has('\\Seen'),
          preview
        };
        item.category = categorize(item);
        items.push(item);
      }
      await client.logout();

      // Tri décroissant par date
      items.sort((a,b) => new Date(b.date||0) - new Date(a.date||0));
      res.json({ messages: items, total: items.length, folder });
    } catch(e) {
      try { await client.logout(); } catch {}
      res.status(500).json({ error: e.message, hint: 'Vérifie le App Password Gmail et que l\'IMAP est activé sur le compte.' });
    }
  });

  // ----------- READ ONE -----------
  // GET /api/webmail/message?uid=&folder=
  r.get('/message', async (req, res) => {
    const cfg = imapConfig();
    if (!cfg) return res.status(503).json({ error: 'IMAP non configuré' });
    const uid = parseInt(req.query.uid);
    const folder = req.query.folder || 'INBOX';
    if (!uid) return res.status(400).json({ error: 'uid required' });

    const cacheKey = folder + ':' + uid;
    const cached = MSG_CACHE.get(cacheKey);
    if (cached && (Date.now() - cached.t < CACHE_TTL)) return res.json(cached.data);

    const client = new ImapFlow(cfg);
    try {
      await client.connect();
      await client.mailboxOpen(folder);
      const msg = await client.fetchOne(uid, { source: true, envelope: true, flags: true }, { uid: true });
      if (!msg) { await client.logout(); return res.status(404).json({ error: 'Message introuvable' }); }
      const parsed = await simpleParser(msg.source);
      // Marque comme lu
      try { await client.messageFlagsAdd(uid, ['\\Seen'], { uid: true }); } catch {}
      await client.logout();

      const fromObj = (parsed.from?.value || [])[0] || {};
      const data = {
        uid,
        subject: parsed.subject || '',
        from: parsed.from?.text || '',
        fromName: fromObj.name || '',
        fromAddress: fromObj.address || '',
        to: parsed.to?.text || '',
        date: parsed.date,
        messageId: parsed.messageId,
        text: parsed.text || '',
        html: parsed.html || '',
        attachments: (parsed.attachments || []).map(a => ({ filename: a.filename, size: a.size, mime: a.contentType }))
      };
      MSG_CACHE.set(cacheKey, { t: Date.now(), data });
      res.json(data);
    } catch(e) {
      try { await client.logout(); } catch {}
      res.status(500).json({ error: e.message });
    }
  });

  // ----------- REPLY / SEND -----------
  // POST /api/webmail/reply  { to, subject, body, in_reply_to?, html? }
  r.post('/reply', async (req, res) => {
    if (!process.env.SMTP_USER) return res.status(503).json({ error: 'SMTP non configuré' });
    const { to, subject, body, html, in_reply_to } = req.body || {};
    if (!to || !subject || !body) return res.status(400).json({ error: 'to + subject + body requis' });
    try {
      const info = await smtpTransporter().sendMail({
        from: process.env.SMTP_FROM || `"Pixeeplay" <${process.env.SMTP_USER}>`,
        to, subject,
        text: body,
        html: html || body.replace(/\n/g, '<br>'),
        inReplyTo: in_reply_to || undefined,
        references: in_reply_to || undefined
      });
      res.json({ ok: true, messageId: info.messageId });
    } catch(e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ----------- AI REPLY DRAFT -----------
  // POST /api/webmail/ai-reply { from, subject, original }
  r.post('/ai-reply', async (req, res) => {
    if (!process.env.GEMINI_API_KEY) return res.status(503).json({ error: 'GEMINI_API_KEY non configurée' });
    const { from, subject, original } = req.body || {};
    const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
    const prompt = `Tu rédiges une réponse email en français, brève et professionnelle, pour Pixeeplay (SaaS B2B : PixeePIM, Pixeesite, GLD).
Expéditeur : ${from}
Sujet : ${subject}
Message original :
"""
${(original||'').slice(0, 4000)}
"""

Rédige UNIQUEMENT le corps de la réponse (sans "Objet :", sans signature — l'utilisateur signera lui-même). 80-150 mots max. Si une question est posée, réponds. Si c'est une demande info, propose un RDV 15 min via Calendly. Reste chaleureux mais direct.`;

    try {
      const r2 = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
      });
      const d = await r2.json();
      if (!r2.ok) return res.status(r2.status).json({ error: d?.error?.message || 'Gemini error', detail: d });
      const draft = d.candidates?.[0]?.content?.parts?.[0]?.text || '';
      res.json({ draft, model });
    } catch(e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ----------- AI ANALYZE INBOX -----------
  // POST /api/webmail/analyze { days, count }
  r.post('/analyze', async (req, res) => {
    const cfg = imapConfig();
    if (!cfg) return res.status(503).json({ error: 'IMAP non configuré' });
    if (!process.env.GEMINI_API_KEY) return res.status(503).json({ error: 'GEMINI_API_KEY non configurée' });

    const days = parseInt(req.body?.days || 30);
    const count = Math.min(parseInt(req.body?.count || 50), 200);
    const since = new Date(Date.now() - days * 86400 * 1000);

    const client = new ImapFlow(cfg);
    let messages = [];
    try {
      await client.connect();
      await client.mailboxOpen('INBOX');
      const uids = await client.search({ since });
      const slice = (uids || []).slice(-count);
      const fetched = await client.fetch(slice, { envelope: true, bodyParts: ['TEXT'], uid: true });
      for await (const msg of fetched) {
        const env = msg.envelope || {};
        const fromObj = (env.from || [])[0] || {};
        let preview = '';
        try {
          const t = msg.bodyParts?.get('TEXT');
          if (t) preview = t.toString('utf8').replace(/<[^>]+>/g,'').replace(/\s+/g,' ').trim().slice(0, 400);
        } catch {}
        messages.push({
          uid: msg.uid,
          subject: env.subject || '',
          from: fromObj.address || '',
          fromName: fromObj.name || '',
          date: env.date,
          preview
        });
      }
      await client.logout();
    } catch(e) {
      try { await client.logout(); } catch {}
      return res.status(500).json({ error: 'IMAP : ' + e.message });
    }

    if (!messages.length) return res.json({ categories: {}, actions: [], summary: 'Boîte vide sur la période.' });

    // Catégorisation déterministe + IA pour les actions
    const categories = { hot: 0, lead: 0, client: 0, support: 0, spam: 0, other: 0 };
    for (const m of messages) {
      const c = categorize(m);
      if (c) categories[c]++;
      else categories.other++;
    }

    // IA : extrait actions prioritaires
    const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
    const sample = messages.slice(0, 30).map((m, i) => `[uid:${m.uid}] De: ${m.fromName} <${m.from}> · Sujet: ${m.subject}\n   Aperçu: ${m.preview.slice(0,200)}`).join('\n\n');
    const prompt = `Tu analyses la boîte mail de Pixeeplay (SaaS B2B PME). Identifie les 5 actions PRIORITAIRES à entreprendre.

Pour chaque action, retourne ce JSON exact :
[{
  "title": "Titre court (max 60 chars)",
  "detail": "Pourquoi c'est urgent (1-2 phrases)",
  "from": "Nom et email de l'expéditeur",
  "fromEmail": "email seul",
  "uid": <uid du mail concerné>,
  "actionType": "hot-lead" | "partnership" | "payment-issue" | "invoice-pending" | "tech-update" | "support" | "churn-risk" | "opportunity",
  "urgency": "high" | "medium" | "low",
  "suggestion": "Action concrète à faire (1-2 phrases)",
  "ctaLabel": "Label court du bouton principal (ex: Rappeler maintenant, Régulariser, Payer facture, Créer lead)",
  "ctaUrl": "URL si pertinent (ex: lien facture, lien billing) ou null"
}]

Critères de priorité (du plus urgent au moins) :
1. hot-lead : demande explicite de RDV / prix / devis / rappel commercial
2. churn-risk : client mécontent / risque de partir
3. payment-issue : échec paiement / CB invalide / suspension service imminent
4. invoice-pending : facture à payer
5. partnership : opportunité commerciale entrante
6. tech-update : mise à jour technique requise (API keys, credentials)
7. support : ticket critique
8. opportunity : autre

Mails à analyser :
${sample}

Retourne UNIQUEMENT le JSON array, rien d'autre. Max 5 actions. Si rien d'urgent, retourne [].`;

    try {
      const r2 = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
      });
      const d = await r2.json();
      const text = d.candidates?.[0]?.content?.parts?.[0]?.text || '[]';
      const match = text.match(/\[[\s\S]*\]/);
      let actions = [];
      try { actions = match ? JSON.parse(match[0]) : []; } catch {}

      const summary = `Sur ${messages.length} mails (${days} j) : ${categories.hot} hot lead${categories.hot>1?'s':''}, ${categories.lead} lead${categories.lead>1?'s':''}, ${categories.client} mail${categories.client>1?'s':''} client, ${categories.support} support, ${categories.spam} spam/promo.`;
      res.json({ categories, actions: actions.slice(0, 5), summary, total: messages.length });
    } catch(e) {
      res.status(500).json({ error: 'IA : ' + e.message, categories });
    }
  });

  return r;
}
