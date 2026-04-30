-- ========================================================
-- Migration 007 — Login security: lockout + force-change-password
-- ========================================================
-- Politica:
--   - 10 intentos fallidos consecutivos → cuenta bloqueada (locked_at)
--   - Solo admin desbloquea (UI en /users.html)
--   - Despues de un reset de password por admin, el usuario es FORZADO
--     a cambiar la password en su proximo login (must_change_password=1)
--   - Despues de un login exitoso, failed_login_count se resetea a 0

ALTER TABLE users
  ADD COLUMN failed_login_count   INT NOT NULL DEFAULT 0,
  ADD COLUMN last_failed_login_at DATETIME NULL,
  ADD COLUMN locked_at            DATETIME NULL,
  ADD COLUMN must_change_password TINYINT(1) NOT NULL DEFAULT 0,
  ADD INDEX idx_locked (locked_at);
