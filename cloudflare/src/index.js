const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' };
const SESSION_TTL_SECONDS = 2 * 60 * 60;
const LOGIN_WINDOW_SECONDS = 15 * 60;
const MAX_LOGIN_FAILURES = 5;

export default {
  async fetch(request, env) {
    return handleRequest(request, env);
  },
};

export async function handleRequest(request, env) {
  const url = new URL(request.url);
  const corsHeaders = getCorsHeaders(request, env);

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  try {
    let response;

    if (url.pathname === '/api/health' && request.method === 'GET') {
      response = json({ ok: true });
    } else if (url.pathname === '/api/verify' && request.method === 'POST') {
      response = await verifyPerson(request, env);
    } else if (url.pathname === '/api/admin/login' && request.method === 'POST') {
      response = await adminLogin(request, env);
    } else if (url.pathname === '/api/admin/personnel' && request.method === 'GET') {
      response = await listPersonnel(request, env);
    } else if (url.pathname === '/api/admin/personnel' && request.method === 'POST') {
      response = await addPerson(request, env);
    } else if (url.pathname === '/api/admin/personnel/import' && request.method === 'POST') {
      response = await importPersonnel(request, env);
    } else if (url.pathname === '/api/admin/personnel' && request.method === 'DELETE') {
      response = await clearPersonnel(request, env);
    } else if (url.pathname.startsWith('/api/admin/personnel/') && request.method === 'DELETE') {
      response = await deletePerson(request, env, decodeURIComponent(url.pathname.slice('/api/admin/personnel/'.length)));
    } else {
      response = json({ error: '接口不存在' }, 404);
    }

    return withHeaders(response, corsHeaders);
  } catch (error) {
    console.error('Unhandled request error', error);
    return withHeaders(json({ error: '服务器处理失败' }, 500), corsHeaders);
  }
}

async function verifyPerson(request, env) {
  const body = await readJson(request);
  const name = normalizeText(body.name, 80);
  const id = normalizeText(body.id, 80);
  if (!name || !id) return json({ error: '请填写姓名和工号' }, 400);

  const person = await env.DB.prepare(
    'SELECT id, name, department, authorization_date AS authorizationDate FROM personnel WHERE name = ?1 COLLATE NOCASE AND id = ?2 COLLATE NOCASE LIMIT 1'
  ).bind(name, id).first();

  if (!person) {
    return json({ authorized: false, status: 'not_found', message: '未授权' });
  }

  const authorizationDate = formatAuthorizationDate(person.authorizationDate);
  if (!authorizationDate) {
    return json({
      authorized: false,
      status: 'missing_date',
      message: '授权日期缺失',
      person: { ...person, authorizationDate: '' },
    });
  }

  const expired = isAuthorizationExpired(authorizationDate);
  return json({
    authorized: !expired,
    status: expired ? 'expired' : 'authorized',
    message: expired ? '授权已超期' : '已授权',
    person: { ...person, authorizationDate },
  });
}

async function adminLogin(request, env) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const now = Math.floor(Date.now() / 1000);
  const attempt = await env.DB.prepare(
    'SELECT failed_count AS failedCount, window_started AS windowStarted, blocked_until AS blockedUntil FROM login_attempts WHERE ip = ?1'
  ).bind(ip).first();

  if (attempt?.blockedUntil && attempt.blockedUntil > now) {
    return json({ error: '密码错误次数过多，请稍后再试', retryAfter: attempt.blockedUntil - now }, 429);
  }

  const body = await readJson(request);
  const password = typeof body.password === 'string' ? body.password : '';
  const passwordOk = password && await secureEqual(password, env.ADMIN_PASSWORD || '');

  if (!passwordOk) {
    const inWindow = attempt && now - attempt.windowStarted < LOGIN_WINDOW_SECONDS;
    const failedCount = inWindow ? attempt.failedCount + 1 : 1;
    const windowStarted = inWindow ? attempt.windowStarted : now;
    const blockedUntil = failedCount >= MAX_LOGIN_FAILURES ? now + LOGIN_WINDOW_SECONDS : 0;

    await env.DB.prepare(
      `INSERT INTO login_attempts (ip, failed_count, window_started, blocked_until)
       VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT(ip) DO UPDATE SET failed_count = excluded.failed_count,
         window_started = excluded.window_started, blocked_until = excluded.blocked_until`
    ).bind(ip, failedCount, windowStarted, blockedUntil).run();

    return json({ error: '密码错误' }, 401);
  }

  await env.DB.prepare('DELETE FROM login_attempts WHERE ip = ?1').bind(ip).run();
  const token = await createSessionToken(env.SESSION_SECRET, now + SESSION_TTL_SECONDS);
  return json({ token, expiresIn: SESSION_TTL_SECONDS });
}

