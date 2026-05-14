# PixeeSales-Alpha

Directeur commercial augmenté — agent autonome de prospection, qualification et closing pour la suite Pixeeplay (PixeePIM, Pixeesite, GLD, IA SaaS).

## Aperçu

Dashboard 100% client (single-page HTML) avec :

- **Autopilote** — l'agent tourne en boucle, trouve des leads via Gemini Search, qualifie, enrichit, envoie les cold emails
- **Prospection IA** — recherche automatique de PME françaises correspondant à un ICP
- **Qualification scoring** — score 1-100, catégorie hot/warm/cold, points de douleur, pitch personnalisé
- **Générateur d'outreach** — cold emails, relances, messages LinkedIn, scripts d'appel Vapi, argumentaires devis
- **Pipeline commercial** — 5 étapes (Prospect → Contacté → RDV → Devis → Signé)
- **Rapports quotidiens** — 8h / 12h / 18h envoyés automatiquement à l'équipe
- **9 connecteurs intégrés** — Gmail, PhantomBuster, Vapi, Bland, PandaDoc, Apollo, HubSpot, Stripe, Zapier

## Stack

- HTML/CSS/JS vanilla — aucune build step
- Chart.js (CDN jsdelivr) pour la trajectoire CA
- Gemini API (clé fournie par l'utilisateur) pour l'IA
- Jina Reader pour le scraping de pages web
- Webhook Zapier/Make pour relayer les actions vers les outils SaaS
- LocalStorage pour la persistance

## Configuration requise

L'utilisateur fournit sa clé API Gemini gratuitement sur [aistudio.google.com/apikey](https://aistudio.google.com/apikey) (1 500 requêtes/jour gratuites). Aucune clé n'est stockée côté serveur — tout reste dans le navigateur de l'utilisateur.

## Déploiement

### Coolify (recommandé)

1. Dans Coolify → New Resource → Public Repository
2. URL : `https://github.com/pixeeplay/pixeesales-alpha`
3. Branch : `main`
4. Build Pack : `Dockerfile`
5. Port : `80`
6. Domaine personnalisé : ajouter `sales.pixeeplay.com` (ou autre)
7. Deploy

Le `Dockerfile` build une image nginx alpine légère (~25 MB), le `nginx.conf` ajoute compression gzip, cache static assets et headers de sécurité.

### Local (développement)

```bash
docker build -t pixeesales-alpha .
docker run -p 8080:80 pixeesales-alpha
# Puis ouvrir http://localhost:8080
```

Ou sans Docker :

```bash
python3 -m http.server 8765
# Puis ouvrir http://localhost:8765
```

## Architecture

```
┌─────────────────────────────────────────────┐
│  Navigateur utilisateur                     │
│  ┌────────────────────────────────────────┐ │
│  │  PixeeSales-Alpha (index.html)         │ │
│  │  ├─ Autopilote (setInterval)           │ │
│  │  ├─ State (localStorage)               │ │
│  │  └─ UI (vanilla JS)                    │ │
│  └────┬─────────────┬──────────────┬──────┘ │
└───────┼─────────────┼──────────────┼────────┘
        │             │              │
        ▼             ▼              ▼
   Gemini API   Jina Reader    Zapier Webhook
   (qualif IA)  (scraping)     (Gmail, Vapi,
                                 HubSpot, etc.)
```

## Sécurité

- Aucune donnée envoyée à un serveur tiers sauf APIs explicitement configurées (Gemini, etc.)
- Clés API stockées en `localStorage` du navigateur uniquement
- Headers nginx : X-Frame-Options, X-Content-Type-Options, Referrer-Policy
- Pas de cookies, pas de tracking

## Roadmap

- [ ] Mode multi-utilisateur (sync via Supabase)
- [ ] Intégration native LinkedIn API
- [ ] Module appels Vapi avec rejoining live
- [ ] Génération de devis PDF inline
- [ ] Webhook entrant (incoming leads de Pixeesite)

## Licence

Propriétaire — Pixeeplay © 2026.
