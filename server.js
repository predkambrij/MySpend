const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const argon2 = require('argon2');
const cookieParser = require('cookie-parser');
const express = require('express');
const rateLimit = require('express-rate-limit');

const CONFIG_FILE = path.join(__dirname, 'config.json');
const SESSION_FILE = path.join(__dirname, 'data', 'sessions.json');
const SESSION_MAX_AGE = 30 * 24 * 60 * 60 * 1000;
const MINIMUM_PASSWORD_LENGTH = 20;
const SESSION_COOKIE = '__Host-session';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const roundAmount = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;

function validateConfig(config) {
  const required = ['server.host', 'server.port', 'publicOrigin', 'passwordHash', 'sessionSecret'];
  for (const field of required) {
    const value = field.split('.').reduce((current, key) => current?.[key], config);
    if (value === undefined || value === null || value === '') {
      throw new Error(`Missing required config field: ${field}`);
    }
  }

  if (!Number.isInteger(config.server.port) || config.server.port < 1 || config.server.port > 65535) {
    throw new Error('server.port must be an integer between 1 and 65535.');
  }
  if (typeof config.server.host !== 'string') {
    throw new Error('server.host must be a string.');
  }

  let publicOrigin;
  try {
    publicOrigin = new URL(config.publicOrigin);
  } catch {
    throw new Error('publicOrigin must be a valid URL.');
  }
  if (publicOrigin.protocol !== 'https:' || publicOrigin.origin !== config.publicOrigin) {
    throw new Error('publicOrigin must be an HTTPS origin without a path, query, or fragment.');
  }

  const argon2idHash = /^\$argon2id\$v=\d+\$m=\d+,p=\d+,t=\d+\$[A-Za-z0-9+/]+\$[A-Za-z0-9+/]+$/;
  if (typeof config.passwordHash !== 'string' || !argon2idHash.test(config.passwordHash)) {
    throw new Error('passwordHash must be a valid Argon2id encoded hash.');
  }
  if (typeof config.sessionSecret !== 'string' || !/^[a-f0-9]{64}$/i.test(config.sessionSecret)) {
    throw new Error('sessionSecret must contain exactly 64 hexadecimal characters.');
  }

  return config;
}

