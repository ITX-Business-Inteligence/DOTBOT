-- ========================================================
-- Migration 009 — Versionado del CFR para auto-update con diff
-- ========================================================
-- cfr_versions guarda historico completo de cada seccion.
--   - is_current=1: version vigente (la que el bot cita)
--   - is_current=0: version superseded (historica, para audit trail)
-- UNIQUE(section, content_hash) garantiza que NUNCA insertamos el mismo
-- contenido dos veces, incluso si el cron corre 100 veces.
--
-- cfr_fetch_runs trackea cada corrida: que se bajo, que cambio.

CREATE TABLE IF NOT EXISTS cfr_versions (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  section       VARCHAR(32) NOT NULL,
  part          INT NOT NULL,
  title         TEXT NOT NULL,
  text          MEDIUMTEXT NOT NULL,
  keywords_json JSON NULL,
  content_hash  CHAR(64) NOT NULL,
  issue_date    DATE NOT NULL,
  fetched_at    DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  is_current    TINYINT(1) NOT NULL DEFAULT 1,
  superseded_at DATETIME(6) NULL,
  UNIQUE KEY uniq_section_hash (section, content_hash),
  INDEX idx_current (is_current, section),
  INDEX idx_part (part),
  INDEX idx_section (section, fetched_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS cfr_fetch_runs (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  started_at        DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  finished_at       DATETIME(6) NULL,
  issue_date        DATE NULL,
  status            ENUM('running','success','error','noop') NOT NULL DEFAULT 'running',
  trigger_source    ENUM('cron','manual','baseline') NOT NULL DEFAULT 'cron',
  parts_fetched     INT NOT NULL DEFAULT 0,
  sections_total    INT NOT NULL DEFAULT 0,
  sections_added    INT NOT NULL DEFAULT 0,
  sections_changed  INT NOT NULL DEFAULT 0,
  sections_unchanged INT NOT NULL DEFAULT 0,
  duration_ms       INT NULL,
  error_message     TEXT NULL,
  email_sent_at     DATETIME NULL,
  INDEX idx_status (status, started_at),
  INDEX idx_started (started_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
