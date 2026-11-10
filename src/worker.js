// Piotr – petits travaux : réservation de créneaux, suivi des heures et des frais.
// Cloudflare Worker (Hono + D1). Les fichiers de public/ sont servis par le binding ASSETS ;
// seules les routes /api/* passent par ce Worker (assets.run_worker_first dans wrangler.jsonc).
import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';

const app = new Hono();

// --- Utilitaires -------------------------------------------------------------
const hex = bytes => [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
const unhex = s => Uint8Array.from(s.match(/../g) || [], h => parseInt(h, 16));
const isISO = s => typeof s === 'string' && !isNaN(Date.parse(s));
const toUTC = s => new Date(s).toISOString();
const num = v => { const n = Number(v); return Number.isFinite(n) ? n : null; };
// Paramètre d'URL numérique ; 0 (id inexistant) si invalide, pour ne jamais lier NaN dans D1.
const idParam = c => { const n = Number(c.req.param('id')); return Number.isInteger(n) ? n : 0; };
// Corps JSON ; {} si absent, invalide ou pas un objet (équivalent de `req.body || {}`).
const json = c => c.req.json().then(v => (v && typeof v === 'object' && !Array.isArray(v) ? v : {}), () => ({}));
const getSetting = async (db, k, d) => (await db.prepare('SELECT value FROM settings WHERE key=?').bind(k).first('value')) ?? d;
const setSetting = (db, k, v) => db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
  .bind(k, String(v)).run();

// --- Mots de passe (PBKDF2-SHA-256 via WebCrypto) ----------------------------
// Format stocké : pbkdf2$<itérations>$<sel hex>$<hash hex>
const ITERATIONS = 100000;
async function pbkdf2(pw, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(String(pw)), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256));
}
async function hashPassword(pw) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2$${ITERATIONS}$${hex(salt)}$${hex(await pbkdf2(pw, salt, ITERATIONS))}`;
}
async function checkPassword(pw, stored) {
  const [scheme, iterations, salt, hash] = String(stored).split('$');
  if (scheme !== 'pbkdf2' || !salt || !hash) return false;
  const a = await pbkdf2(pw, unhex(salt), Number(iterations)), b = unhex(hash);
  let diff = a.length ^ b.length; // comparaison en temps constant
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ (b[i] ?? 0);
  return diff === 0;
}

// --- Sessions (cookie sid, jeton stocké en base) -----------------------------
function setSid(c, value, maxAge) {
  const secure = new URL(c.req.url).protocol === 'https:' ? '; Secure' : '';
  c.header('Set-Cookie', `sid=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure}`);
}
async function startSession(c, userId) {
  const token = hex(crypto.getRandomValues(new Uint8Array(32)));
  await c.env.DB.prepare('INSERT INTO sessions(token,user_id) VALUES(?,?)').bind(token, userId).run();
  setSid(c, token, 60 * 60 * 24 * 60);
}
app.use('/api/*', async (c, next) => {
  const token = getCookie(c, 'sid');
  if (token) {
    c.set('token', token);
    c.set('user', await c.env.DB.prepare(`SELECT u.id,u.email,u.name,u.phone,u.role FROM sessions s
      JOIN users u ON u.id=s.user_id WHERE s.token=?`).bind(token).first());
  }
  await next();
});
const auth = (c, next) => c.get('user') ? next() : c.json({ error: 'Non connecté' }, 401);
const admin = (c, next) => c.get('user')?.role === 'admin' ? next() : c.json({ error: 'Réservé à l’administrateur' }, 403);

// --- Authentification ------------------------------------------------------
app.post('/api/register', async c => {
  const { email, name, password, phone = '' } = await json(c);
  if (!email || !name || !password || password.length < 6)
    return c.json({ error: 'Nom, e-mail et mot de passe (6 caractères min.) requis' }, 400);
  const db = c.env.DB, normEmail = String(email).trim().toLowerCase();
  if (await db.prepare('SELECT 1 FROM users WHERE email=?').bind(normEmail).first())
    return c.json({ error: 'Cet e-mail est déjà utilisé' }, 409);
  const adminEmail = (c.env.ADMIN_EMAIL || '').toLowerCase();
  // Rôle : ADMIN_EMAIL s'il est défini, sinon le tout premier inscrit. Dans ce second cas, le test « table vide »
  // est fait dans l'INSERT lui-même (une seule instruction, donc atomique) : deux inscriptions simultanées,
  // éventuellement traitées par deux isolates, ne peuvent pas être toutes deux admin.
  const role = adminEmail ? (normEmail === adminEmail ? 'admin' : 'client') : null;
  let r;
  try {
    r = await db.prepare(`INSERT INTO users(email,name,phone,password_hash,role)
      VALUES(?,?,?,?, COALESCE(?, CASE WHEN EXISTS (SELECT 1 FROM users) THEN 'client' ELSE 'admin' END))`)
      .bind(normEmail, String(name).trim(), String(phone ?? '').trim(), await hashPassword(password), role).run();
  } catch (err) { // deux inscriptions simultanées avec le même e-mail : la contrainte UNIQUE tranche
    if (/UNIQUE constraint failed: users\.email/.test(String(err?.message))) return c.json({ error: 'Cet e-mail est déjà utilisé' }, 409);
    throw err;
  }
  await startSession(c, r.meta.last_row_id);
  return c.json({ ok: true });
});
app.post('/api/login', async c => {
  const { email = '', password = '' } = await json(c);
  const u = await c.env.DB.prepare('SELECT * FROM users WHERE email=?').bind(String(email).trim().toLowerCase()).first();
  if (!u || !(await checkPassword(password, u.password_hash))) return c.json({ error: 'Identifiants incorrects' }, 401);
  await startSession(c, u.id);
  return c.json({ ok: true });
});
app.post('/api/logout', async c => {
  if (c.get('token')) await c.env.DB.prepare('DELETE FROM sessions WHERE token=?').bind(c.get('token')).run();
  setSid(c, '', 0);
  return c.json({ ok: true });
});
app.get('/api/me', async c => c.json({ user: c.get('user') || null, defaultRate: Number(await getSetting(c.env.DB, 'default_rate', 25)) }));

// --- Calendrier ------------------------------------------------------------
// Les clients voient : leurs propres demandes en détail, et tout le reste comme « Occupé ».
app.get('/api/calendar', auth, async c => {
  const db = c.env.DB, user = c.get('user'), isAdmin = user.role === 'admin', events = [];
  const [unav, rows] = await db.batch([
    db.prepare('SELECT * FROM unavailabilities'),
    db.prepare(`SELECT b.*, u.name client_name FROM bookings b JOIN users u ON u.id=b.client_id
      WHERE b.status IN ('pending','confirmed','done')`),
  ]);
  for (const u of unav.results)
    events.push({ id: 'u' + u.id, kind: 'unavailable', start: u.start, end: u.end,
      title: isAdmin ? `Indisponible${u.note ? ' – ' + u.note : ''}` : 'Indisponible' });
  for (const b of rows.results) {
    if (isAdmin || b.client_id === user.id)
      events.push({ id: 'b' + b.id, kind: 'booking', bookingId: b.id, status: b.status, start: b.start, end: b.end,
        title: (isAdmin ? b.client_name + ' – ' : '') + (b.description || 'Travaux') });
    else events.push({ id: 'b' + b.id, kind: 'busy', start: b.start, end: b.end, title: 'Occupé' });
  }
  return c.json(events);
});

// Insertion conditionnelle d'une réservation : le contrôle de chevauchement et l'insertion forment UNE seule
// instruction SQL (atomique). Un contrôle séparé laisserait deux demandes simultanées sur le même créneau passer
// toutes les deux. Chevauchement = start < fin ET end > début (les créneaux qui se touchent sont permis) ;
// seules les réservations pending/confirmed bloquent (annulées, refusées et terminées libèrent le créneau).
// Paramètres : 1 client_id, 2 start, 3 end, 4 description, 5 address, 6 hourly_rate.
const INSERT_BOOKING_SQL = `INSERT INTO bookings(client_id,start,end,description,address,hourly_rate)
  SELECT ?1,?2,?3,?4,?5,?6
  WHERE NOT EXISTS (SELECT 1 FROM unavailabilities WHERE start < ?3 AND end > ?2)
    AND NOT EXISTS (SELECT 1 FROM bookings WHERE status IN ('pending','confirmed') AND start < ?3 AND end > ?2)`;

// --- Réservations ----------------------------------------------------------
const BOOKING_SQL = `SELECT b.*, u.name client_name, u.email client_email, u.phone client_phone
  FROM bookings b JOIN users u ON u.id=b.client_id`;
function withTotals(b, work, expenses) {
  b.work = work; b.expenses = expenses;
  const hours = work.reduce((s, w) => s + w.hours, 0);
  const labour = hours * (b.hourly_rate || 0);
  const exp = expenses.reduce((s, e) => s + e.amount, 0);
  b.totals = { hours, labour, expenses: exp, total: labour + exp };
  return b;
}
async function bookingDetail(db, id) {
  const [b, w, e] = await db.batch([
    db.prepare(`${BOOKING_SQL} WHERE b.id=?`).bind(id),
    db.prepare('SELECT * FROM work_entries WHERE booking_id=? ORDER BY date').bind(id),
    db.prepare('SELECT * FROM expenses WHERE booking_id=? ORDER BY id').bind(id),
  ]);
  return b.results[0] ? withTotals(b.results[0], w.results, e.results) : null;
}
const bookingExists = (db, id) => db.prepare('SELECT 1 FROM bookings WHERE id=?').bind(id).first();
const canSee = (user, b) => !!b && (user.role === 'admin' || b.client_id === user.id);

app.get('/api/bookings', auth, async c => {
  const db = c.env.DB, user = c.get('user'), mine = user.role !== 'admin';
  const q = sql => (mine ? db.prepare(sql).bind(user.id) : db.prepare(sql)), where = mine ? 'WHERE b.client_id=?' : '';
  const [bs, ws, es] = await db.batch([
    q(`${BOOKING_SQL} ${where} ORDER BY b.start DESC`),
    q(`SELECT w.* FROM work_entries w JOIN bookings b ON b.id=w.booking_id ${where} ORDER BY w.date`),
    q(`SELECT e.* FROM expenses e JOIN bookings b ON b.id=e.booking_id ${where} ORDER BY e.id`),
  ]);
  return c.json(bs.results.map(b => withTotals(b,
    ws.results.filter(w => w.booking_id === b.id), es.results.filter(e => e.booking_id === b.id))));
});
app.get('/api/bookings/:id', auth, async c => {
  const b = await bookingDetail(c.env.DB, idParam(c));
  if (!canSee(c.get('user'), b)) return c.json({ error: 'Introuvable' }, 404);
  return c.json(b);
});
app.post('/api/bookings', auth, async c => {
  const { start, end, description = '', address = '' } = await json(c);
  const db = c.env.DB, user = c.get('user');
  if (!isISO(start) || !isISO(end) || Date.parse(end) <= Date.parse(start))
    return c.json({ error: 'Créneau invalide' }, 400);
  if (Date.parse(start) < Date.now() && user.role !== 'admin')
    return c.json({ error: 'Impossible de réserver dans le passé' }, 400);
  const s = toUTC(start), e = toUTC(end);
  const r = await db.prepare(INSERT_BOOKING_SQL)
    .bind(user.id, s, e, description, address, Number(await getSetting(db, 'default_rate', 25))).run();
  if (!r.meta.changes) return c.json({ error: 'Ce créneau n’est pas disponible' }, 409);
  return c.json(await bookingDetail(db, r.meta.last_row_id));
});
// Le client peut annuler sa demande ; l'admin peut tout modifier.
app.patch('/api/bookings/:id', auth, async c => {
  const db = c.env.DB, user = c.get('user'), b = await bookingDetail(db, idParam(c));
  if (!canSee(user, b)) return c.json({ error: 'Introuvable' }, 404);
  const body = await json(c);
  if (user.role !== 'admin') {
    if (body.status !== 'cancelled' || Object.keys(body).length !== 1)
      return c.json({ error: 'Vous pouvez uniquement annuler votre demande' }, 403);
    await db.prepare("UPDATE bookings SET status='cancelled' WHERE id=?").bind(b.id).run();
    return c.json(await bookingDetail(db, b.id));
  }
  const allowed = ['pending', 'confirmed', 'rejected', 'cancelled', 'done'];
  // `!= null` (et non une simple vérité) : un statut '' ou false serait sinon enregistré tel quel.
  if (body.status != null && !allowed.includes(body.status)) return c.json({ error: 'Statut invalide' }, 400);
  if ((body.start && !isISO(body.start)) || (body.end && !isISO(body.end))) return c.json({ error: 'Créneau invalide' }, 400);
  const start = body.start ? toUTC(body.start) : b.start, end = body.end ? toUTC(body.end) : b.end;
  if ((body.start || body.end) && Date.parse(end) <= Date.parse(start)) return c.json({ error: 'Créneau invalide' }, 400);
  await db.prepare('UPDATE bookings SET status=?, hourly_rate=?, admin_note=?, start=?, end=?, description=?, address=? WHERE id=?')
    .bind(body.status ?? b.status, body.hourly_rate !== undefined ? num(body.hourly_rate) : b.hourly_rate,
      body.admin_note ?? b.admin_note, start, end, body.description ?? b.description, body.address ?? b.address, b.id).run();
  return c.json(await bookingDetail(db, b.id));
});

// Heures prestées et achats (admin uniquement)
app.post('/api/bookings/:id/work', auth, admin, async c => {
  const { date, hours, note = '' } = await json(c), h = num(hours), db = c.env.DB, id = idParam(c);
  if (!date || !h || h <= 0) return c.json({ error: 'Date et nombre d’heures requis' }, 400);
  if (!(await bookingExists(db, id))) return c.json({ error: 'Introuvable' }, 404);
  await db.prepare('INSERT INTO work_entries(booking_id,date,hours,note) VALUES(?,?,?,?)').bind(id, date, h, note).run();
  return c.json(await bookingDetail(db, id));
});
app.delete('/api/work/:id', auth, admin, async c => {
  await c.env.DB.prepare('DELETE FROM work_entries WHERE id=?').bind(idParam(c)).run(); return c.json({ ok: true });
});
app.post('/api/bookings/:id/expenses', auth, admin, async c => {
  const { label, amount } = await json(c), a = num(amount), db = c.env.DB, id = idParam(c);
  if (!label || a === null) return c.json({ error: 'Libellé et montant requis' }, 400);
  if (!(await bookingExists(db, id))) return c.json({ error: 'Introuvable' }, 404);
  await db.prepare('INSERT INTO expenses(booking_id,label,amount) VALUES(?,?,?)').bind(id, label, a).run();
  return c.json(await bookingDetail(db, id));
});
app.delete('/api/expenses/:id', auth, admin, async c => {
  await c.env.DB.prepare('DELETE FROM expenses WHERE id=?').bind(idParam(c)).run(); return c.json({ ok: true });
});

// --- Indisponibilités & réglages (admin) ------------------------------------
app.post('/api/unavailabilities', auth, admin, async c => {
  const { start, end, note = '' } = await json(c);
  if (!isISO(start) || !isISO(end) || Date.parse(end) <= Date.parse(start))
    return c.json({ error: 'Période invalide' }, 400);
  const r = await c.env.DB.prepare('INSERT INTO unavailabilities(start,end,note) VALUES(?,?,?)').bind(toUTC(start), toUTC(end), note).run();
  return c.json({ id: r.meta.last_row_id });
});
app.delete('/api/unavailabilities/:id', auth, admin, async c => {
  await c.env.DB.prepare('DELETE FROM unavailabilities WHERE id=?').bind(idParam(c)).run(); return c.json({ ok: true });
});
app.put('/api/settings', auth, admin, async c => {
  const r = num((await json(c)).default_rate);
  if (r === null || r < 0) return c.json({ error: 'Tarif invalide' }, 400);
  await setSetting(c.env.DB, 'default_rate', r); return c.json({ ok: true });
});
app.get('/api/clients', auth, admin, async c =>
  c.json((await c.env.DB.prepare("SELECT id,name,email,phone,created_at FROM users WHERE role='client' ORDER BY name").all()).results));

// --- Divers ------------------------------------------------------------------
// Route API inconnue → 404 JSON ; tout le reste → fichiers statiques (si jamais le Worker les reçoit).
app.notFound(c => c.req.path.startsWith('/api/') ? c.json({ error: 'Introuvable' }, 404) : c.env.ASSETS.fetch(c.req.raw));
app.onError((err, c) => { console.error(err); return c.json({ error: 'Erreur serveur' }, 500); });

export default app;
