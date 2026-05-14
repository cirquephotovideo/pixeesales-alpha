// Proxy Gemini server-side (le frontend appelle ici, on appelle Gemini avec la clé serveur)
import express from 'express';
import fetch from 'node-fetch';

export function geminiRoutes(db) {
  const r = express.Router();

  r.post('/complete', async (req, res) => {
    try {
      const { prompt, model = 'gemini-2.5-flash', temperature = 0.7, search = false } = req.body;
      if (!prompt) return res.status(400).json({ error: 'prompt required' });
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`;
      const body = {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature, maxOutputTokens: 4096 }
      };
      if (search) body.tools = [{ google_search: {} }];
      const r2 = await fetch(url, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
      const data = await r2.json();
      res.json({ text: data.candidates?.[0]?.content?.parts?.[0]?.text || '', raw: data });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  r.post('/embed', async (req, res) => {
    try {
      const { text } = req.body;
      const url = `https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent?key=${process.env.GEMINI_API_KEY}`;
      const r2 = await fetch(url, { method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ model:'models/text-embedding-004', content:{ parts:[{text:(text||'').slice(0,8000)}] } }) });
      const data = await r2.json();
      res.json({ embedding: data.embedding?.values });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  return r;
}
