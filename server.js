// Piotr – petits travaux : réservation de créneaux, suivi des heures et des frais.
const express = require('express');
const crypto = require('node:crypto');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const PORT = process.env.PORT || 3000;
const db = new DatabaseSync(process.env.DB_PATH || path.join(__dirname, 'data.sqlite'));

db.exec(`
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
  phone TEXT DEFAULT '', password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'client', created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS unavailabilities (
  id INTEGER PRIMARY KEY, start TEXT NOT NULL, end TEXT NOT NULL, note TEXT DEFAULT '');
CREATE TABLE IF NOT EXISTS bookings (
  id INTEGER PRIMARY KEY, client_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  start TEXT NOT NULL, end TEXT NOT NULL, description TEXT DEFAULT '', address TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending', hourly_rate REAL, admin_note TEXT DEFAULT '',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS work_entries (
  id INTEGER PRIMARY KEY, booking_id INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  date TEXT NOT NULL, hours REAL NOT NULL, note TEXT DEFAULT '');
CREATE TABLE IF NOT EXISTS expenses (
  id INTEGER PRIMARY KEY, booking_id INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  label TEXT NOT NULL, amount REAL NOT NULL);
`);

const getSetting = (k, d) => db.prepare('SELECT value FROM settings WHERE key=?').get(k)?.value ?? d;
const setSetting = (k, v) => db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, String(v));

// --- Mots de passe ---------------------------------------------------------
function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return salt + ':' + crypto.scryptSync(pw, salt, 64).toString('hex');
}
function checkPassword(pw, stored) {
  const [salt, hash] = stored.split(':');
  const h = crypto.scryptSync(pw, salt, 64);
  return crypto.timingSafeEqual(h, Buffer.from(hash, 'hex'));
}

// --- App -------------------------------------------------------------------
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function parseCookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').filter(Boolean)
    .map(c => c.trim().split('=').map(decodeURIComponent)));
}
app.use((req, _res, next) => {
  const token = parseCookies(req).sid;
  if (token) {
    req.user = db.prepare(`SELECT u.id,u.email,u.name,u.phone,u.role FROM sessions s
      JOIN users u ON u.id=s.user_id WHERE s.token=?`).get(token);
    req.token = token;
  }
  next();
});
const auth = (req, res, next) => req.user ? next() : res.status(401).json({ error: 'Non connecté' });
const admin = (req, res, next) => req.user?.role === 'admin' ? next() : res.status(403).json({ error: 'Réservé à l’administrateur' });

function startSession(res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions(token,user_id) VALUES(?,?)').run(token, userId);
  res.setHeader('Set-Cookie', `sid=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${60 * 60 * 24 * 60}`);
}
const isISO = s => typeof s === 'string' && !isNaN(Date.parse(s));
const num = v => { const n = Number(v); return Number.isFinite(n) ? n : null; };

// --- Authentification ------------------------------------------------------
app.post('/api/register', (req, res) => {
  const { email, name, password, phone = '' } = req.body || {};
  if (!email || !name || !password || password.length < 6)
    return res.status(400).json({ error: 'Nom, e-mail et mot de passe (6 caractères min.) requis' });
  const normEmail = email.trim().toLowerCase();
  if (db.prepare('SELECT 1 FROM users WHERE email=?').get(normEmail))
    return res.status(409).json({ error: 'Cet e-mail est déjà utilisé' });
  const adminEmail = (process.env.ADMIN_EMAIL || '').toLowerCase();
  const isFirst = db.prepare('SELECT COUNT(*) c FROM users').get().c === 0;
  const role = (adminEmail ? normEmail === adminEmail : isFirst) ? 'admin' : 'client';
  const r = db.prepare('INSERT INTO users(email,name,phone,password_hash,role) VALUES(?,?,?,?,?)')
    .run(normEmail, name.trim(), phone.trim(), hashPassword(password), role);
  startSession(res, r.lastInsertRowid);
  res.json({ ok: true });
});
app.post('/api/login', (req, res) => {
  const { email = '', password = '' } = req.body || {};
  const u = db.prepare('SELECT * FROM users WHERE email=?').get(email.trim().toLowerCase());
  if (!u || !checkPassword(password, u.password_hash)) return res.status(401).json({ error: 'Identifiants incorrects' });
  startSession(res, u.id);
  res.json({ ok: true });
});
app.post('/api/logout', (req, res) => {
  if (req.token) db.prepare('DELETE FROM sessions WHERE token=?').run(req.token);
  res.setHeader('Set-Cookie', 'sid=; Path=/; Max-Age=0');
  res.json({ ok: true });
});
app.get('/api/me', (req, res) => res.json({ user: req.user || null, defaultRate: Number(getSetting('default_rate', 25)) }));

