// PixeeSales-Alpha Backend Phase 1
// Express + SQLite + Bridge + Gmail + PDF + Cron

import express from 'express';
import cors from 'cors';
import 'dotenv/config';
import { initDB } from './db.js';
import { bridgeRoutes } from './bridge.js';
import { emailRoutes, scheduleReports } from './email.js';
import { pdfRoutes } from './pdf.js';
import { geminiRoutes } from './gemini.js';
import { dataRoutes } from './data.js';
import { autopilotCron } from './autopilot.js';
import { improvementRoutes, scheduleSelfImprovement } from './improvement.js';
import { telegramRoutes } from './telegram.js';
import { mediaRoutes } from './media.js';
import { webmailRoutes } from './webmail.js';
import { tasksRoutes, scheduleAllTasks } from './tasks.js';
import { devplansRoutes, scheduleDevPlans } from './devplans.js';

const app = express();
const PORT = process.env.PORT || 4000;

// CORS : accepter sales.pixeeplay.com + localhost
app.use(cors({
  origin: [
    'https://sales.pixeeplay.com',
    'https://agent.pixeeplay.com',
    'http://localhost:8765',
    'http://localhost:5173'
  ],
  credentials: true
}));
app.use(express.json({ limit: '10mb' }));

// Healthcheck
app.get('/health', (req, res) => res.json({ ok: true, service: 'pixeesales-backend', ts: Date.now() }));

// Init DB
const db = initDB(process.env.DB_PATH || './pixeesales.db');
app.locals.db = db;

// Routes
app.use('/api/bridge', bridgeRoutes(db));
app.use('/api/email', emailRoutes(db));
app.use('/api/pdf', pdfRoutes(db));
app.use('/api/gemini', geminiRoutes(db));
app.use('/api/data', dataRoutes(db));
app.use('/api/improvement', improvementRoutes(db));
app.use('/api/telegram', telegramRoutes(db));
app.use('/api/media', mediaRoutes(db));
app.use('/api/webmail', webmailRoutes(db));
app.use('/api/tasks', tasksRoutes(db));
app.use('/api/devplans', devplansRoutes(db));

// Catch-all errors
app.use((err, req, res, next) => {
  console.error('[ERR]', err);
  res.status(500).json({ error: err.message });
});

app.listen(PORT, () => {
  console.log(`🚀 PixeeSales backend on :${PORT}`);
  console.log(`   DB: ${process.env.DB_PATH || './pixeesales.db'}`);

  // Crons
  scheduleReports(db);
  autopilotCron(db);
  scheduleSelfImprovement(db);
  scheduleAllTasks(db);
  scheduleDevPlans(db);
  console.log(`   Crons : rapports 8h/12h/18h + autopilote 15min + self-improve 19h + 5 tâches background + auto-dev-plans 7h`);
});