async function listPersonnel(request, env) {
  const denied = await requireAdmin(request, env);
  if (denied) return denied;

  const result = await env.DB.prepare(
    'SELECT id, name, department, authorization_date AS authorizationDate FROM personnel ORDER BY name COLLATE NOCASE, id COLLATE NOCASE'
  ).all();
  return json({ data: result.results || [], total: result.results?.length || 0 });
}

async function addPerson(request, env) {
  const denied = await requireAdmin(request, env);
  if (denied) return denied;

  const person = validatePerson(await readJson(request));
  if (!person.ok) return json({ error: person.error }, 400);

  try {
    await env.DB.prepare(
      `INSERT INTO personnel (id, name, department, authorization_date, updated_at)
       VALUES (?1, ?2, ?3, ?4, datetime('now'))`
    ).bind(person.value.id, person.value.name, person.value.department, person.value.authorizationDate).run();
    return json({ ok: true, person: person.value }, 201);
  } catch (error) {
    if (String(error).includes('UNIQUE')) return json({ error: '该工号已存在' }, 409);
    throw error;
  }
}

async function importPersonnel(request, env) {
  const denied = await requireAdmin(request, env);
  if (denied) return denied;

  const body = await readJson(request);
  if (!Array.isArray(body.personnel) || body.personnel.length === 0) {
    return json({ error: '没有可导入的人员数据' }, 400);
  }
  if (body.personnel.length > 20000) {
    return json({ error: '单次最多导入 20000 人' }, 400);
  }

  const valid = [];
  const seen = new Set();
  let skipped = 0;
  for (const raw of body.personnel) {
    const person = validatePerson(raw);
    if (!person.ok || seen.has(person.value.id.toLowerCase())) {
      skipped++;
      continue;
    }
    seen.add(person.value.id.toLowerCase());
    valid.push(person.value);
  }
  if (valid.length === 0) return json({ error: '没有可导入的有效数据' }, 400);

  const existing = await findExistingIds(env.DB, valid.map(person => person.id));
  const statements = valid.map(person => env.DB.prepare(
    `INSERT INTO personnel (id, name, department, authorization_date, updated_at)
     VALUES (?1, ?2, ?3, ?4, datetime('now'))
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, department = excluded.department,
       authorization_date = excluded.authorization_date, updated_at = datetime('now')`
  ).bind(person.id, person.name, person.department, person.authorizationDate));

  for (let index = 0; index < statements.length; index += 100) {
    await env.DB.batch(statements.slice(index, index + 100));
  }

  const updated = valid.filter(person => existing.has(person.id.toLowerCase())).length;
  return json({ ok: true, added: valid.length - updated, updated, skipped });
}

async function deletePerson(request, env, id) {
  const denied = await requireAdmin(request, env);
  if (denied) return denied;
  if (!id) return json({ error: '工号不能为空' }, 400);

  const result = await env.DB.prepare('DELETE FROM personnel WHERE id = ?1 COLLATE NOCASE').bind(id).run();
  if (!result.meta?.changes) return json({ error: '未找到该人员' }, 404);
  return json({ ok: true });
}

async function clearPersonnel(request, env) {
  const denied = await requireAdmin(request, env);
  if (denied) return denied;
  await env.DB.prepare('DELETE FROM personnel').run();
  return json({ ok: true });
}

async function findExistingIds(db, ids) {
  const existing = new Set();
  for (let index = 0; index < ids.length; index += 80) {
    const chunk = ids.slice(index, index + 80);
    const placeholders = chunk.map((_, i) => `?${i + 1}`).join(',');
    const result = await db.prepare(`SELECT id FROM personnel WHERE id COLLATE NOCASE IN (${placeholders})`).bind(...chunk).all();
    for (const row of result.results || []) existing.add(String(row.id).toLowerCase());
  }
  return existing;
}

