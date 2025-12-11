const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

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

function createApp(config, sessionFile = SESSION_FILE) {
  validateConfig(config);
  const app = express();
  let sessions = new Map();

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
  app.use(express.json({ limit: '10kb' }));
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
      console.log(`PWA Starter listening on http://${config.server.host}:${config.server.port}`);
    });
  } catch (error) {
    console.error(`ERROR: ${error.message}`);
    process.exit(1);
  }
}

module.exports = { createApp, loadConfig, safeEqual, validateConfig };
