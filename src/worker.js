// Piotr – petits travaux : activités (un prestataire et ses clients), réservation de créneaux, suivi des heures et des frais.
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
// Nombre fini depuis un nombre ou une chaîne numérique non vide, sinon null : Number() seul ferait de "", " ", true ou [] un 0 ou un 1 valide.
const num = v => { if (typeof v !== 'number' && (typeof v !== 'string' || !v.trim())) return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
// Champ texte libre : la valeur si c'est une chaîne, sinon la valeur par défaut (un objet lié tel quel ferait échouer D1 → 500).
const str = (v, d = '') => typeof v === 'string' ? v : d;
// Paramètre d'URL : entier positif en écriture canonique (« 1e0 », « 0x1 », « +1 », « 01 »… refusés), sinon 0 (id inexistant),
// pour ne jamais lier NaN dans D1.
const idParam = (c, name = 'id') => /^[1-9][0-9]{0,14}$/.test(c.req.param(name)) ? Number(c.req.param(name)) : 0;
// Corps JSON ; {} si absent, invalide ou pas un objet (équivalent de `req.body || {}`).
const json = c => c.req.json().then(v => (v && typeof v === 'object' && !Array.isArray(v) ? v : {}), () => ({}));

// --- Erreurs : texte français (affiché tel quel) + code stable (pour la traduction côté client) -----
const ERRORS = {
  NOT_LOGGED_IN: [401, 'Non connecté'], ADMIN_ONLY: [403, 'Réservé au prestataire'],
  CLIENT_CANCEL_ONLY: [403, 'Vous pouvez uniquement annuler votre demande'], NOT_FOUND: [404, 'Introuvable'],
  REGISTER_INVALID: [400, 'Nom, e-mail et mot de passe (6 caractères min.) requis'], EMAIL_TAKEN: [409, 'Cet e-mail est déjà utilisé'],
  INVALID_CREDENTIALS: [401, 'Identifiants incorrects'], SLOT_INVALID: [400, 'Créneau invalide'],
  SLOT_PAST: [400, 'Impossible de réserver dans le passé'], SLOT_UNAVAILABLE: [409, 'Ce créneau n’est pas disponible'],
  STATUS_INVALID: [400, 'Statut invalide'], WORK_INVALID: [400, 'Date et nombre d’heures requis'],
  EXPENSE_INVALID: [400, 'Libellé et montant requis'], PERIOD_INVALID: [400, 'Période invalide'], RATE_INVALID: [400, 'Tarif invalide'],
  SERVER_ERROR: [500, 'Erreur serveur'], FILE_MISSING: [400, 'Fichier manquant'], FILE_TYPE: [400, 'Format d’image non pris en charge'],
  FILE_TOO_LARGE: [413, 'Fichier trop volumineux (10 Mo max.)'], EXPENSE_MISMATCH: [400, 'Cet achat n’appartient pas à cette intervention'],
  CAPTION_INVALID: [400, 'Légende trop longue (200 caractères max.)'],
  ACTIVITY_INVALID: [400, 'Nom d’activité invalide (2 à 60 caractères)'], INVITE_INVALID: [404, 'Lien ou code d’invitation invalide'],
  CANNOT_REMOVE_OWNER: [400, 'Impossible de retirer le prestataire'],
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
    c.set('user', await c.env.DB.prepare(`SELECT u.id,u.email,u.name,u.phone FROM sessions s
      JOIN users u ON u.id=s.user_id WHERE s.token=?`).bind(token).first());
  }
  await next();
});
const auth = (c, next) => c.get('user') ? next() : err(c, 'NOT_LOGGED_IN');

