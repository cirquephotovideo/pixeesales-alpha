// Studio Media : Nano Banana (gemini-2.5-flash-image) + Veo (veo-2.0 / veo-3.0)
// Tous les appels côté serveur — la clé Gemini reste sur api.pixeeplay.com
import express from 'express';
import fetch from 'node-fetch';
import fs from 'fs';
import path from 'path';

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';

function key() {
  const k = process.env.GEMINI_API_KEY;
  if (!k) throw Object.assign(new Error('GEMINI_API_KEY non configurée sur le backend'), { status: 500 });
  return k;
}

// Stockage des médias générés sur disque (volume persistant Coolify si monté)
const MEDIA_DIR = process.env.MEDIA_DIR || '/data/media';
function ensureDir() {
  try { fs.mkdirSync(MEDIA_DIR, { recursive: true }); } catch {}
}

export function mediaRoutes(db) {
  ensureDir();
  const r = express.Router();

  // ------- LIST MODELS (debug) -------
  r.get('/models', async (req, res) => {
    try {
      const url = `${GEMINI_BASE}/models?key=${key()}&pageSize=200`;
      const rsp = await fetch(url);
      const data = await rsp.json();
      if (!rsp.ok) return res.status(rsp.status).json(data);
      const filtered = (data.models || []).filter(m =>
        /image|imagen|veo|nano/i.test(m.name) || /image|video/i.test((m.supportedGenerationMethods||[]).join(','))
      ).map(m => ({
        name: m.name,
        displayName: m.displayName,
        methods: m.supportedGenerationMethods,
        modalities: m.supportedActions || m.responseModalities
      }));
      res.json({ count: filtered.length, models: filtered, all: (data.models||[]).map(m=>m.name) });
    } catch(e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ------- IMAGE (Nano Banana / Gemini Image / Imagen — fallback chain) -------
  // POST /api/media/image  { prompt, ratio?, n?, model? }
  r.post('/image', async (req, res) => {
    try {
      const { prompt, ratio = '1:1', n = 1, model: modelIn } = req.body || {};
      if (!prompt) return res.status(400).json({ error: 'prompt required' });

      // Liste de modèles à essayer (du plus récent au plus vieux), si l'env ne force pas
      const envModel = process.env.NANO_BANANA_MODEL;
      const candidates = modelIn
        ? [modelIn]
        : (envModel
          ? [envModel]
          : [
              'gemini-2.5-flash-image',
              'gemini-2.0-flash-exp-image-generation',
              'gemini-2.0-flash-preview-image-generation',
              'imagen-3.0-generate-002',
              'imagen-3.0-generate-001'
            ]);

      const results = [];
      let usedModel = null;
      let lastErr = null;

      for (let i = 0; i < Math.min(n, 4); i++) {
        let success = false;
        for (const m of candidates) {
          const isImagen = /^imagen-/.test(m);
          const url = isImagen
            ? `${GEMINI_BASE}/models/${m}:predict?key=${key()}`
            : `${GEMINI_BASE}/models/${m}:generateContent?key=${key()}`;
          const body = isImagen
            ? {
                instances: [{ prompt }],
                parameters: { sampleCount: 1, aspectRatio: ratio, personGeneration: 'allow_adult' }
              }
            : {
                contents: [{ parts: [{ text: prompt }] }],
                generationConfig: { responseModalities: ['IMAGE'] }
              };

          const rsp = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
          });
          const data = await rsp.json();
          if (!rsp.ok) {
            lastErr = { model: m, status: rsp.status, error: data?.error?.message || JSON.stringify(data).slice(0,200) };
            continue;
          }

          // Extraction selon le type de modèle
          let extracted = [];
          if (isImagen) {
            const preds = data.predictions || [];
            for (const p of preds) {
              const b64 = p.bytesBase64Encoded || p.image?.bytesBase64Encoded;
              if (b64) extracted.push({ b64, mime: p.mimeType || 'image/png' });
            }
          } else {
            const parts = data.candidates?.[0]?.content?.parts || [];
            for (const p of parts) {
              const b64 = p.inlineData?.data || p.inline_data?.data;
              if (b64) extracted.push({ b64, mime: p.inlineData?.mimeType || p.inline_data?.mime_type || 'image/png' });
              else if (p.text) results.push({ text: p.text, model: m });
            }
          }

          for (const e of extracted) {
            const ext = e.mime.includes('jpeg') ? 'jpg' : e.mime.includes('webp') ? 'webp' : 'png';
            const fname = `img_${Date.now()}_${i}_${Math.random().toString(36).slice(2,7)}.${ext}`;
            try {
              fs.writeFileSync(path.join(MEDIA_DIR, fname), Buffer.from(e.b64, 'base64'));
              results.push({ url: `/api/media/file/${fname}`, mime: e.mime, prompt, ratio, model: m });
              try {
                db.prepare(`INSERT INTO media_assets (kind, file_name, mime, prompt, ratio, created_at) VALUES ('image', ?, ?, ?, ?, ?)`)
                  .run(fname, e.mime, prompt, ratio, Date.now());
              } catch {}
            } catch(err) {
              results.push({ dataUrl: `data:${e.mime};base64,${e.b64}`, mime: e.mime, prompt, ratio, model: m });
            }
          }
          if (extracted.length > 0) {
            success = true;
            usedModel = m;
            break;
          }
        }
        if (!success && !results.length) {
          return res.status(404).json({
            error: 'Aucun modèle image disponible avec ta clé.',
            lastError: lastErr,
            triedModels: candidates,
            hint: 'Sur AI Studio (aistudio.google.com), active "Image generation". Ou utilise Imagen. Appelle GET /api/media/models pour voir ce qui est dispo.'
          });
        }
      }

      res.json({ count: results.length, results, model: usedModel, triedModels: candidates });
    } catch(e) {
      res.status(e.status || 500).json({ error: e.message });
    }
  });

  // ------- VIDEO (Veo) -------
  // POST /api/media/video  { prompt, model?, duration?, ratio?, imageRef? }
  // Veo est asynchrone : retourne une operation_name à poller
  r.post('/video', async (req, res) => {
    try {
      const { prompt, model: modelIn, duration = 5, ratio = '16:9', imageRef } = req.body || {};
      if (!prompt) return res.status(400).json({ error: 'prompt required' });

      const model = modelIn || process.env.VEO_MODEL || 'veo-2.0-generate-001';
      const url = `${GEMINI_BASE}/models/${model}:predictLongRunning?key=${key()}`;

      const instance = { prompt };
      if (imageRef && imageRef.startsWith('data:')) {
        const m = imageRef.match(/^data:([^;]+);base64,(.*)$/);
        if (m) instance.image = { bytesBase64Encoded: m[2], mimeType: m[1] };
      }

      const rsp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          instances: [instance],
          parameters: {
            aspectRatio: ratio,
            durationSeconds: Math.min(Math.max(parseInt(duration) || 5, 2), 8),
            personGeneration: 'allow_adult'
          }
        })
      });
      const data = await rsp.json();
      if (!rsp.ok) {
        return res.status(rsp.status).json({ error: data?.error?.message || 'Veo error', detail: data });
      }

      const opName = data.name;
      try {
        db.prepare(`INSERT INTO media_assets (kind, operation_name, prompt, ratio, status, created_at) VALUES ('video', ?, ?, ?, 'pending', ?)`)
          .run(opName, prompt, ratio, Date.now());
      } catch {}

      res.json({ operation_name: opName, status: 'pending', model, prompt, ratio, duration });
    } catch(e) {
      res.status(e.status || 500).json({ error: e.message });
    }
  });

  // GET /api/media/video/status?op=operations/xxx
  r.get('/video/status', async (req, res) => {
    try {
      const op = req.query.op;
      if (!op) return res.status(400).json({ error: 'op required' });
      const url = `${GEMINI_BASE}/${op}?key=${key()}`;
      const rsp = await fetch(url);
      const data = await rsp.json();
      if (!rsp.ok) return res.status(rsp.status).json({ error: data?.error?.message, detail: data });

      if (data.done) {
        const videos = data.response?.generateVideoResponse?.generatedSamples
          || data.response?.generatedSamples
          || data.response?.predictions
          || [];
        const out = [];
        for (let i = 0; i < videos.length; i++) {
          const v = videos[i];
          const fileUri = v.video?.uri || v.uri || v.videoUri || v.video?.fileUri;
          const b64 = v.video?.bytesBase64Encoded || v.bytesBase64Encoded;
          if (b64) {
            const fname = `vid_${Date.now()}_${i}.mp4`;
            try {
              fs.writeFileSync(path.join(MEDIA_DIR, fname), Buffer.from(b64, 'base64'));
              out.push({ url: `/api/media/file/${fname}`, mime: 'video/mp4' });
              db.prepare(`UPDATE media_assets SET file_name=?, status='ready' WHERE operation_name=?`).run(fname, op);
            } catch {
              out.push({ dataUrl: `data:video/mp4;base64,${b64}` });
            }
          } else if (fileUri) {
            // Télécharger depuis Google et stocker localement
            try {
              const dl = await fetch(`${fileUri}&key=${key()}`);
              if (dl.ok) {
                const buf = Buffer.from(await dl.arrayBuffer());
                const fname = `vid_${Date.now()}_${i}.mp4`;
                fs.writeFileSync(path.join(MEDIA_DIR, fname), buf);
                out.push({ url: `/api/media/file/${fname}`, mime: 'video/mp4' });
                db.prepare(`UPDATE media_assets SET file_name=?, status='ready' WHERE operation_name=?`).run(fname, op);
              } else {
                out.push({ remoteUri: fileUri });
              }
            } catch {
              out.push({ remoteUri: fileUri });
            }
          }
        }
        return res.json({ done: true, videos: out });
      }
      res.json({ done: false, progress: data.metadata?.progressPercent || null });
    } catch(e) {
      res.status(500).json({ error: e.message });
    }
  });

  // GET /api/media/file/:name  — sert les fichiers générés
  r.get('/file/:name', (req, res) => {
    const safe = (req.params.name || '').replace(/[^a-zA-Z0-9._-]/g, '');
    const fpath = path.join(MEDIA_DIR, safe);
    if (!fs.existsSync(fpath)) return res.status(404).send('Not found');
    res.sendFile(fpath);
  });

  // GET /api/media/list  — liste des assets générés
  r.get('/list', (req, res) => {
    try {
      const rows = db.prepare(`SELECT * FROM media_assets ORDER BY created_at DESC LIMIT 100`).all();
      res.json(rows);
    } catch(e) {
      res.json([]);
    }
  });

  return r;
}
