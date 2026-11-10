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
// Champ texte libre : la valeur si c'est une chaîne, sinon la valeur par défaut (un objet lié tel quel ferait échouer D1 → 500).
const str = (v, d = '') => typeof v === 'string' ? v : d;
// Paramètre d'URL numérique ; 0 (id inexistant) si invalide, pour ne jamais lier NaN dans D1.
const idParam = c => { const n = Number(c.req.param('id')); return Number.isInteger(n) ? n : 0; };
// Corps JSON ; {} si absent, invalide ou pas un objet (équivalent de `req.body || {}`).
const json = c => c.req.json().then(v => (v && typeof v === 'object' && !Array.isArray(v) ? v : {}), () => ({}));
const getSetting = async (db, k, d) => (await db.prepare('SELECT value FROM settings WHERE key=?').bind(k).first('value')) ?? d;
const setSetting = (db, k, v) => db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
  .bind(k, String(v)).run();

// --- Erreurs : texte français (affiché tel quel) + code stable (pour la traduction côté client) -----
const ERRORS = {
  NOT_LOGGED_IN: [401, 'Non connecté'], ADMIN_ONLY: [403, 'Réservé à l’administrateur'],
  CLIENT_CANCEL_ONLY: [403, 'Vous pouvez uniquement annuler votre demande'], NOT_FOUND: [404, 'Introuvable'],
  REGISTER_INVALID: [400, 'Nom, e-mail et mot de passe (6 caractères min.) requis'], EMAIL_TAKEN: [409, 'Cet e-mail est déjà utilisé'],
  INVALID_CREDENTIALS: [401, 'Identifiants incorrects'], SLOT_INVALID: [400, 'Créneau invalide'],
  SLOT_PAST: [400, 'Impossible de réserver dans le passé'], SLOT_UNAVAILABLE: [409, 'Ce créneau n’est pas disponible'],
  STATUS_INVALID: [400, 'Statut invalide'], WORK_INVALID: [400, 'Date et nombre d’heures requis'],
  EXPENSE_INVALID: [400, 'Libellé et montant requis'], PERIOD_INVALID: [400, 'Période invalide'], RATE_INVALID: [400, 'Tarif invalide'],
  SERVER_ERROR: [500, 'Erreur serveur'], FILE_MISSING: [400, 'Fichier manquant'], FILE_TYPE: [400, 'Format d’image non pris en charge'],
  FILE_TOO_LARGE: [413, 'Fichier trop volumineux (10 Mo max.)'], EXPENSE_MISMATCH: [400, 'Cet achat n’appartient pas à cette intervention'],
  CAPTION_INVALID: [400, 'Légende trop longue (200 caractères max.)'],
};
const err = (c, code) => c.json({ error: ERRORS[code][1], code }, ERRORS[code][0]);

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
const auth = (c, next) => c.get('user') ? next() : err(c, 'NOT_LOGGED_IN');
const admin = (c, next) => c.get('user')?.role === 'admin' ? next() : err(c, 'ADMIN_ONLY');