async function requireAdmin(request, env) {
  const authorization = request.headers.get('Authorization') || '';
  if (!authorization.startsWith('Bearer ')) return json({ error: '请先输入管理密码' }, 401);
  const valid = await verifySessionToken(authorization.slice(7), env.SESSION_SECRET);
  return valid ? null : json({ error: '管理登录已失效，请重新输入密码' }, 401);
}

function validatePerson(raw) {
  const id = normalizeText(raw?.id, 80);
  const name = normalizeText(raw?.name, 80);
  const department = normalizeText(raw?.department, 120);
  const authorizationDate = formatAuthorizationDate(raw?.authorizationDate);
  if (!name || !id) return { ok: false, error: '姓名和工号不能为空' };
  if (!authorizationDate) return { ok: false, error: '授权日期格式无效' };
  return { ok: true, value: { id, name, department, authorizationDate } };
}

function normalizeText(value, maxLength) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

export function parseAuthorizationDate(value) {
  const match = String(value || '').trim().match(/^(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})$/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return { year, month, day };
}

export function formatAuthorizationDate(value) {
  const date = parseAuthorizationDate(value);
  return date ? `${date.year}/${date.month}/${date.day}` : '';
}

export function isAuthorizationExpired(value, now = new Date()) {
  const date = parseAuthorizationDate(value);
  if (!date) return false;
  const anniversary = Date.UTC(date.year + 1, date.month - 1, date.day);
  const chinaNow = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  const today = Date.UTC(chinaNow.getUTCFullYear(), chinaNow.getUTCMonth(), chinaNow.getUTCDate());
  return today > anniversary;
}

async function createSessionToken(secret, expiresAt) {
  const payload = toBase64Url(new TextEncoder().encode(JSON.stringify({ exp: expiresAt })));
  const signature = await sign(payload, secret);
  return `${payload}.${signature}`;
}

async function verifySessionToken(token, secret) {
  if (!secret || typeof token !== 'string') return false;
  const [payload, signature, extra] = token.split('.');
  if (!payload || !signature || extra) return false;
  const expected = await sign(payload, secret);
  if (!constantTimeEqual(fromBase64Url(signature), fromBase64Url(expected))) return false;

  try {
    const data = JSON.parse(new TextDecoder().decode(fromBase64Url(payload)));
    return Number.isFinite(data.exp) && data.exp > Math.floor(Date.now() / 1000);
  } catch {
    return false;
  }
}

async function sign(value, secret) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value));
  return toBase64Url(new Uint8Array(signature));
}

async function secureEqual(left, right) {
  const [leftHash, rightHash] = await Promise.all([sha256(left), sha256(right)]);
  return constantTimeEqual(leftHash, rightHash);
}

async function sha256(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return new Uint8Array(digest);
}

function constantTimeEqual(left, right) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let i = 0; i < left.length; i++) difference |= left[i] ^ right[i];
  return difference === 0;
}

function toBase64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function fromBase64Url(value) {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  const binary = atob(base64);
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}

async function readJson(request) {
  const contentLength = Number(request.headers.get('Content-Length') || 0);
  if (contentLength > 2_000_000) throw new Error('Request body too large');
  try {
    return await request.json();
  } catch {
    return {};
  }
}

function getCorsHeaders(request, env) {
  const origin = request.headers.get('Origin');
  const allowed = new Set([
    env.ALLOWED_ORIGIN,
    'http://localhost:3000',
    'http://127.0.0.1:3000',
  ].filter(Boolean));
  const allowOrigin = allowed.has(origin) ? origin : env.ALLOWED_ORIGIN;
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

function withHeaders(response, headers) {
  const nextHeaders = new Headers(response.headers);
  for (const [key, value] of Object.entries(headers)) nextHeaders.set(key, value);
  nextHeaders.set('Cache-Control', 'no-store');
  nextHeaders.set('X-Content-Type-Options', 'nosniff');
  nextHeaders.set('Referrer-Policy', 'no-referrer');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers: nextHeaders });
}