// --- Calendrier ------------------------------------------------------------
// Les clients voient : leurs propres demandes en détail, et tout le reste comme « Occupé ».
app.get('/api/calendar', auth, (req, res) => {
  const events = [];
  for (const u of db.prepare('SELECT * FROM unavailabilities').all())
    events.push({ id: 'u' + u.id, kind: 'unavailable', start: u.start, end: u.end,
      title: req.user.role === 'admin' ? `Indisponible${u.note ? ' – ' + u.note : ''}` : 'Indisponible' });
  const rows = db.prepare(`SELECT b.*, u.name client_name FROM bookings b JOIN users u ON u.id=b.client_id
    WHERE b.status IN ('pending','confirmed','done')`).all();
  for (const b of rows) {
    const mine = b.client_id === req.user.id;
    if (req.user.role === 'admin' || mine)
      events.push({ id: 'b' + b.id, kind: 'booking', bookingId: b.id, status: b.status, start: b.start, end: b.end,
        title: (req.user.role === 'admin' ? b.client_name + ' – ' : '') + (b.description || 'Travaux') });
    else events.push({ id: 'b' + b.id, kind: 'busy', start: b.start, end: b.end, title: 'Occupé' });
  }
  res.json(events);
});

function overlaps(start, end, excludeBookingId = 0) {
  const u = db.prepare('SELECT 1 FROM unavailabilities WHERE start < ? AND end > ?').get(end, start);
  const b = db.prepare(`SELECT 1 FROM bookings WHERE status IN ('pending','confirmed') AND id<>? AND start < ? AND end > ?`)
    .get(excludeBookingId, end, start);
  return !!(u || b);
}
const toUTC = s => new Date(s).toISOString();

// --- Réservations ----------------------------------------------------------
function bookingDetail(id) {
  const b = db.prepare(`SELECT b.*, u.name client_name, u.email client_email, u.phone client_phone
    FROM bookings b JOIN users u ON u.id=b.client_id WHERE b.id=?`).get(id);
  if (!b) return null;
  b.work = db.prepare('SELECT * FROM work_entries WHERE booking_id=? ORDER BY date').all(id);
  b.expenses = db.prepare('SELECT * FROM expenses WHERE booking_id=? ORDER BY id').all(id);
  const hours = b.work.reduce((s, w) => s + w.hours, 0);
  const labour = hours * (b.hourly_rate || 0);
  const exp = b.expenses.reduce((s, e) => s + e.amount, 0);
  b.totals = { hours, labour, expenses: exp, total: labour + exp };
  return b;
}
function canSee(req, b) { return b && (req.user.role === 'admin' || b.client_id === req.user.id); }

