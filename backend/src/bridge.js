// Bridge API integration — server-side seulement (Client Secret jamais exposé)
import express from 'express';
import fetch from 'node-fetch';

const BRIDGE_BASE = 'https://api.bridgeapi.io';
const BRIDGE_VERSION = '2025-01-15';

function getCfg(env = 'sandbox') {
  // Bridge utilise la même URL — la séparation sandbox/prod se fait sur les credentials
  if (env === 'production') {
    return {
      clientId: process.env.BRIDGE_PROD_CLIENT_ID || process.env.BRIDGE_CLIENT_ID,
      clientSecret: process.env.BRIDGE_PROD_CLIENT_SECRET || process.env.BRIDGE_CLIENT_SECRET
    };
  }
  return {
    clientId: process.env.BRIDGE_CLIENT_ID,
    clientSecret: process.env.BRIDGE_CLIENT_SECRET
  };
}

function headers(env) {
  const cfg = getCfg(env);
  if (!cfg.clientId || !cfg.clientSecret) {
    const err = new Error('BRIDGE_CLIENT_ID / BRIDGE_CLIENT_SECRET non configurés sur le backend (env=' + env + ')');
    err.status = 500;
    throw err;
  }
  return {
    'Content-Type': 'application/json',
    'Bridge-Version': BRIDGE_VERSION,
    'Client-Id': cfg.clientId,
    'Client-Secret': cfg.clientSecret
  };
}

async function bridgeRequest(path, options = {}, env = 'sandbox') {
  const url = BRIDGE_BASE + path;
  const res = await fetch(url, {
    ...options,
    headers: { ...headers(env), ...(options.headers||{}) }
  });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!res.ok) {
    const err = new Error(`Bridge HTTP ${res.status}: ${JSON.stringify(data)}`);
    err.status = res.status; err.data = data;
    throw err;
  }
  return data;
}

export function bridgeRoutes(db) {
  const r = express.Router();

  // Crée ou récupère un user Bridge + access token
  r.post('/connect', async (req, res) => {
    try {
      const { external_user_id, env: reqEnv } = req.body;
      const env = (reqEnv === 'production') ? 'production' : 'sandbox';
      if (!external_user_id) return res.status(400).json({ error: 'external_user_id required' });

      // Récup user existant
      let row = db.prepare('SELECT * FROM bridge_users WHERE external_user_id = ?').get(external_user_id);
      let bridgeUuid = row?.bridge_uuid;

      if (!bridgeUuid) {
        try {
          const user = await bridgeRequest('/v2/users', {
            method: 'POST',
            body: JSON.stringify({ external_user_id })
          }, env);
          bridgeUuid = user.uuid;
        } catch(e) {
          if (e.data?.error_code === 'user_already_exists') {
            const list = await bridgeRequest(`/v2/users?external_user_id=${encodeURIComponent(external_user_id)}`, {}, env);
            bridgeUuid = list.resources?.[0]?.uuid;
          } else throw e;
        }
      }

      // Authorization token v3
      const token = await bridgeRequest('/v3/aggregation/authorization/token', {
        method: 'POST',
        body: JSON.stringify({ user_uuid: bridgeUuid })
      }, env);

      const expiresAt = Date.now() + (token.expires_at ? new Date(token.expires_at).getTime() - Date.now() : 2*3600*1000);
      db.prepare(`INSERT INTO bridge_users (external_user_id, bridge_uuid, access_token, token_expires_at)
                  VALUES (?, ?, ?, ?)
                  ON CONFLICT(external_user_id) DO UPDATE SET bridge_uuid=?, access_token=?, token_expires_at=?`)
        .run(external_user_id, bridgeUuid, token.access_token, expiresAt, bridgeUuid, token.access_token, expiresAt);

      // Create connect session
      const session = await bridgeRequest('/v3/aggregation/connect-sessions', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + token.access_token },
        body: JSON.stringify({ user_email: req.body.email || 'user@pixeeplay.com', country_code: 'fr' })
      }, env);

      res.json({ bridge_uuid: bridgeUuid, connect_url: session.url, expires_at: expiresAt, env });
    } catch(e) {
      res.status(e.status || 500).json({ error: e.message, detail: e.data });
    }
  });

  // Liste transactions pour un user
  r.get('/transactions/:external_user_id', async (req, res) => {
    try {
      const row = db.prepare('SELECT * FROM bridge_users WHERE external_user_id = ?').get(req.params.external_user_id);
      if (!row) return res.status(404).json({ error: 'User not connected' });

      const tx = await bridgeRequest('/v3/aggregation/transactions', {
        headers: { 'Authorization': 'Bearer ' + row.access_token }
      });

      // Cache en DB + matching auto factures
      const stmt = db.prepare(`INSERT OR IGNORE INTO bank_transactions
        (external_user_id, bridge_id, date, label, amount, currency, raw) VALUES (?, ?, ?, ?, ?, ?, ?)`);
      for (const t of tx.resources || []) {
        stmt.run(req.params.external_user_id, String(t.id), t.date, t.description||t.clean_description||'', t.amount, t.currency_code||'EUR', JSON.stringify(t));
      }

      // Matching factures
      const open = db.prepare(`SELECT id, ref, total_ttc FROM factures WHERE status != 'paid'`).all();
      const matchStmt = db.prepare(`UPDATE bank_transactions SET matched_facture_id = ? WHERE bridge_id = ? AND matched_facture_id IS NULL`);
      const payStmt = db.prepare(`UPDATE factures SET status = 'paid' WHERE id = ?`);
      for (const t of tx.resources || []) {
        if (t.amount > 0) {
          const match = open.find(f => Math.abs(f.total_ttc - t.amount) < 0.5);
          if (match) {
            matchStmt.run(match.id, String(t.id));
            payStmt.run(match.id);
          }
        }
      }

      res.json({ count: tx.resources?.length || 0, transactions: tx.resources });
    } catch(e) {
      res.status(500).json({ error: e.message, detail: e.data });
    }
  });

  // Webhook Bridge (account updated, etc.)
  r.post('/webhook', express.json(), (req, res) => {
    console.log('[Bridge webhook]', req.body);
    // TODO : ré-sync auto les transactions du user concerné
    res.json({ ok: true });
  });

  return r;
}
