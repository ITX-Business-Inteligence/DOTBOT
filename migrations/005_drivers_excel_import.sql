-- ========================================================
-- Migration 005 — Soporte para import del Excel de compliance
-- ========================================================
-- Hoy `drivers` se popula via Samsara sync (samsara_id NOT NULL).
-- El Excel de compliance no tiene samsara_id, asi que:
--   - samsara_id pasa a NULLABLE
--   - cdl_number es la nueva llave de identidad principal (UNIQUE)
--   - cdl_state se amplia a VARCHAR(16) para soportar "Mexico", "Tx", etc.
--   - se agregan columnas de info no-Samsara (phone, hire_date, etc.)
--   - data_source rastrea quien actualizo cada fila por ultima vez
--
-- driver_import_discrepancies guarda los gaps entre Excel y Samsara
-- (drivers en uno pero no en el otro) — input para que compliance limpie
-- la data.

ALTER TABLE drivers
  MODIFY COLUMN samsara_id VARCHAR(64) NULL,
  MODIFY COLUMN cdl_state  VARCHAR(16) NULL,
  ADD COLUMN phone        VARCHAR(32) NULL  AFTER endorsements,
  ADD COLUMN hire_date    DATE NULL          AFTER phone,
  ADD COLUMN company      VARCHAR(64) NULL   AFTER hire_date,
  ADD COLUMN location     VARCHAR(64) NULL   AFTER company,
  ADD COLUMN division     VARCHAR(64) NULL   AFTER location,
  ADD COLUMN data_source  ENUM('samsara','excel','manual','samsara+excel') NOT NULL DEFAULT 'samsara' AFTER division,
  ADD UNIQUE KEY uniq_cdl_number (cdl_number);

-- Tabla de discrepancias entre Excel y Samsara — cada vez que importamos
-- el Excel, los rows que NO matchean con drivers existentes (que vienen
-- de Samsara) quedan acá para revisión.
CREATE TABLE IF NOT EXISTS driver_import_discrepancies (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  source        ENUM('excel_only','samsara_only') NOT NULL,
  full_name     VARCHAR(255) NULL,
  cdl_number    VARCHAR(64) NULL,
  raw_row_json  JSON NULL,
  reason        TEXT NULL,
  detected_at   DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  import_batch  VARCHAR(64) NULL,
  resolved_at   DATETIME NULL,
  resolved_by_user_id INT NULL,
  resolution_note TEXT NULL,
  INDEX idx_source_resolved (source, resolved_at),
  INDEX idx_cdl (cdl_number),
  INDEX idx_batch (import_batch),
  FOREIGN KEY (resolved_by_user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