// --- Authentification ------------------------------------------------------
// Un compte est une simple personne : ses rôles (prestataire, client) dépendent de chaque activité (voir memberships).
app.post('/api/register', async c => {
  const { email, name, password, phone } = await json(c);
  // Chaînes exigées : un mot de passe numérique (12) ou un objet {length:99} contournerait sinon le minimum de 6 caractères.
  if ([email, name, password].some(v => typeof v !== 'string') || !email.trim() || !name.trim() || password.length < 6) return err(c, 'REGISTER_INVALID');
  const db = c.env.DB, normEmail = email.trim().toLowerCase();
  if (await db.prepare('SELECT 1 FROM users WHERE email=?').bind(normEmail).first()) return err(c, 'EMAIL_TAKEN');
  let r;
  try {
    r = await db.prepare('INSERT INTO users(email,name,phone,password_hash) VALUES(?,?,?,?)')
      .bind(normEmail, name.trim(), str(phone).trim(), await hashPassword(password)).run();
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

// --- Activités et adhésions ---------------------------------------------------
// Une activité = un prestataire (owner) et ses clients, reliés par la table memberships ; les clients la rejoignent par un
// lien d'invitation (invite_code). Calendrier, indisponibilités, réservations et tarif sont rattachés à une activité ;
// un utilisateur peut être prestataire de la sienne et client de plusieurs autres. Un non-membre reçoit 404 sur toutes
// les routes d'une activité (son existence n'est jamais révélée) ; un client sur une action de prestataire reçoit 403.
const member = (db, aid, userId) => db.prepare('SELECT role FROM memberships WHERE activity_id=? AND user_id=?').bind(aid, userId).first('role');
const ACTIVITY_COLS = `a.id, a.name, a.default_rate, a.invite_code, o.name owner_name,
  (SELECT COUNT(*) FROM memberships m WHERE m.activity_id=a.id) members_count`;
const activityRow = (db, aid) => db.prepare(`SELECT ${ACTIVITY_COLS} FROM activities a JOIN users o ON o.id=a.owner_id WHERE a.id=?`).bind(aid).first();
// Objet activité tel qu'exposé : tarif, code d'invitation et nombre de membres (prestataire compris) réservés au prestataire.
const activityJSON = ({ id, name, owner_name, default_rate, invite_code, members_count }, role) =>
  ({ id, name, role, owner_name, ...(role === 'owner' && { default_rate, invite_code, members_count }) });
// Code d'invitation : 20 caractères hexadécimaux aléatoires ; le régénérer invalide l'ancien lien.
const inviteCode = () => hex(crypto.getRandomValues(new Uint8Array(10)));
// Nom (2 à 60 caractères, espaces retirés) et tarif (≥ 0) d'une activité → [code d'erreur] ou [null, { name, rate }].
// À la création, le nom est requis et le tarif vaut 25 par défaut ; en modification, les champs absents sont conservés
// tels quels, sans être revalidés : un nom hérité de la migration (nom d'utilisateur hors bornes) ne doit pas bloquer
// la modification du seul tarif.
function activityFields(body, current) {
  const setName = body.name != null || !current, name = setName ? [...str(body.name).trim()] : null;
  if (setName && (name.length < 2 || name.length > 60)) return ['ACTIVITY_INVALID'];
  const rate = body.default_rate != null ? num(body.default_rate) : current ? current.default_rate : 25;
  if (rate === null || rate < 0) return ['RATE_INVALID'];
  return [null, { name: setName ? name.join('') : current.name, rate }];
}
// Intergiciels des routes /api/activities/:aid/* : membre (rôle dans c.get('role'), id dans c.get('aid')) ; prestataire.
const inActivity = async (c, next) => {
  const aid = idParam(c, 'aid'), role = await member(c.env.DB, aid, c.get('user').id);
  if (!role) return err(c, 'NOT_FOUND');
  c.set('aid', aid); c.set('role', role);
  await next();
};
const ownerOnly = (c, next) => c.get('role') === 'owner' ? next() : err(c, 'ADMIN_ONLY');
// Rôle de l'utilisateur dans l'activité d'une ligne (indisponibilité…) ; null si ligne absente ou non-membre.
const roleOf = async (db, row, user) => row ? await member(db, row.activity_id, user.id) : null;
// Réponse d'erreur pour une action de prestataire (404 si inconnu / invisible, 403 si client), ou null si autorisé.
const ownerGate = (c, role) => !role ? err(c, 'NOT_FOUND') : role !== 'owner' ? err(c, 'ADMIN_ONLY') : null;

// Compte + ses activités ('owner' > 'client', donc le tri décroissant place les activités dont on est prestataire en tête).
app.get('/api/me', async c => {
  const user = c.get('user');
  if (!user) return c.json({ user: null, activities: [] });
  const { results } = await c.env.DB.prepare(`SELECT ${ACTIVITY_COLS}, mm.role FROM memberships mm
    JOIN activities a ON a.id=mm.activity_id JOIN users o ON o.id=a.owner_id
    WHERE mm.user_id=? ORDER BY mm.role DESC, a.name COLLATE NOCASE`).bind(user.id).all();
  return c.json({ user, activities: results.map(r => activityJSON(r, r.role)) });
});
app.post('/api/activities', auth, async c => {
  const [e, f] = activityFields(await json(c));
  if (e) return err(c, e);
  const db = c.env.DB, code = inviteCode();
  // Activité et adhésion du prestataire créées en un seul lot (transaction D1).
  await db.batch([
    db.prepare('INSERT INTO activities(owner_id,name,invite_code,default_rate) VALUES(?,?,?,?)').bind(c.get('user').id, f.name, code, f.rate),
    db.prepare("INSERT INTO memberships(activity_id,user_id,role) SELECT id,owner_id,'owner' FROM activities WHERE invite_code=?").bind(code),
  ]);
  const aid = await db.prepare('SELECT id FROM activities WHERE invite_code=?').bind(code).first('id');
  return c.json(activityJSON(await activityRow(db, aid), 'owner'));
});
app.get('/api/activities/:aid', auth, inActivity, async c => c.json(activityJSON(await activityRow(c.env.DB, c.get('aid')), c.get('role'))));
app.patch('/api/activities/:aid', auth, inActivity, ownerOnly, async c => {
  const db = c.env.DB, aid = c.get('aid'), [e, f] = activityFields(await json(c), await activityRow(db, aid));
  if (e) return err(c, e);
  await db.prepare('UPDATE activities SET name=?, default_rate=? WHERE id=?').bind(f.name, f.rate, aid).run();
  return c.json(activityJSON(await activityRow(db, aid), 'owner'));
});
app.post('/api/activities/:aid/invite/regenerate', auth, inActivity, ownerOnly, async c => {
  const code = inviteCode();
  await c.env.DB.prepare('UPDATE activities SET invite_code=? WHERE id=?').bind(code, c.get('aid')).run();
  return c.json({ invite_code: code });
});
app.get('/api/activities/:aid/members', auth, inActivity, ownerOnly, async c =>
  c.json((await c.env.DB.prepare(`SELECT u.id,u.name,u.email,u.phone,m.role,m.joined_at FROM memberships m JOIN users u ON u.id=m.user_id
    WHERE m.activity_id=? ORDER BY m.role DESC, u.name COLLATE NOCASE`).bind(c.get('aid')).all()).results));
// Retirer un client : il perd l'accès à l'activité et à ses demandes (qui restent visibles du prestataire).
app.delete('/api/activities/:aid/members/:userId', auth, inActivity, ownerOnly, async c => {
  const db = c.env.DB, aid = c.get('aid'), uid = idParam(c, 'userId'), role = await member(db, aid, uid);
  if (!role) return err(c, 'NOT_FOUND');
  if (role === 'owner') return err(c, 'CANNOT_REMOVE_OWNER');
  await db.prepare('DELETE FROM memberships WHERE activity_id=? AND user_id=?').bind(aid, uid).run();
  return c.json({ ok: true });
});

// Lien d'invitation /join/<code> : aperçu public, puis adhésion (connecté). Idempotent : un membre garde son rôle
// (le prestataire reste 'owner') ; deux adhésions simultanées → la clé primaire de memberships tranche (OR IGNORE).
const joinRow = (db, code) => db.prepare('SELECT a.id, a.name, o.name owner_name FROM activities a JOIN users o ON o.id=a.owner_id WHERE a.invite_code=?')
  .bind(code).first();
app.get('/api/join/:code', async c => {
  const a = await joinRow(c.env.DB, c.req.param('code'));
  if (!a) return err(c, 'INVITE_INVALID');
  return c.json({ activity: { id: a.id, name: a.name }, owner: { name: a.owner_name } });
});
app.post('/api/join/:code', auth, async c => {
  const db = c.env.DB, user = c.get('user'), a = await joinRow(db, c.req.param('code'));
  if (!a) return err(c, 'INVITE_INVALID');
  await db.prepare("INSERT OR IGNORE INTO memberships(activity_id,user_id,role) VALUES(?,?,'client')").bind(a.id, user.id).run();
  return c.json({ activity: { id: a.id, name: a.name, role: await member(db, a.id, user.id) } });
});

// --- Calendrier (d'une activité) --------------------------------------------
// Les clients voient : leurs propres demandes en détail, et tout le reste comme « Occupé ».
// « title » (français) est conservé pour compatibilité ; les champs bruts (note, description, client_name)
// permettent à l'interface de composer un titre dans la langue de l'utilisateur.
app.get('/api/activities/:aid/calendar', auth, inActivity, async c => {
  const db = c.env.DB, user = c.get('user'), aid = c.get('aid'), isOwner = c.get('role') === 'owner', events = [];
  const [unav, rows] = await db.batch([
    db.prepare('SELECT * FROM unavailabilities WHERE activity_id=?').bind(aid),
    db.prepare(`SELECT b.*, u.name client_name FROM bookings b JOIN users u ON u.id=b.client_id
      WHERE b.activity_id=? AND b.status IN ('pending','confirmed','done')`).bind(aid),
  ]);
  for (const u of unav.results)
    events.push({ id: 'u' + u.id, kind: 'unavailable', start: u.start, end: u.end,
      title: isOwner ? `Indisponible${u.note ? ' – ' + u.note : ''}` : 'Indisponible', ...(isOwner && { note: u.note || '' }) });
  for (const b of rows.results) {
    if (isOwner || b.client_id === user.id)
      events.push({ id: 'b' + b.id, kind: 'booking', bookingId: b.id, status: b.status, start: b.start, end: b.end,
        title: (isOwner ? b.client_name + ' – ' : '') + (b.description || 'Travaux'),
        description: b.description || '', ...(isOwner && { client_name: b.client_name }) });
    else events.push({ id: 'b' + b.id, kind: 'busy', start: b.start, end: b.end, title: 'Occupé' });
  }
  return c.json(events);
});

// Insertion conditionnelle d'une réservation : le contrôle de chevauchement et l'insertion forment UNE seule
// instruction SQL (atomique). Un contrôle séparé laisserait deux demandes simultanées sur le même créneau passer
// toutes les deux. Chevauchement = start < fin ET end > début (les créneaux qui se touchent sont permis), au sein de
// la même activité ; seules les réservations pending/confirmed bloquent (annulées, refusées et terminées libèrent le créneau).
// Paramètres : 1 activity_id, 2 client_id, 3 start, 4 end, 5 description, 6 address, 7 hourly_rate.
const INSERT_BOOKING_SQL = `INSERT INTO bookings(activity_id,client_id,start,end,description,address,hourly_rate)
  SELECT ?1,?2,?3,?4,?5,?6,?7
  WHERE NOT EXISTS (SELECT 1 FROM unavailabilities WHERE activity_id=?1 AND start < ?4 AND end > ?3)
    AND NOT EXISTS (SELECT 1 FROM bookings WHERE activity_id=?1 AND status IN ('pending','confirmed','done') AND start < ?4 AND end > ?3)`;

// --- Réservations ----------------------------------------------------------
const BOOKING_SQL = `SELECT b.*, u.name client_name, u.email client_email, u.phone client_phone
  FROM bookings b JOIN users u ON u.id=b.client_id`;
// Photo telle qu'exposée par l'API : sans la clé R2 ni les colonnes de contrôle d'accès, avec l'URL de téléchargement.
const photoJSON = ({ r2_key, client_id, activity_id, ...p }) => ({ ...p, url: `/api/photos/${p.id}` });
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
// Accès à une réservation (ou à une ligne qui en porte activity_id et client_id, comme une photo) : 'owner' pour le
// prestataire de son activité, 'client' pour son auteur s'il est encore membre, sinon null → 404 sans révéler l'existence.
// Un client retiré de l'activité perd ainsi l'accès à ses anciennes demandes, que le prestataire continue de voir.
async function bookingAccess(db, b, user) {
  const role = await roleOf(db, b, user);
  return role === 'owner' || (role === 'client' && b.client_id === user.id) ? role : null;
}
const loadBooking = (db, id) => db.prepare('SELECT id,activity_id,client_id FROM bookings WHERE id=?').bind(id).first();

app.get('/api/activities/:aid/bookings', auth, inActivity, async c => {
  const db = c.env.DB, user = c.get('user'), aid = c.get('aid'), mine = c.get('role') !== 'owner';
  const q = sql => (mine ? db.prepare(sql).bind(aid, user.id) : db.prepare(sql).bind(aid));
  const where = mine ? 'WHERE b.activity_id=?1 AND b.client_id=?2' : 'WHERE b.activity_id=?1';
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
  const db = c.env.DB, b = await bookingDetail(db, idParam(c));
  if (!(await bookingAccess(db, b, c.get('user')))) return err(c, 'NOT_FOUND');
  return c.json(b);
});
// Demande d'un membre (le prestataire peut aussi encoder une intervention passée) ; tarif = tarif par défaut de l'activité.
app.post('/api/activities/:aid/bookings', auth, inActivity, async c => {
  const { start, end, description, address } = await json(c);
  const db = c.env.DB, user = c.get('user'), aid = c.get('aid');
  if (!isISO(start) || !isISO(end) || Date.parse(end) <= Date.parse(start)) return err(c, 'SLOT_INVALID');
  if (Date.parse(start) < Date.now() && c.get('role') !== 'owner') return err(c, 'SLOT_PAST');
  const rate = await db.prepare('SELECT default_rate FROM activities WHERE id=?').bind(aid).first('default_rate');
  const r = await db.prepare(INSERT_BOOKING_SQL).bind(aid, user.id, toUTC(start), toUTC(end), str(description), str(address), rate).run();
  if (!r.meta.changes) return err(c, 'SLOT_UNAVAILABLE');
  return c.json(await bookingDetail(db, r.meta.last_row_id));
});
// Le client peut annuler sa demande ; le prestataire peut tout modifier.
app.patch('/api/bookings/:id', auth, async c => {
  const db = c.env.DB, user = c.get('user'), b = await bookingDetail(db, idParam(c)), role = await bookingAccess(db, b, user);
  if (!role) return err(c, 'NOT_FOUND');
  const body = await json(c);
  if (role !== 'owner') {
    if (body.status !== 'cancelled' || Object.keys(body).length !== 1) return err(c, 'CLIENT_CANCEL_ONLY');
    await db.prepare("UPDATE bookings SET status='cancelled' WHERE id=?").bind(b.id).run();
    return c.json(await bookingDetail(db, b.id));
  }
  const allowed = ['pending', 'confirmed', 'rejected', 'cancelled', 'done'];
  // `!= null` (et non une simple vérité) : un statut '' ou false serait sinon enregistré tel quel.
  if (body.status != null && !allowed.includes(body.status)) return err(c, 'STATUS_INVALID');
  if (body.hourly_rate !== undefined && (num(body.hourly_rate) === null || num(body.hourly_rate) < 0)) return err(c, 'RATE_INVALID');
  if ((body.start && !isISO(body.start)) || (body.end && !isISO(body.end))) return err(c, 'SLOT_INVALID');
  const start = body.start ? toUTC(body.start) : b.start, end = body.end ? toUTC(body.end) : b.end;
  if ((body.start || body.end) && Date.parse(end) <= Date.parse(start)) return err(c, 'SLOT_INVALID');
  await db.prepare('UPDATE bookings SET status=?, hourly_rate=?, admin_note=?, start=?, end=?, description=?, address=? WHERE id=?')
    .bind(body.status ?? b.status, body.hourly_rate !== undefined ? num(body.hourly_rate) : b.hourly_rate,
      str(body.admin_note, b.admin_note), start, end, str(body.description, b.description), str(body.address, b.address), b.id).run();
  return c.json(await bookingDetail(db, b.id));
});

// Heures prestées et achats : prestataire de l'activité de la réservation uniquement. Même grille que les autres routes
// d'une réservation : 404 si elle est invisible pour l'utilisateur (autre client, non-membre, inexistante), 403 si c'est
// le client de l'intervention.
app.post('/api/bookings/:id/work', auth, async c => {
  const db = c.env.DB, id = idParam(c), gate = ownerGate(c, await bookingAccess(db, await loadBooking(db, id), c.get('user')));
  if (gate) return gate;
  const { date, hours, note } = await json(c), h = num(hours);
  if (typeof date !== 'string' || !date || !h || h <= 0) return err(c, 'WORK_INVALID');
  await db.prepare('INSERT INTO work_entries(booking_id,date,hours,note) VALUES(?,?,?,?)').bind(id, date, h, str(note)).run();
  return c.json(await bookingDetail(db, id));
});
app.delete('/api/work/:id', auth, async c => {
  const db = c.env.DB, w = await db.prepare('SELECT w.id, b.activity_id, b.client_id FROM work_entries w JOIN bookings b ON b.id=w.booking_id WHERE w.id=?').bind(idParam(c)).first();
  const gate = ownerGate(c, await bookingAccess(db, w, c.get('user')));
  if (gate) return gate;
  await db.prepare('DELETE FROM work_entries WHERE id=?').bind(w.id).run(); return c.json({ ok: true });
});
app.post('/api/bookings/:id/expenses', auth, async c => {
  const db = c.env.DB, id = idParam(c), gate = ownerGate(c, await bookingAccess(db, await loadBooking(db, id), c.get('user')));
  if (gate) return gate;
  const { label, amount } = await json(c), a = num(amount);
  if (typeof label !== 'string' || !label || a === null) return err(c, 'EXPENSE_INVALID');
  await db.prepare('INSERT INTO expenses(booking_id,label,amount) VALUES(?,?,?)').bind(id, label, a).run();
  return c.json(await bookingDetail(db, id));
});
// Les photos d'un achat supprimé restent attachées à l'intervention (expense_id remis à NULL par la clé étrangère).
app.delete('/api/expenses/:id', auth, async c => {
  const db = c.env.DB, e = await db.prepare('SELECT e.id, b.activity_id, b.client_id FROM expenses e JOIN bookings b ON b.id=e.booking_id WHERE e.id=?').bind(idParam(c)).first();
  const gate = ownerGate(c, await bookingAccess(db, e, c.get('user')));
  if (gate) return gate;
  await db.prepare('DELETE FROM expenses WHERE id=?').bind(e.id).run(); return c.json({ ok: true });
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
const photoRow = (db, id) => db.prepare('SELECT p.*, b.client_id, b.activity_id FROM photos p JOIN bookings b ON b.id=p.booking_id WHERE p.id=?').bind(id).first();
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

// Envoi (multipart : file, caption ≤ 200 car., expense_id). Prestataire ou client de l'intervention, quel que soit son
// statut ; lier la photo à un achat (justificatif) est réservé au prestataire.
app.post('/api/bookings/:id/photos', auth, async c => {
  const db = c.env.DB, user = c.get('user'), id = idParam(c), role = await bookingAccess(db, await loadBooking(db, id), user);
  if (!role) return err(c, 'NOT_FOUND');
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
    if (role !== 'owner') return err(c, 'ADMIN_ONLY');
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
  } catch (e) {
    await c.env.PHOTOS.delete(key); // pas d'objet orphelin dans R2
    // Achat supprimé entre le contrôle et l'INSERT (clé étrangère) : même réponse que pour un achat inconnu, pas une erreur 500.
    if (expenseId !== null && /FOREIGN KEY constraint failed/.test(String(e?.message))) return err(c, 'EXPENSE_MISMATCH');
    throw e;
  }
  return c.json(photoJSON(await db.prepare('SELECT * FROM photos WHERE id=?').bind(r.meta.last_row_id).first()));
});
// Lecture : prestataire ou client de l'intervention ; sinon 404 (sans révéler l'existence). ?download=1 → pièce jointe.
app.get('/api/photos/:id', auth, async c => {
  const db = c.env.DB, p = await photoRow(db, idParam(c));
  if (!(await bookingAccess(db, p, c.get('user')))) return err(c, 'NOT_FOUND');
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
// Suppression : prestataire, ou le client de l'intervention s'il a lui-même envoyé la photo.
app.delete('/api/photos/:id', auth, async c => {
  const db = c.env.DB, user = c.get('user'), p = await photoRow(db, idParam(c)), role = await bookingAccess(db, p, user);
  if (!role) return err(c, 'NOT_FOUND');
  if (role !== 'owner' && p.uploaded_by !== user.id) return err(c, 'ADMIN_ONLY');
  await c.env.PHOTOS.delete(p.r2_key);
  await db.prepare('DELETE FROM photos WHERE id=?').bind(p.id).run();
  return c.json({ ok: true });
});

// --- Indisponibilités (prestataire) ------------------------------------------
app.post('/api/activities/:aid/unavailabilities', auth, inActivity, ownerOnly, async c => {
  const { start, end, note } = await json(c);
  if (!isISO(start) || !isISO(end) || Date.parse(end) <= Date.parse(start)) return err(c, 'PERIOD_INVALID');
  const r = await c.env.DB.prepare('INSERT INTO unavailabilities(activity_id,start,end,note) VALUES(?,?,?,?)')
    .bind(c.get('aid'), toUTC(start), toUTC(end), str(note)).run();
  return c.json({ id: r.meta.last_row_id });
});
app.delete('/api/unavailabilities/:id', auth, async c => {
  const db = c.env.DB, u = await db.prepare('SELECT id,activity_id FROM unavailabilities WHERE id=?').bind(idParam(c)).first();
  const gate = ownerGate(c, await roleOf(db, u, c.get('user')));
  if (gate) return gate;
  await db.prepare('DELETE FROM unavailabilities WHERE id=?').bind(u.id).run(); return c.json({ ok: true });
});

// --- Divers ------------------------------------------------------------------
// Route API inconnue → 404 JSON ; tout le reste → fichiers statiques (si jamais le Worker les reçoit).
app.notFound(c => c.req.path.startsWith('/api/') ? err(c, 'NOT_FOUND') : c.env.ASSETS.fetch(c.req.raw));
app.onError((e, c) => { console.error(e); return err(c, 'SERVER_ERROR'); });

export default app;
