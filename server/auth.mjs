import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt);
const COOKIE = 'wordmem_session';
const SESSION_MS = 7 * 86400 * 1000;
const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');
const hashPassword = (password, salt) => crypto.scryptSync(password, salt, 64).toString('hex');

/** Single account, salted password hash, and revocable sessions persisted in SQLite. */
export function createAuth(db, { env = process.env, log = console.log } = {}) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS auth (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      username TEXT NOT NULL,
      pass_hash TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS auth_sessions (
      token_hash TEXT PRIMARY KEY,
      expires_at INTEGER NOT NULL
    );
  `);

  let account = db.prepare('SELECT * FROM auth WHERE id = 1').get();
  const user = env.WORDMEM_USER;
  const pass = env.WORDMEM_PASS;
  if (Boolean(user) !== Boolean(pass)) {
    throw new Error('WORDMEM_USER 和 WORDMEM_PASS 必须同时设置');
  }
  if (user && (user.length > 80 || pass.length > 1024)) {
    throw new Error('登录凭据过长');
  }

  const matches = (password, stored) => {
    const [salt, hash] = stored.split(':');
    const actual = Buffer.from(hashPassword(password, salt), 'hex');
    const expected = Buffer.from(hash, 'hex');
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  };
  const reset = user && (!account || account.username !== user || !matches(pass, account.pass_hash));
  if (!account || reset) {
    const username = user || 'wordmem';
    const password = pass || crypto.randomBytes(18).toString('base64url');
    const salt = crypto.randomBytes(16).toString('hex');
    account = { username, pass_hash: `${salt}:${hashPassword(password, salt)}` };
    db.exec('BEGIN');
    try {
      db.prepare(`INSERT INTO auth(id, username, pass_hash) VALUES(1, ?, ?)
        ON CONFLICT(id) DO UPDATE SET username = excluded.username, pass_hash = excluded.pass_hash`)
        .run(account.username, account.pass_hash);
      db.exec('DELETE FROM auth_sessions; COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    if (!pass) log(`首次启动登录凭据：用户名 ${username} / 密码 ${password}`);
  }
  db.prepare('DELETE FROM auth_sessions WHERE expires_at <= ?').run(Date.now());

  const secure = env.COOKIE_SECURE === '1';
  const trustedProxy = env.TRUST_PROXY === '1';
  const isProxy = (req) => trustedProxy &&
    ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
  const clientIp = (req) => isProxy(req)
    ? String(req.headers['x-real-ip'] || req.socket.remoteAddress)
    : req.socket.remoteAddress;

  function setCookie(res, token, maxAge = SESSION_MS / 1000) {
    res.setHeader('Set-Cookie', `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? '; Secure' : ''}`);
  }

  function tokenOf(req) {
    return String(req.headers.cookie || '').split(';').map((s) => s.trim())
      .find((s) => s.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1) || '';
  }

  function session(req) {
    const token = tokenOf(req);
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const tokenHash = hashToken(token);
    const row = db.prepare('SELECT expires_at FROM auth_sessions WHERE token_hash = ?').get(tokenHash);
    if (!row) return null;
    if (row.expires_at <= Date.now()) {
      db.prepare('DELETE FROM auth_sessions WHERE token_hash = ?').run(tokenHash);
      return null;
    }
    return { username: account.username, expiresAt: row.expires_at, token, tokenHash };
  }

  function allowedOrigin(req) {
    const origin = req.headers.origin;
    if (!origin) {
      const site = req.headers['sec-fetch-site'];
      return !site || site === 'same-origin' || site === 'none';
    }
    const protocol = isProxy(req) ? req.headers['x-forwarded-proto'] : 'http';
    const expected = env.APP_ORIGIN || `${protocol || 'http'}://${req.headers.host}`;
    if (origin === expected) return true;
    return env.NODE_ENV !== 'production' &&
      ['http://localhost:5173', 'http://127.0.0.1:5173'].includes(origin);
  }

  const failures = new Map();
  let globalFailures = { count: 0, until: 0 };
  function cleanupFailures(now) {
    for (const [ip, record] of failures) {
      if (record.until <= now) failures.delete(ip);
    }
    if (globalFailures.until <= now) globalFailures = { count: 0, until: now + 300_000 };
  }

  /** Returns true when the request was handled, false for a business API. */
  async function handle(req, res, url, readBody, json) {
    const key = `${req.method} ${url.pathname}`;
    if (key === 'POST /api/auth/login') {
      const now = Date.now();
      cleanupFailures(now);
      const ip = clientIp(req);
      const record = failures.get(ip);
      if ((record?.count || 0) >= 10 || globalFailures.count >= 100) {
        res.setHeader('Retry-After', '300');
        json(res, { error: '尝试次数过多，请五分钟后重试' }, 429);
        return true;
      }
      const body = await readBody(req);
      const valid = body && typeof body.username === 'string' && typeof body.password === 'string' &&
        body.username.length <= 80 && body.password.length > 0 && body.password.length <= 1024;
      let ok = false;
      if (valid) {
        const [salt, hash] = account.pass_hash.split(':');
        const actual = await scrypt(body.password, salt, 64);
        const expected = Buffer.from(hash, 'hex');
        ok = body.username === account.username && actual.length === expected.length &&
          crypto.timingSafeEqual(actual, expected);
      }
      if (!ok) {
        if (!record && failures.size >= 1000) failures.delete(failures.keys().next().value);
        failures.set(ip, { count: (record?.count || 0) + 1, until: record?.until || now + 300_000 });
        globalFailures.count += 1;
        json(res, { error: '用户名或密码错误' }, 401);
        return true;
      }
      failures.delete(ip);
      db.prepare('DELETE FROM auth_sessions WHERE expires_at <= ?').run(now);
      const token = crypto.randomBytes(32).toString('base64url');
      const expiresAt = Date.now() + SESSION_MS;
      db.prepare('INSERT INTO auth_sessions(token_hash, expires_at) VALUES(?, ?)')
        .run(hashToken(token), expiresAt);
      setCookie(res, token);
      json(res, { username: account.username, expiresAt });
      return true;
    }
    if (key === 'POST /api/auth/logout') {
      db.prepare('DELETE FROM auth_sessions WHERE token_hash = ?').run(hashToken(tokenOf(req)));
      setCookie(res, '', 0);
      json(res, { ok: true });
      return true;
    }
    if (key === 'GET /api/auth/session' || key === 'POST /api/auth/refresh') {
      const current = session(req);
      if (!current) {
        setCookie(res, '', 0);
        json(res, { error: '请先登录' }, 401);
        return true;
      }
      if (current.expiresAt - Date.now() < SESSION_MS / 2) {
        current.expiresAt = Date.now() + SESSION_MS;
        db.prepare('UPDATE auth_sessions SET expires_at = ? WHERE token_hash = ?')
          .run(current.expiresAt, current.tokenHash);
        setCookie(res, current.token);
      }
      json(res, { username: current.username, expiresAt: current.expiresAt });
      return true;
    }
    return false;
  }

  return { session, allowedOrigin, handle };
}
