// CRUD pour les entités : leads, deals, factures, clients, rag_docs
import express from 'express';

export function dataRoutes(db) {
  const r = express.Router();

  // Helper générique
  const tables = ['leads', 'deals', 'factures', 'clients', 'rag_docs'];
  for (const t of tables) {
    r.get('/'+t, (req, res) => {
      const rows = db.prepare(`SELECT * FROM ${t} ORDER BY created_at DESC LIMIT 500`).all();
      res.json(rows.map(r => ({ ...r, data: tryParse(r.data) })));
    });

    r.post('/'+t, (req, res) => {
      const data = JSON.stringify(req.body);
      const extras = {};
      if (t === 'deals') { extras.stage = req.body.stage; extras.amount = req.body.amount; }
      if (t === 'factures') { extras.ref = req.body.ref; extras.total_ttc = req.body.totalTTC; extras.status = req.body.status; }
      if (t === 'clients') { extras.siret = req.body.siret; }

      const cols = ['data', ...Object.keys(extras)];
      const vals = [data, ...Object.values(extras)];
      const placeholders = cols.map(() => '?').join(',');
      const result = db.prepare(`INSERT INTO ${t} (${cols.join(',')}) VALUES (${placeholders})`).run(...vals);
      res.json({ id: result.lastInsertRowid });
    });

    r.delete('/'+t+'/:id', (req, res) => {
      db.prepare(`DELETE FROM ${t} WHERE id = ?`).run(req.params.id);
      res.json({ ok: true });
    });
  }

  // Stats globales pour le dashboard
  r.get('/stats', (req, res) => {
    const stats = {
      leads: db.prepare('SELECT COUNT(*) AS c FROM leads').get().c,
      deals: db.prepare('SELECT COUNT(*) AS c FROM deals').get().c,
      won: db.prepare(`SELECT COUNT(*) AS c, COALESCE(SUM(amount),0) AS total FROM deals WHERE stage='won'`).get(),
      pipeline: db.prepare(`SELECT COUNT(*) AS c, COALESCE(SUM(amount),0) AS total FROM deals WHERE stage NOT IN ('won','lost')`).get(),
      factures_open: db.prepare(`SELECT COUNT(*) AS c, COALESCE(SUM(total_ttc),0) AS total FROM factures WHERE status != 'paid'`).get(),
      transactions: db.prepare('SELECT COUNT(*) AS c FROM bank_transactions').get().c
    };
    res.json(stats);
  });

  return r;
}

function tryParse(s) {
  try { return JSON.parse(s); } catch { return s; }
}
