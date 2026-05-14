# PixeeSales-Alpha Backend (Phase 1)

Node.js Express + SQLite backend pour le dashboard PixeeSales-Alpha.

## Fonctions

- **Bridge API** : connexion bancaire (sync transactions, matching auto factures)
- **Gmail SMTP** : envoi des cold emails et rapports
- **PDF native** : génération devis / factures avec branding
- **Gemini proxy** : appels Gemini server-side (clé cachée)
- **Cron** : 3 rapports/jour (8h/12h/18h) + autopilote toutes les 15min
- **SQLite** : persistance leads, deals, factures, clients, transactions, RAG

## Déploiement Coolify

1. **New Resource → Public Repository** : `https://github.com/cirquephotovideo/pixeesales-alpha`
2. **Base Directory** : `/backend`
3. **Build Pack** : Dockerfile
4. **Port exposé** : `4000`
5. **Persistent Storage** : monter un volume sur `/data` (pour la DB SQLite)
6. **Environment Variables** (voir `.env.example`) :
   - `GEMINI_API_KEY`, `BRIDGE_CLIENT_ID`, `BRIDGE_CLIENT_SECRET`
   - `SMTP_HOST`, `SMTP_USER`, `SMTP_PASS`
   - `REPORT_TO`, `AUTOPILOT_*`
7. **Domain** : `api.pixeeplay.com` (créer un CNAME → 51.75.31.123)

## API Endpoints

| Méthode | Path | Description |
|---|---|---|
| GET | `/health` | Healthcheck |
| POST | `/api/bridge/connect` | Initie le flow Bridge OAuth pour un user |
| GET | `/api/bridge/transactions/:user_id` | Récupère + sync les transactions |
| POST | `/api/bridge/webhook` | Webhook Bridge (account updated) |
| POST | `/api/email/send` | Envoi email arbitraire |
| GET | `/api/email/test` | Test config SMTP |
| POST | `/api/pdf/devis` | Génère un PDF devis |
| POST | `/api/pdf/facture` | Génère un PDF facture |
| POST | `/api/gemini/complete` | Proxy Gemini text generation |
| POST | `/api/gemini/embed` | Proxy Gemini embeddings |
| GET/POST/DELETE | `/api/data/{leads,deals,factures,clients,rag_docs}` | CRUD |
| GET | `/api/data/stats` | Stats globales |

## Crons actifs

| Cron | Slot | Action |
|---|---|---|
| `0 8 * * *` | morning | Email rapport 8h |
| `0 12 * * *` | noon | Email rapport 12h |
| `0 18 * * *` | evening | Email rapport 18h |
| `*/15 * * * *` | autopilot | Prospection auto (si AUTOPILOT_ENABLED=true) |

Timezone : Europe/Paris.

## Dev local

```bash
cd backend
cp .env.example .env
# Édite .env avec tes clés
npm install
npm run dev
# Le serveur tourne sur :4000
```

## Sécurité

- `BRIDGE_CLIENT_SECRET` et `SMTP_PASS` sont en env vars, jamais commitées
- CORS strict : seuls `sales.pixeeplay.com`, `agent.pixeeplay.com`, localhost sont autorisés
- Healthcheck `/health` accessible publiquement
