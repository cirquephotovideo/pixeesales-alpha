// Cron autopilote : toutes les 15 min, prospection + génération
import cron from 'node-cron';
import fetch from 'node-fetch';

export function autopilotCron(db) {
  cron.schedule('*/15 * * * *', async () => {
    if (!process.env.AUTOPILOT_ENABLED || process.env.AUTOPILOT_ENABLED !== 'true') return;
    if (!process.env.GEMINI_API_KEY) return console.warn('[autopilot] No Gemini key');

    try {
      const icp = process.env.AUTOPILOT_ICP || 'PME française e-commerce avec catalogue produit complexe et site obsolète';
      const count = parseInt(process.env.AUTOPILOT_LEADS_PER_CYCLE || '3');
      const minScore = parseInt(process.env.AUTOPILOT_MIN_SCORE || '70');

      const prompt = `Trouve ${count} entreprises réelles correspondant à : "${icp}". Réponds UNIQUEMENT par un JSON array d'objets {company, url, sector, size, score, category, basket_eur, pain_points, pitch}.`;
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${process.env.GEMINI_MODEL||'gemini-2.5-flash'}:generateContent?key=${process.env.GEMINI_API_KEY}`, {
        method: 'POST', headers: {'Content-Type':'application/json'},
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          tools: [{ google_search: {} }]
        })
      });
      const data = await r.json();
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
      const match = text.match(/\[[\s\S]*\]/);
      if (!match) return console.warn('[autopilot] No JSON in Gemini response');
      const arr = JSON.parse(match[0]);

      let added = 0;
      for (const p of arr) {
        const existing = db.prepare(`SELECT id FROM leads WHERE json_extract(data, '$.company') = ?`).get(p.company);
        if (existing) continue;
        db.prepare(`INSERT INTO leads (data) VALUES (?)`).run(JSON.stringify(p));
        added++;
      }
      console.log(`[autopilot] +${added}/${arr.length} nouveaux leads`);

      // TODO : pour chaque lead hot (score >= minScore), générer cold email + envoyer
    } catch(e) {
      console.error('[autopilot]', e.message);
    }
  }, { timezone: 'Europe/Paris' });
}