function loadConfig() {
  if (!fs.existsSync(CONFIG_FILE)) {
    throw new Error('config.json not found. Run the documented create-config command.');
  }

  let config;
  try {
    config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch (error) {
    throw new Error(`config.json is invalid: ${error.message}`);
  }

  return validateConfig(config);
}

function digest(value) {
  return crypto.createHash('sha256').update(String(value)).digest();
}

function safeEqual(left, right) {
  return crypto.timingSafeEqual(digest(left), digest(right));
}

function parseCsv(input) {
  input = input.replace(/^\uFEFF/, '');
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    if (quoted) {
      if (character === '"' && input[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') quoted = false;
      else field += character;
    } else if (character === '"') quoted = true;
    else if (character === ',') {
      row.push(field);
      field = '';
    } else if (character === '\n') {
      row.push(field.replace(/\r$/, ''));
      if (row.some((value) => value.trim())) rows.push(row);
      row = [];
      field = '';
    } else field += character;
  }
  if (quoted) throw new Error('Unclosed quoted field');
  row.push(field.replace(/\r$/, ''));
  if (row.some((value) => value.trim())) rows.push(row);
  return rows;
}

function expenseFromCsv(row, line) {
  if (row.length < 7) throw new Error(`Line ${line}: expected at least 7 columns`);
  if (row[2].trim().toLowerCase() !== 'expense') return null;
  const spentAt = new Date(row[0]);
  const amount = roundAmount(Math.abs(Number(row[4])));
  const currency = row[5].trim().toUpperCase();
  const description = row[6].trim();
  if (Number.isNaN(spentAt.getTime())) throw new Error(`Line ${line}: invalid date`);
  if (!Number.isFinite(amount) || amount <= 0) throw new Error(`Line ${line}: invalid amount`);
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error(`Line ${line}: invalid currency`);
  if (!description || description.length > 200) throw new Error(`Line ${line}: invalid description`);
  return { spentAt: spentAt.toISOString(), amount, currency, description };
}

function createApp(config, sessionFile = SESSION_FILE) {
  validateConfig(config);
  const app = express();
  let sessions = new Map();
  const databaseFile = path.join(path.dirname(sessionFile), 'myspend.sqlite');
  fs.mkdirSync(path.dirname(databaseFile), { recursive: true });
  const database = new DatabaseSync(databaseFile);
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS expenses (
      id INTEGER PRIMARY KEY,
      spent_at TEXT NOT NULL,
      amount REAL NOT NULL CHECK (amount > 0),
      currency TEXT NOT NULL,
      description TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (spent_at, amount, currency, description)
    );
    CREATE TABLE IF NOT EXISTS settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      currency TEXT NOT NULL DEFAULT 'EUR',
      period TEXT NOT NULL DEFAULT 'month'
    );
    INSERT OR IGNORE INTO settings (id) VALUES (1);
  `);

  try {
    const saved = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
    const entries = saved && !Array.isArray(saved) && typeof saved === 'object'
      ? Object.entries(saved)
      : [];
    const invalid = !saved || Array.isArray(saved) || typeof saved !== 'object'
      || entries.some(([token, session]) => (
        !/^[a-f0-9]{64}$/.test(token)
        || !session || Array.isArray(session) || typeof session !== 'object'
        || !Number.isFinite(session.expiresAt)
        || typeof session.csrfToken !== 'string'
        || !/^[a-f0-9]{64}$/.test(session.csrfToken)
      ));
    if (invalid) throw new Error('invalid session data');
    sessions = new Map(entries);
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error(`Could not load sessions: ${error.message}`);
  }

  const saveSessions = () => {
    fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
    const temporaryFile = `${sessionFile}.${process.pid}.tmp`;
    fs.writeFileSync(temporaryFile, JSON.stringify(Object.fromEntries(sessions)), { mode: 0o600 });
    fs.renameSync(temporaryFile, sessionFile);
  };
  // Only keyed hashes are persisted, so the session file does not contain bearer tokens.
  const sessionKey = (token) => crypto
    .createHmac('sha256', config.sessionSecret)
    .update(token || '')
    .digest('hex');

  const cookieOptions = {
    httpOnly: true,
    secure: true,
    sameSite: 'strict',
    maxAge: SESSION_MAX_AGE,
    path: '/',
  };
  const clearCookieOptions = { ...cookieOptions };
  delete clearCookieOptions.maxAge;

  const authenticatedSession = (request) => {
    const key = sessionKey(request.cookies?.[SESSION_COOKIE]);
    const session = sessions.get(key);
    if (!session || session.expiresAt <= Date.now()) {
      if (sessions.delete(key)) saveSessions();
      return null;
    }
    return { key, ...session };
  };
  const requireAuth = (request, response, next) => {
    const session = authenticatedSession(request);
    if (!session) {
      return response.status(401).json({ error: 'Unauthorized' });
    }
    request.authenticatedSession = session;
    return next();
  };

  app.disable('x-powered-by');
  app.use((request, response, next) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    response.setHeader('Permissions-Policy', 'camera=(), geolocation=(), microphone=()');
    response.setHeader('Content-Security-Policy', "default-src 'self'; base-uri 'none'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; img-src 'self'; manifest-src 'self'; object-src 'none'; script-src 'self'; style-src 'self'");
    next();
  });
  app.use(express.json({ limit: '2mb' }));
  app.use(cookieParser());
  app.use('/api', (request, response, next) => {
    response.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.use('/api', (request, response, next) => {
    if (!SAFE_METHODS.has(request.method) && request.get('origin') !== config.publicOrigin) {
      return response.status(403).json({ error: 'Invalid request origin' });
    }
    return next();
  });

  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 5,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    keyGenerator: () => 'single-user',
    message: { error: 'Too many login attempts. Try again later.' },
  });

  app.get('/api/session', (request, response) => {
    const session = authenticatedSession(request);
    if (!session) {
      return response.status(401).json({ authenticated: false });
    }
    return response.json({ authenticated: true, csrfToken: session.csrfToken });
  });

  app.post('/api/session', loginLimiter, async (request, response) => {
    const suppliedPassword = typeof request.body?.password === 'string' ? request.body.password : '';
    const passwordMatches = suppliedPassword.length >= MINIMUM_PASSWORD_LENGTH
      && await argon2.verify(config.passwordHash, suppliedPassword);
    if (!passwordMatches) {
      return response.status(401).json({ error: 'Invalid password' });
    }

    const now = Date.now();
    for (const [session, details] of sessions) {
      if (details.expiresAt <= now) sessions.delete(session);
    }
    const token = crypto.randomBytes(32).toString('hex');
    const csrfToken = crypto.randomBytes(32).toString('hex');
    sessions.set(sessionKey(token), { expiresAt: now + SESSION_MAX_AGE, csrfToken });
    saveSessions();
    response.cookie(SESSION_COOKIE, token, cookieOptions);
    return response.json({ authenticated: true, csrfToken });
  });

  // Register all application API routes below this authorization boundary.
  app.use('/api', requireAuth);
  app.use('/api', (request, response, next) => {
    if (SAFE_METHODS.has(request.method)) return next();
    const suppliedToken = request.get('x-csrf-token') || '';
    if (!safeEqual(suppliedToken, request.authenticatedSession.csrfToken)) {
      return response.status(403).json({ error: 'Invalid CSRF token' });
    }
    return next();
  });

  app.delete('/api/session', (request, response) => {
    sessions.delete(request.authenticatedSession.key);
    saveSessions();
    response.clearCookie(SESSION_COOKIE, clearCookieOptions);
    return response.status(204).end();
  });

  app.get('/api/settings', (request, response) => {
    return response.json(database.prepare('SELECT currency, period FROM settings WHERE id = 1').get());
  });

  app.put('/api/settings', (request, response) => {
    const currency = typeof request.body?.currency === 'string' ? request.body.currency.toUpperCase() : '';
    const period = request.body?.period;
    if (!/^[A-Z]{3}$/.test(currency) || !['week', 'month', 'year'].includes(period)) {
      return response.status(400).json({ error: 'Invalid settings' });
    }
    database.prepare('UPDATE settings SET currency = ?, period = ? WHERE id = 1').run(currency, period);
    return response.json({ currency, period });
  });

  app.get('/api/expenses', (request, response) => {
    const settings = database.prepare('SELECT currency, period FROM settings WHERE id = 1').get();
    const expenses = database.prepare(`
      SELECT id, spent_at AS spentAt, amount, currency, description
      FROM expenses ORDER BY spent_at DESC, id DESC
    `).all();
    return response.json({ settings, expenses });
  });

  app.post('/api/expenses', (request, response, next) => {
    try {
      const spentAt = new Date(request.body?.spentAt);
      const amount = roundAmount(request.body?.amount);
      const currency = typeof request.body?.currency === 'string' ? request.body.currency.toUpperCase() : '';
      const description = typeof request.body?.description === 'string' ? request.body.description.trim() : '';
      if (Number.isNaN(spentAt.getTime()) || !Number.isFinite(amount) || amount <= 0
        || !/^[A-Z]{3}$/.test(currency) || !description || description.length > 200) {
        return response.status(400).json({ error: 'Invalid expense' });
      }
      const result = database.prepare(`
        INSERT INTO expenses (spent_at, amount, currency, description)
        VALUES (?, ?, ?, ?)
      `).run(spentAt.toISOString(), amount, currency, description);
      return response.status(201).json({ id: Number(result.lastInsertRowid) });
    } catch (error) {
      if (error.code === 'ERR_SQLITE_CONSTRAINT_UNIQUE') {
        return response.status(409).json({ error: 'This expense already exists' });
      }
      return next(error);
    }
  });

  app.put('/api/expenses/:id', (request, response, next) => {
    try {
      const id = Number(request.params.id);
      const spentAt = new Date(request.body?.spentAt);
      const amount = roundAmount(request.body?.amount);
      const currency = typeof request.body?.currency === 'string' ? request.body.currency.toUpperCase() : '';
      const description = typeof request.body?.description === 'string' ? request.body.description.trim() : '';
      if (!Number.isInteger(id) || id <= 0 || Number.isNaN(spentAt.getTime())
        || !Number.isFinite(amount) || amount <= 0 || !/^[A-Z]{3}$/.test(currency)
        || !description || description.length > 200) {
        return response.status(400).json({ error: 'Invalid expense' });
      }
      const result = database.prepare(`
        UPDATE expenses SET spent_at = ?, amount = ?, currency = ?, description = ? WHERE id = ?
      `).run(spentAt.toISOString(), amount, currency, description, id);
      if (!result.changes) return response.status(404).json({ error: 'Expense not found' });
      return response.json({ id });
    } catch (error) {
      if (error.code === 'ERR_SQLITE_CONSTRAINT_UNIQUE') {
        return response.status(409).json({ error: 'This expense already exists' });
      }
      return next(error);
    }
  });

  app.delete('/api/expenses/:id', (request, response) => {
    const id = Number(request.params.id);
    if (!Number.isInteger(id) || id <= 0) return response.status(400).json({ error: 'Invalid expense' });
    const result = database.prepare('DELETE FROM expenses WHERE id = ?').run(id);
    if (!result.changes) return response.status(404).json({ error: 'Expense not found' });
    return response.status(204).end();
  });

  app.post('/api/import', (request, response, next) => {
    try {
      if (typeof request.body?.csv !== 'string' || !request.body.csv.trim()) {
        return response.status(400).json({ error: 'Choose a non-empty CSV file' });
      }
      const rows = parseCsv(request.body.csv);
      if (rows.length > 10000) return response.status(400).json({ error: 'CSV is limited to 10,000 rows' });
      const expenses = rows.map((row, index) => expenseFromCsv(row, index + 1)).filter(Boolean);

      const insert = database.prepare(`
        INSERT OR IGNORE INTO expenses (spent_at, amount, currency, description)
        VALUES (?, ?, ?, ?)
      `);
      let imported = 0;
      database.exec('BEGIN');
      try {
        for (const expense of expenses) {
          imported += Number(insert.run(
            expense.spentAt, expense.amount, expense.currency, expense.description,
          ).changes);
        }
        database.exec('COMMIT');
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
      return response.json({ imported, skipped: rows.length - imported });
    } catch (error) {
      if (/^(Line|Unclosed)/.test(error.message)) return response.status(400).json({ error: error.message });
      return next(error);
    }
  });

  app.use(express.static(path.join(__dirname, 'public')));

  app.use((error, request, response, next) => {
    if (error?.type === 'entity.parse.failed') {
      return response.status(400).json({ error: 'Invalid JSON' });
    }
    console.error(error);
    return response.status(500).json({ error: 'Internal server error' });
  });

  return app;
}

if (require.main === module) {
  try {
    const config = loadConfig();
    createApp(config).listen(config.server.port, config.server.host, () => {
      console.log(`MySpend listening on http://${config.server.host}:${config.server.port}`);
    });
  } catch (error) {
    console.error(`ERROR: ${error.message}`);
    process.exit(1);
  }
}

module.exports = { createApp, loadConfig, parseCsv, safeEqual, validateConfig };