app.get('/api/bookings', auth, (req, res) => {
  const ids = req.user.role === 'admin'
    ? db.prepare('SELECT id FROM bookings ORDER BY start DESC').all()
    : db.prepare('SELECT id FROM bookings WHERE client_id=? ORDER BY start DESC').all(req.user.id);
  res.json(ids.map(r => bookingDetail(r.id)));
});
app.get('/api/bookings/:id', auth, (req, res) => {
  const b = bookingDetail(req.params.id);
  if (!canSee(req, b)) return res.status(404).json({ error: 'Introuvable' });
  res.json(b);
});
app.post('/api/bookings', auth, (req, res) => {
  const { start, end, description = '', address = '' } = req.body || {};
  if (!isISO(start) || !isISO(end) || Date.parse(end) <= Date.parse(start))
    return res.status(400).json({ error: 'Créneau invalide' });
  if (Date.parse(start) < Date.now() && req.user.role !== 'admin')
    return res.status(400).json({ error: 'Impossible de réserver dans le passé' });
  const s = toUTC(start), e = toUTC(end);
  if (overlaps(s, e)) return res.status(409).json({ error: 'Ce créneau n’est pas disponible' });
  const r = db.prepare('INSERT INTO bookings(client_id,start,end,description,address,hourly_rate) VALUES(?,?,?,?,?,?)')
    .run(req.user.id, s, e, description, address, Number(getSetting('default_rate', 25)));
  res.json(bookingDetail(r.lastInsertRowid));
});
// Le client peut annuler sa demande ; l'admin peut tout modifier.
app.patch('/api/bookings/:id', auth, (req, res) => {
  const b = bookingDetail(req.params.id);
  if (!canSee(req, b)) return res.status(404).json({ error: 'Introuvable' });
  const body = req.body || {};
  if (req.user.role !== 'admin') {
    if (body.status !== 'cancelled' || Object.keys(body).length !== 1)
      return res.status(403).json({ error: 'Vous pouvez uniquement annuler votre demande' });
    db.prepare("UPDATE bookings SET status='cancelled' WHERE id=?").run(b.id);
    return res.json(bookingDetail(b.id));
  }
  const allowed = ['pending', 'confirmed', 'rejected', 'cancelled', 'done'];
  if (body.status && !allowed.includes(body.status)) return res.status(400).json({ error: 'Statut invalide' });
  const start = body.start ? toUTC(body.start) : b.start, end = body.end ? toUTC(body.end) : b.end;
  db.prepare(`UPDATE bookings SET status=?, hourly_rate=?, admin_note=?, start=?, end=?, description=?, address=? WHERE id=?`)
    .run(body.status ?? b.status, body.hourly_rate !== undefined ? num(body.hourly_rate) : b.hourly_rate,
      body.admin_note ?? b.admin_note, start, end, body.description ?? b.description, body.address ?? b.address, b.id);
  res.json(bookingDetail(b.id));
});

// Heures prestées et achats (admin uniquement)
app.post('/api/bookings/:id/work', auth, admin, (req, res) => {
  const { date, hours, note = '' } = req.body || {};
  const h = num(hours);
  if (!date || !h || h <= 0) return res.status(400).json({ error: 'Date et nombre d’heures requis' });
  if (!bookingDetail(req.params.id)) return res.status(404).json({ error: 'Introuvable' });
  db.prepare('INSERT INTO work_entries(booking_id,date,hours,note) VALUES(?,?,?,?)').run(req.params.id, date, h, note);
  res.json(bookingDetail(req.params.id));
});
app.delete('/api/work/:id', auth, admin, (req, res) => {
  db.prepare('DELETE FROM work_entries WHERE id=?').run(req.params.id); res.json({ ok: true });
});
app.post('/api/bookings/:id/expenses', auth, admin, (req, res) => {
  const { label, amount } = req.body || {};
  const a = num(amount);
  if (!label || a === null) return res.status(400).json({ error: 'Libellé et montant requis' });
  if (!bookingDetail(req.params.id)) return res.status(404).json({ error: 'Introuvable' });
  db.prepare('INSERT INTO expenses(booking_id,label,amount) VALUES(?,?,?)').run(req.params.id, label, a);
  res.json(bookingDetail(req.params.id));
});
app.delete('/api/expenses/:id', auth, admin, (req, res) => {
  db.prepare('DELETE FROM expenses WHERE id=?').run(req.params.id); res.json({ ok: true });
});

// --- Indisponibilités & réglages (admin) ------------------------------------
app.post('/api/unavailabilities', auth, admin, (req, res) => {
  const { start, end, note = '' } = req.body || {};
  if (!isISO(start) || !isISO(end) || Date.parse(end) <= Date.parse(start))
    return res.status(400).json({ error: 'Période invalide' });
  const r = db.prepare('INSERT INTO unavailabilities(start,end,note) VALUES(?,?,?)').run(toUTC(start), toUTC(end), note);
  res.json({ id: r.lastInsertRowid });
});
app.delete('/api/unavailabilities/:id', auth, admin, (req, res) => {
  db.prepare('DELETE FROM unavailabilities WHERE id=?').run(req.params.id); res.json({ ok: true });
});
app.put('/api/settings', auth, admin, (req, res) => {
  const r = num(req.body?.default_rate);
  if (r === null || r < 0) return res.status(400).json({ error: 'Tarif invalide' });
  setSetting('default_rate', r); res.json({ ok: true });
});
app.get('/api/clients', auth, admin, (_req, res) =>
  res.json(db.prepare("SELECT id,name,email,phone,created_at FROM users WHERE role='client' ORDER BY name").all()));

if (require.main === module) app.listen(PORT, () => console.log(`Piotr démarré sur http://localhost:${PORT}`));
module.exports = app;
