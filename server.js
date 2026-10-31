const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const root = __dirname;
const port = Number(process.env.PORT || 8000);
const host = process.env.HOST || (process.env.RENDER ? '0.0.0.0' : '127.0.0.1');
const adminKey = process.env.AI_COURSE_ADMIN_KEY || '';
const dataDir = process.env.DATA_DIR || path.join(root, 'storage');
const database = path.join(dataDir, 'submissions.json');
const answerKey = [0, 0, 0, 1, 0, 1, 1, 0, 1, 1];
const rateLimits = new Map();

if (process.env.NODE_ENV === 'production' && adminKey.length < 32) {
  throw new Error('Production requires a generated AI_COURSE_ADMIN_KEY of at least 32 characters.');
}
fs.mkdirSync(dataDir, { recursive: true });

function readSubmissions() {
  try {
    return JSON.parse(fs.readFileSync(database, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    // Preserve records created by the earlier local version during migration.
    const oldFile = path.join(root, 'submissions.json');
    try {
      const oldRecords = JSON.parse(fs.readFileSync(oldFile, 'utf8'));
      if (Array.isArray(oldRecords)) writeSubmissions(oldRecords);
      return Array.isArray(oldRecords) ? oldRecords : [];
    } catch (legacyError) {
      if (legacyError.code !== 'ENOENT') throw legacyError;
      return [];
    }
  }
}

function writeSubmissions(records) {
  const temp = `${database}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(records, null, 2), { mode: 0o600 });
  fs.renameSync(temp, database);
}

function sendJson(response, status, payload, headers = {}) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  response.end(body);
}

function setSecurityHeaders(response) {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'self'; form-action 'self'; frame-ancestors 'none'");
  response.setHeader('Cache-Control', 'no-store');
  if (process.env.RENDER) response.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
}

function isRateLimited(request, bucket, maxRequests, windowMs) {
  const forwarded = process.env.RENDER ? request.headers['x-forwarded-for'] : '';
  const ip = (forwarded ? String(forwarded).split(',')[0].trim() : '') || request.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const key = `${bucket}:${ip}`;
  const entry = rateLimits.get(key) || { start: now, count: 0 };
  if (now - entry.start > windowMs) { entry.start = now; entry.count = 0; }
  entry.count += 1;
  rateLimits.set(key, entry);
  if (rateLimits.size > 5000) {
    for (const [entryKey, value] of rateLimits) if (now - value.start > windowMs * 2) rateLimits.delete(entryKey);
  }
  return entry.count > maxRequests;
}

function readJson(request, response, callback) {
  let body = '';
  let tooLarge = false;
  request.on('data', chunk => {
    if ((body.length + chunk.length) > 10000) tooLarge = true;
    else if (!tooLarge) body += chunk;
  });
  request.on('end', () => {
    if (tooLarge) return sendJson(response, 413, { error: 'Submission too large' });
    try { callback(JSON.parse(body)); }
    catch { sendJson(response, 400, { error: 'Invalid JSON' }); }
  });
}

const server = http.createServer((request, response) => {
  setSecurityHeaders(response);
  const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);

  if (url.pathname === '/healthz' && request.method === 'GET') {
    return sendJson(response, 200, { ok: true });
  }

  if (url.pathname === '/api/submissions' && request.method === 'POST') {
    if (isRateLimited(request, 'student-submit', 30, 10 * 60 * 1000)) {
      return sendJson(response, 429, { error: 'Too many submissions. Try again later.' }, { 'Retry-After': '600' });
    }
    if (!String(request.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
      return sendJson(response, 415, { error: 'Content-Type must be application/json' });
    }
    return readJson(request, response, item => {
      const name = String(item.name || '').trim();
      const email = String(item.email || '').trim().toLowerCase();
      const answers = item.answers;
      const lessonsCompleted = Number(item.lessonsCompleted);
      const validEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
      const validAnswers = answers && typeof answers === 'object' &&
        Array.from({ length: 10 }, (_, i) => Number.isInteger(answers[i]) && answers[i] >= 0 && answers[i] <= 2).every(Boolean) &&
        Object.keys(answers).length === 10;
      if (!name || name.length > 120 || !validEmail || email.length > 254 || !validAnswers ||
          !Number.isInteger(lessonsCompleted) || lessonsCompleted < 0 || lessonsCompleted > 3) {
        return sendJson(response, 400, { error: 'Invalid course result' });
      }
      const score = answerKey.reduce((sum, correct, i) => sum + (answers[i] === correct ? 1 : 0), 0);
      const records = readSubmissions();
      records.push({
        id: crypto.randomUUID(), name, email, score, total: 10, lessonsCompleted,
        completedAt: new Date().toISOString(),
        answers: Object.fromEntries(Array.from({ length: 10 }, (_, i) => [i, answers[i]])),
      });
      try {
        writeSubmissions(records);
        return sendJson(response, 201, { saved: true, score });
      } catch (error) {
        console.error('Could not save learner submission:', error.message);
        return sendJson(response, 500, { error: 'Could not save submission' });
      }
    });
  }

  if (url.pathname === '/api/submissions' && request.method === 'GET') {
    if (isRateLimited(request, 'admin-review', 30, 60 * 1000)) {
      return sendJson(response, 429, { error: 'Too many requests. Try again shortly.' }, { 'Retry-After': '60' });
    }
    const provided = Buffer.from(request.headers['x-admin-key'] || '');
    const expected = Buffer.from(adminKey);
    const authorized = adminKey.length >= 32 && provided.length === expected.length && crypto.timingSafeEqual(provided, expected);
    if (!authorized) return sendJson(response, 401, { error: 'Unauthorized' });
    try {
      const records = readSubmissions().sort((a, b) => b.completedAt.localeCompare(a.completedAt));
      return sendJson(response, 200, records);
    } catch (error) {
      console.error('Could not read learner submissions:', error.message);
      return sendJson(response, 500, { error: 'Could not load submissions' });
    }
  }

  if (request.method !== 'GET' && request.method !== 'HEAD') return sendJson(response, 405, { error: 'Method not allowed' });
  const route = url.pathname === '/admin' ? '/admin.html' : url.pathname;
  const allowedFiles = new Map([['/', 'index.html'], ['/index.html', 'index.html'], ['/admin.html', 'admin.html']]);
  if (!allowedFiles.has(route)) return sendJson(response, 404, { error: 'Not found' });
  const file = path.join(root, allowedFiles.get(route));
  fs.readFile(file, (error, data) => {
    if (error) return sendJson(response, 404, { error: 'Not found' });
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(request.method === 'HEAD' ? undefined : data);
  });
});

server.listen(port, host, () => console.log(`Prompt Practice running at http://${host}:${port}`));
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
