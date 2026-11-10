-- Piotr : schéma initial (identique à l'ancien server.js). D1 applique les clés étrangères par défaut.
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

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_bookings_client ON bookings(client_id);
CREATE INDEX IF NOT EXISTS idx_bookings_period ON bookings(start, end);
CREATE INDEX IF NOT EXISTS idx_work_booking ON work_entries(booking_id);
CREATE INDEX IF NOT EXISTS idx_expenses_booking ON expenses(booking_id);