// --- Authentification ------------------------------------------------------
app.post('/api/register', async c => {
  const { email, name, password, phone } = await json(c);
  // Chaînes exigées : un mot de passe numérique (12) ou un objet {length:99} contournerait sinon le minimum de 6 caractères.
  if ([email, name, password].some(v => typeof v !== 'string') || !email.trim() || !name.trim() || password.length < 6) return err(c, 'REGISTER_INVALID');
  const db = c.env.DB, normEmail = email.trim().toLowerCase();
  if (await db.prepare('SELECT 1 FROM users WHERE email=?').bind(normEmail).first()) return err(c, 'EMAIL_TAKEN');
  const adminEmail = (c.env.ADMIN_EMAIL || '').toLowerCase();
  // Rôle : ADMIN_EMAIL s'il est défini, sinon le tout premier inscrit. Dans ce second cas, le test « table vide »
  // est fait dans l'INSERT lui-même (une seule instruction, donc atomique) : deux inscriptions simultanées,
  // éventuellement traitées par deux isolates, ne peuvent pas être toutes deux admin.
  const role = adminEmail ? (normEmail === adminEmail ? 'admin' : 'client') : null;
  let r;
  try {
    r = await db.prepare(`INSERT INTO users(email,name,phone,password_hash,role)
      VALUES(?,?,?,?, COALESCE(?, CASE WHEN EXISTS (SELECT 1 FROM users) THEN 'client' ELSE 'admin' END))`)
      .bind(normEmail, name.trim(), str(phone).trim(), await hashPassword(password), role).run();
  } catch (e) { // deux inscriptions simultanées avec le même e-mail : la contrainte UNIQUE tranche
    if (/UNIQUE constraint failed: users\.email/.test(String(e?.message))) return err(c, 'EMAIL_TAKEN');
    throw e;
  }
  await startSession(c, r.meta.last_row_id);
  return c.json({ ok: true });
});
app.post('/api/login', async c => {
  const { email, password } = await json(c);
  if (typeof email !== 'string' || typeof password !== 'string') return err(c, 'INVALID_CREDENTIALS');
  const u = await c.env.DB.prepare('SELECT * FROM users WHERE email=?').bind(email.trim().toLowerCase()).first();
  if (!u || !(await checkPassword(password, u.password_hash))) return err(c, 'INVALID_CREDENTIALS');
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
// « title » (français) est conservé pour compatibilité ; les champs bruts (note, description, client_name)
// permettent à l'interface de composer un titre dans la langue de l'utilisateur.
app.get('/api/calendar', auth, async c => {
  const db = c.env.DB, user = c.get('user'), isAdmin = user.role === 'admin', events = [];
  const [unav, rows] = await db.batch([
    db.prepare('SELECT * FROM unavailabilities'),
    db.prepare(`SELECT b.*, u.name client_name FROM bookings b JOIN users u ON u.id=b.client_id
      WHERE b.status IN ('pending','confirmed','done')`),
  ]);
  for (const u of unav.results)
    events.push({ id: 'u' + u.id, kind: 'unavailable', start: u.start, end: u.end,
      title: isAdmin ? `Indisponible${u.note ? ' – ' + u.note : ''}` : 'Indisponible', ...(isAdmin && { note: u.note || '' }) });
  for (const b of rows.results) {
    if (isAdmin || b.client_id === user.id)
      events.push({ id: 'b' + b.id, kind: 'booking', bookingId: b.id, status: b.status, start: b.start, end: b.end,
        title: (isAdmin ? b.client_name + ' – ' : '') + (b.description || 'Travaux'),
        description: b.description || '', ...(isAdmin && { client_name: b.client_name }) });
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
// Photo telle qu'exposée par l'API : sans la clé R2 (détail interne), avec l'URL de téléchargement.
const photoJSON = ({ r2_key, client_id, ...p }) => ({ ...p, url: `/api/photos/${p.id}` });
function withTotals(b, work, expenses, photos) {
  b.work = work; b.expenses = expenses; b.photos = photos.map(photoJSON);
  const hours = work.reduce((s, w) => s + w.hours, 0);
  const labour = hours * (b.hourly_rate || 0);
  const exp = expenses.reduce((s, e) => s + e.amount, 0);
  b.totals = { hours, labour, expenses: exp, total: labour + exp };
  return b;
}
async function bookingDetail(db, id) {
  const [b, w, e, p] = await db.batch([
    db.prepare(`${BOOKING_SQL} WHERE b.id=?`).bind(id),
    db.prepare('SELECT * FROM work_entries WHERE booking_id=? ORDER BY date').bind(id),
    db.prepare('SELECT * FROM expenses WHERE booking_id=? ORDER BY id').bind(id),
    db.prepare('SELECT * FROM photos WHERE booking_id=? ORDER BY id').bind(id),
  ]);
  return b.results[0] ? withTotals(b.results[0], w.results, e.results, p.results) : null;
}
const bookingExists = (db, id) => db.prepare('SELECT 1 FROM bookings WHERE id=?').bind(id).first();
const canSee = (user, b) => !!b && (user.role === 'admin' || b.client_id === user.id);

app.get('/api/bookings', auth, async c => {
  const db = c.env.DB, user = c.get('user'), mine = user.role !== 'admin';
  const q = sql => (mine ? db.prepare(sql).bind(user.id) : db.prepare(sql)), where = mine ? 'WHERE b.client_id=?' : '';
  const [bs, ws, es, ps] = await db.batch([
    q(`${BOOKING_SQL} ${where} ORDER BY b.start DESC`),
    q(`SELECT w.* FROM work_entries w JOIN bookings b ON b.id=w.booking_id ${where} ORDER BY w.date`),
    q(`SELECT e.* FROM expenses e JOIN bookings b ON b.id=e.booking_id ${where} ORDER BY e.id`),
    q(`SELECT p.* FROM photos p JOIN bookings b ON b.id=p.booking_id ${where} ORDER BY p.id`),
  ]);
  return c.json(bs.results.map(b => withTotals(b, ws.results.filter(w => w.booking_id === b.id),
    es.results.filter(e => e.booking_id === b.id), ps.results.filter(p => p.booking_id === b.id))));
});
app.get('/api/bookings/:id', auth, async c => {
  const b = await bookingDetail(c.env.DB, idParam(c));
  if (!canSee(c.get('user'), b)) return err(c, 'NOT_FOUND');
  return c.json(b);
});
app.post('/api/bookings', auth, async c => {
  const { start, end, description, address } = await json(c);
  const db = c.env.DB, user = c.get('user');
  if (!isISO(start) || !isISO(end) || Date.parse(end) <= Date.parse(start)) return err(c, 'SLOT_INVALID');
  if (Date.parse(start) < Date.now() && user.role !== 'admin') return err(c, 'SLOT_PAST');
  const s = toUTC(start), e = toUTC(end);
  const r = await db.prepare(INSERT_BOOKING_SQL)
    .bind(user.id, s, e, str(description), str(address), Number(await getSetting(db, 'default_rate', 25))).run();
  if (!r.meta.changes) return err(c, 'SLOT_UNAVAILABLE');
  return c.json(await bookingDetail(db, r.meta.last_row_id));
});
// Le client peut annuler sa demande ; l'admin peut tout modifier.
app.patch('/api/bookings/:id', auth, async c => {
  const db = c.env.DB, user = c.get('user'), b = await bookingDetail(db, idParam(c));
  if (!canSee(user, b)) return err(c, 'NOT_FOUND');
  const body = await json(c);
  if (user.role !== 'admin') {
    if (body.status !== 'cancelled' || Object.keys(body).length !== 1) return err(c, 'CLIENT_CANCEL_ONLY');
    await db.prepare("UPDATE bookings SET status='cancelled' WHERE id=?").bind(b.id).run();
    return c.json(await bookingDetail(db, b.id));
  }
  const allowed = ['pending', 'confirmed', 'rejected', 'cancelled', 'done'];
  // `!= null` (et non une simple vérité) : un statut '' ou false serait sinon enregistré tel quel.
  if (body.status != null && !allowed.includes(body.status)) return err(c, 'STATUS_INVALID');
  if ((body.start && !isISO(body.start)) || (body.end && !isISO(body.end))) return err(c, 'SLOT_INVALID');
  const start = body.start ? toUTC(body.start) : b.start, end = body.end ? toUTC(body.end) : b.end;
  if ((body.start || body.end) && Date.parse(end) <= Date.parse(start)) return err(c, 'SLOT_INVALID');
  await db.prepare('UPDATE bookings SET status=?, hourly_rate=?, admin_note=?, start=?, end=?, description=?, address=? WHERE id=?')
    .bind(body.status ?? b.status, body.hourly_rate !== undefined ? num(body.hourly_rate) : b.hourly_rate,
      str(body.admin_note, b.admin_note), start, end, str(body.description, b.description), str(body.address, b.address), b.id).run();
  return c.json(await bookingDetail(db, b.id));
});

// Heures prestées et achats (admin uniquement)
app.post('/api/bookings/:id/work', auth, admin, async c => {
  const { date, hours, note } = await json(c), h = num(hours), db = c.env.DB, id = idParam(c);
  if (typeof date !== 'string' || !date || !h || h <= 0) return err(c, 'WORK_INVALID');
  if (!(await bookingExists(db, id))) return err(c, 'NOT_FOUND');
  await db.prepare('INSERT INTO work_entries(booking_id,date,hours,note) VALUES(?,?,?,?)').bind(id, date, h, str(note)).run();
  return c.json(await bookingDetail(db, id));
});
app.delete('/api/work/:id', auth, admin, async c => {
  await c.env.DB.prepare('DELETE FROM work_entries WHERE id=?').bind(idParam(c)).run(); return c.json({ ok: true });
});
app.post('/api/bookings/:id/expenses', auth, admin, async c => {
  const { label, amount } = await json(c), a = num(amount), db = c.env.DB, id = idParam(c);
  if (typeof label !== 'string' || !label || a === null) return err(c, 'EXPENSE_INVALID');
  if (!(await bookingExists(db, id))) return err(c, 'NOT_FOUND');
  await db.prepare('INSERT INTO expenses(booking_id,label,amount) VALUES(?,?,?)').bind(id, label, a).run();
  return c.json(await bookingDetail(db, id));
});
// Les photos d'un achat supprimé restent attachées à l'intervention (expense_id remis à NULL par la clé étrangère).
app.delete('/api/expenses/:id', auth, admin, async c => {
  await c.env.DB.prepare('DELETE FROM expenses WHERE id=?').bind(idParam(c)).run(); return c.json({ ok: true });
});

// --- Photos (R2) -------------------------------------------------------------
// Fichier dans le bucket PHOTOS sous bookings/<id>/<uuid>.<ext>, métadonnées dans la table photos.
// Le type est détecté d'après les premiers octets : le type annoncé par le client n'est jamais utilisé,
// ce qui empêche de servir du SVG/HTML déguisé en image depuis l'origine de l'application.
const MAX_PHOTO = 10 * 1024 * 1024;
const HEIF_BRANDS = ['heic', 'heix', 'hevc', 'mif1', 'msf1', 'heif'];
function sniffImage(b) { // → [content_type, extension] ou null
  const ascii = (i, n) => String.fromCharCode(...b.subarray(i, i + n));
  if (b.length < 12) return null;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return ['image/jpeg', 'jpg'];
  if (ascii(0, 8) === '\x89PNG\r\n\x1a\n') return ['image/png', 'png'];
  if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') return ['image/webp', 'webp'];
  if (/^GIF8[79]a$/.test(ascii(0, 6))) return ['image/gif', 'gif'];
  if (ascii(4, 4) === 'ftyp' && HEIF_BRANDS.includes(ascii(8, 4))) return ['image/heic', 'heic'];
  return null;
}
// Valeur RFC 5987 pour filename*= (encodeURIComponent laisse passer ' ( ) * qui n'y sont pas admis).
const rfc5987 = s => encodeURIComponent(s).replace(/[()'*]/g, ch => '%' + ch.charCodeAt(0).toString(16).toUpperCase());
const photoRow = (db, id) => db.prepare('SELECT p.*, b.client_id FROM photos p JOIN bookings b ON b.id=p.booking_id WHERE p.id=?').bind(id).first();
// Lit un corps de requête en entier, avec une borne : null dès que la limite est dépassée (le reste n'est pas lu).
async function readBounded(stream, max) {
  if (!stream) return new Uint8Array(0);
  const reader = stream.getReader(), chunks = []; let total = 0;
  for (let r = await reader.read(); !r.done; r = await reader.read()) {
    if ((total += r.value.byteLength) > max) { await reader.cancel(); return null; }
    chunks.push(r.value);
  }
  const out = new Uint8Array(total); let off = 0;
  for (const ch of chunks) { out.set(ch, off); off += ch.byteLength; }
  return out;
}

// Envoi (multipart : file, caption ≤ 200 car., expense_id). Admin ou client de l'intervention, quel que soit son statut ;
// lier la photo à un achat (justificatif) est réservé à l'admin.
app.post('/api/bookings/:id/photos', auth, async c => {
  const db = c.env.DB, user = c.get('user'), id = idParam(c);
  const b = await db.prepare('SELECT id,client_id FROM bookings WHERE id=?').bind(id).first();
  if (!canSee(user, b)) return err(c, 'NOT_FOUND');
  // Taille annoncée contrôlée avant de lire le corps (petite marge pour l'enrobage multipart) ; le corps est ensuite lu
  // en flux avec la même borne (un envoi « chunked » n'annonce pas de taille et serait sinon mis en mémoire en entier),
  // puis la taille réelle du fichier est vérifiée.
  const MAX_BODY = MAX_PHOTO + 16384;
  if (Number(c.req.header('content-length')) > MAX_BODY) return err(c, 'FILE_TOO_LARGE');
  let body;
  try { body = await readBounded(c.req.raw.body, MAX_BODY); } catch { return err(c, 'FILE_MISSING'); } // connexion coupée
  if (body === null) return err(c, 'FILE_TOO_LARGE');
  const form = await new Response(body, { headers: { 'content-type': c.req.header('content-type') || '' } }).formData().catch(() => null);
  const file = form?.get('file');
  if (!file || typeof file === 'string' || !file.size) return err(c, 'FILE_MISSING');
  if (file.size > MAX_PHOTO) return err(c, 'FILE_TOO_LARGE');
  const rawCaption = form.get('caption'), caption = typeof rawCaption === 'string' ? rawCaption.trim() : ''; // un fichier nommé « caption » est ignoré
  if (caption.length > 200) return err(c, 'CAPTION_INVALID');
  let expenseId = null;
  const rawExpense = form.get('expense_id');
  if (rawExpense != null && String(rawExpense).trim() !== '') {
    if (user.role !== 'admin') return err(c, 'ADMIN_ONLY');
    expenseId = Number(rawExpense);
    if (!Number.isInteger(expenseId) || !(await db.prepare('SELECT 1 FROM expenses WHERE id=? AND booking_id=?').bind(expenseId, id).first()))
      return err(c, 'EXPENSE_MISMATCH');
  }
  const bytes = new Uint8Array(await file.arrayBuffer()), type = sniffImage(bytes);
  if (!type) return err(c, 'FILE_TYPE');
  const [contentType, ext] = type, key = `bookings/${id}/${crypto.randomUUID()}.${ext}`;
  // Troncature par points de code : couper une paire UTF-16 laisserait un demi-caractère (UTF-8 invalide en base).
  const filename = [...String(file.name || '').replace(/[\\/]/g, '_').trim()].slice(0, 200).join('') || `photo.${ext}`;
  await c.env.PHOTOS.put(key, bytes, { httpMetadata: { contentType } });
  let r;
  try {
    r = await db.prepare(`INSERT INTO photos(booking_id,expense_id,r2_key,filename,content_type,size,caption,uploaded_by)
      VALUES(?,?,?,?,?,?,?,?)`).bind(id, expenseId, key, filename, contentType, bytes.length, caption, user.id).run();
  } catch (e) { await c.env.PHOTOS.delete(key); throw e; } // pas d'objet orphelin dans R2
  return c.json(photoJSON(await db.prepare('SELECT * FROM photos WHERE id=?').bind(r.meta.last_row_id).first()));
});
// Lecture : admin ou client de l'intervention ; sinon 404 (sans révéler l'existence). ?download=1 → pièce jointe.
app.get('/api/photos/:id', auth, async c => {
  const p = await photoRow(c.env.DB, idParam(c));
  if (!canSee(c.get('user'), p)) return err(c, 'NOT_FOUND');
  const obj = await c.env.PHOTOS.get(p.r2_key);
  if (!obj) return err(c, 'NOT_FOUND');
  const headers = { ETag: obj.httpEtag, 'Cache-Control': 'private, max-age=86400' };
  // If-None-Match comparé ici (liste d'ETags, préfixe W/ toléré, « * ») : transmis tel quel à R2 (onlyIf), un en-tête mal
  // formé (ETag sans guillemets, guillemet non fermé…) faisait échouer l'appel R2, donc une erreur 500.
  const tags = (c.req.header('if-none-match') || '').split(',').map(t => t.trim().replace(/^W\//, ''));
  if (tags.includes('*') || tags.includes(obj.httpEtag)) { await obj.body.cancel(); return new Response(null, { status: 304, headers }); }
  const disposition = c.req.query('download') === '1' ? 'attachment' : 'inline';
  return new Response(obj.body, { headers: { ...headers, 'Content-Type': p.content_type, 'Content-Length': String(obj.size),
    'X-Content-Type-Options': 'nosniff', 'Content-Disposition': `${disposition}; filename*=UTF-8''${rfc5987(p.filename)}` } });
});
// Suppression : admin, ou le client de l'intervention s'il a lui-même envoyé la photo.
app.delete('/api/photos/:id', auth, async c => {
  const db = c.env.DB, user = c.get('user'), p = await photoRow(db, idParam(c));
  if (!canSee(user, p)) return err(c, 'NOT_FOUND');
  if (user.role !== 'admin' && p.uploaded_by !== user.id) return err(c, 'ADMIN_ONLY');
  await c.env.PHOTOS.delete(p.r2_key);
  await db.prepare('DELETE FROM photos WHERE id=?').bind(p.id).run();
  return c.json({ ok: true });
});

// --- Indisponibilités & réglages (admin) ------------------------------------
app.post('/api/unavailabilities', auth, admin, async c => {
  const { start, end, note } = await json(c);
  if (!isISO(start) || !isISO(end) || Date.parse(end) <= Date.parse(start)) return err(c, 'PERIOD_INVALID');
  const r = await c.env.DB.prepare('INSERT INTO unavailabilities(start,end,note) VALUES(?,?,?)').bind(toUTC(start), toUTC(end), str(note)).run();
  return c.json({ id: r.meta.last_row_id });
});
app.delete('/api/unavailabilities/:id', auth, admin, async c => {
  await c.env.DB.prepare('DELETE FROM unavailabilities WHERE id=?').bind(idParam(c)).run(); return c.json({ ok: true });
});
app.put('/api/settings', auth, admin, async c => {
  const r = num((await json(c)).default_rate);
  if (r === null || r < 0) return err(c, 'RATE_INVALID');
  await setSetting(c.env.DB, 'default_rate', r); return c.json({ ok: true });
});
app.get('/api/clients', auth, admin, async c =>
  c.json((await c.env.DB.prepare("SELECT id,name,email,phone,created_at FROM users WHERE role='client' ORDER BY name").all()).results));

// --- Divers ------------------------------------------------------------------
// Route API inconnue → 404 JSON ; tout le reste → fichiers statiques (si jamais le Worker les reçoit).
app.notFound(c => c.req.path.startsWith('/api/') ? err(c, 'NOT_FOUND') : c.env.ASSETS.fetch(c.req.raw));
app.onError((e, c) => { console.error(e); return err(c, 'SERVER_ERROR'); });

export default app;
