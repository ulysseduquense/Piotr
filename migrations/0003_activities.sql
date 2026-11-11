-- Piotr : activités (multi-prestataires). Une activité appartient à un prestataire (owner) ; ses clients la rejoignent
-- par un lien d'invitation (invite_code). Calendrier, indisponibilités, réservations et tarif sont rattachés à une activité.
--
-- Migration des données : chaque utilisateur « admin » reçoit une activité à son nom (tarif = réglage default_rate, sinon 25) ;
-- tous les autres utilisateurs (un éventuel second admin compris, qui garde ainsi la vue sur ses propres réservations) deviennent
-- clients de l'activité du premier admin, qui reçoit aussi toutes les réservations et indisponibilités existantes. La table settings et la colonne users.role disparaissent une fois exploitées.
--
-- Reconstruction de bookings et unavailabilities (SQLite n'ajoute pas de colonne NOT NULL + clé étrangère par ALTER TABLE).
-- D1 applique les clés étrangères et exécute la migration dans une transaction, où « PRAGMA foreign_keys=OFF » est sans
-- effet : un DROP TABLE bookings y fait un DELETE implicite qui, par ON DELETE CASCADE, viderait work_entries, expenses et
-- photos (vérifié ; PRAGMA defer_foreign_keys n'y change rien). Les tables filles sont donc copiées dans des tables de
-- transit, supprimées, puis recréées à l'identique une fois bookings reconstruite. Tous les ids sont conservés.
-- Pas de BEGIN/COMMIT (refusés par D1) : chaque étape reste cohérente même exécutée hors transaction.

-- 1. Nouvelles tables
CREATE TABLE IF NOT EXISTS activities (
  id INTEGER PRIMARY KEY, owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL, invite_code TEXT NOT NULL UNIQUE, default_rate REAL NOT NULL DEFAULT 25,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS memberships (
  activity_id INTEGER NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK(role IN ('owner','client')), joined_at TEXT DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(activity_id, user_id));
CREATE INDEX IF NOT EXISTS idx_memberships_user ON memberships(user_id);

-- 2. Une activité par admin (aucun admin → rien), code d'invitation de 20 caractères hexadécimaux, puis les adhésions :
--    l'admin est prestataire de son activité, tous les autres utilisateurs (autres admins compris) sont clients de l'activité du premier admin.
INSERT INTO activities(owner_id, name, invite_code, default_rate)
  SELECT u.id, u.name, lower(hex(randomblob(10))),
    COALESCE((SELECT CAST(value AS REAL) FROM settings WHERE key='default_rate'), 25)
  FROM users u WHERE u.role='admin' AND NOT EXISTS (SELECT 1 FROM activities a WHERE a.owner_id=u.id)
  ORDER BY u.id;
INSERT OR IGNORE INTO memberships(activity_id, user_id, role) SELECT id, owner_id, 'owner' FROM activities;
INSERT OR IGNORE INTO memberships(activity_id, user_id, role)
  SELECT (SELECT id FROM activities WHERE owner_id=(SELECT MIN(id) FROM users WHERE role='admin')), u.id, 'client'
  FROM users u WHERE u.id<>(SELECT MIN(id) FROM users WHERE role='admin') AND EXISTS (SELECT 1 FROM users WHERE role='admin');

-- 3. Tables filles de bookings mises en transit (sans contraintes), puis supprimées : photos d'abord, sinon DROP TABLE
--    expenses mettrait photos.expense_id à NULL (ON DELETE SET NULL).
CREATE TABLE _mig_work (id INTEGER, booking_id INTEGER, date TEXT, hours REAL, note TEXT);
CREATE TABLE _mig_expenses (id INTEGER, booking_id INTEGER, label TEXT, amount REAL);
CREATE TABLE _mig_photos (id INTEGER, booking_id INTEGER, expense_id INTEGER, r2_key TEXT, filename TEXT, content_type TEXT,
  size INTEGER, caption TEXT, uploaded_by INTEGER, created_at TEXT);
INSERT INTO _mig_work(id,booking_id,date,hours,note) SELECT id,booking_id,date,hours,note FROM work_entries;
INSERT INTO _mig_expenses(id,booking_id,label,amount) SELECT id,booking_id,label,amount FROM expenses;
INSERT INTO _mig_photos(id,booking_id,expense_id,r2_key,filename,content_type,size,caption,uploaded_by,created_at)
  SELECT id,booking_id,expense_id,r2_key,filename,content_type,size,caption,uploaded_by,created_at FROM photos;
DROP TABLE photos;
DROP TABLE expenses;
DROP TABLE work_entries;

-- 4. bookings reconstruite avec activity_id (ids conservés ; toutes les réservations vont à l'activité du premier admin)
CREATE TABLE bookings_new (
  id INTEGER PRIMARY KEY, activity_id INTEGER NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
  client_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  start TEXT NOT NULL, end TEXT NOT NULL, description TEXT DEFAULT '', address TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending', hourly_rate REAL, admin_note TEXT DEFAULT '',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP);
INSERT INTO bookings_new(id,activity_id,client_id,start,end,description,address,status,hourly_rate,admin_note,created_at)
  SELECT id, (SELECT id FROM activities WHERE owner_id=(SELECT MIN(id) FROM users WHERE role='admin')),
    client_id,start,end,description,address,status,hourly_rate,admin_note,created_at FROM bookings;
DROP TABLE bookings;
ALTER TABLE bookings_new RENAME TO bookings;
CREATE INDEX IF NOT EXISTS idx_bookings_client ON bookings(client_id);
CREATE INDEX IF NOT EXISTS idx_bookings_period ON bookings(activity_id, start, end);

-- 5. Tables filles recréées (mêmes définitions que 0001/0002) et remplies depuis le transit
CREATE TABLE work_entries (
  id INTEGER PRIMARY KEY, booking_id INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  date TEXT NOT NULL, hours REAL NOT NULL, note TEXT DEFAULT '');
CREATE TABLE expenses (
  id INTEGER PRIMARY KEY, booking_id INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  label TEXT NOT NULL, amount REAL NOT NULL);
CREATE TABLE photos (
  id INTEGER PRIMARY KEY,
  booking_id INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  expense_id INTEGER REFERENCES expenses(id) ON DELETE SET NULL,
  r2_key TEXT NOT NULL UNIQUE, filename TEXT NOT NULL, content_type TEXT NOT NULL, size INTEGER NOT NULL,
  caption TEXT NOT NULL DEFAULT '', uploaded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP);
INSERT INTO work_entries(id,booking_id,date,hours,note) SELECT id,booking_id,date,hours,note FROM _mig_work;
INSERT INTO expenses(id,booking_id,label,amount) SELECT id,booking_id,label,amount FROM _mig_expenses;
INSERT INTO photos(id,booking_id,expense_id,r2_key,filename,content_type,size,caption,uploaded_by,created_at)
  SELECT id,booking_id,expense_id,r2_key,filename,content_type,size,caption,uploaded_by,created_at FROM _mig_photos;
DROP TABLE _mig_work;
DROP TABLE _mig_expenses;
DROP TABLE _mig_photos;
CREATE INDEX IF NOT EXISTS idx_work_booking ON work_entries(booking_id);
CREATE INDEX IF NOT EXISTS idx_expenses_booking ON expenses(booking_id);
CREATE INDEX IF NOT EXISTS idx_photos_booking ON photos(booking_id);
CREATE INDEX IF NOT EXISTS idx_photos_expense ON photos(expense_id);

-- 6. unavailabilities reconstruite avec activity_id (aucune table fille)
CREATE TABLE unavailabilities_new (
  id INTEGER PRIMARY KEY, activity_id INTEGER NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
  start TEXT NOT NULL, end TEXT NOT NULL, note TEXT DEFAULT '');
INSERT INTO unavailabilities_new(id,activity_id,start,end,note)
  SELECT id, (SELECT id FROM activities WHERE owner_id=(SELECT MIN(id) FROM users WHERE role='admin')), start,end,note
  FROM unavailabilities;
DROP TABLE unavailabilities;
ALTER TABLE unavailabilities_new RENAME TO unavailabilities;
CREATE INDEX IF NOT EXISTS idx_unav_period ON unavailabilities(activity_id, start, end);

-- 7. Reliquats de l'ancien modèle (après usage de users.role ci-dessus)
DROP TABLE IF EXISTS settings;
ALTER TABLE users DROP COLUMN role;
