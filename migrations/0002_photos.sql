-- Piotr : photos des interventions (avant/après, justificatifs d'achat). Le fichier lui-même est dans le
-- bucket R2 « PHOTOS » (clé r2_key) ; D1 ne garde que les métadonnées. Une photo liée à un achat (expense_id)
-- reste attachée à l'intervention si l'achat est supprimé (ON DELETE SET NULL).
CREATE TABLE IF NOT EXISTS photos (
  id INTEGER PRIMARY KEY,
  booking_id INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  expense_id INTEGER REFERENCES expenses(id) ON DELETE SET NULL,
  r2_key TEXT NOT NULL UNIQUE, filename TEXT NOT NULL, content_type TEXT NOT NULL, size INTEGER NOT NULL,
  caption TEXT NOT NULL DEFAULT '', uploaded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP);

CREATE INDEX IF NOT EXISTS idx_photos_booking ON photos(booking_id);
CREATE INDEX IF NOT EXISTS idx_photos_expense ON photos(expense_id);
