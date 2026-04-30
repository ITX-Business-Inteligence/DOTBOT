-- ========================================================
-- Migration 004 — Soporte para sync de Samsara
-- ========================================================
-- Hoy las herramientas samsara_* hacen llamadas live a la API en cada
-- pregunta del agente. Esto agrega:
--   - driver_hos_cache: snapshot de HOS clocks por driver, refrescado
--     cada ~5 min por src/sync/hos.js. Permite "drivers near limit"
--     instantaneo sin tocar la API.
--   - sync_runs: tracking de cada corrida del scheduler (cuando, cuanto
--     tardo, cuantos records, exito/error). Visible en analytics.

CREATE TABLE IF NOT EXISTS driver_hos_cache (
  id INT AUTO_INCREMENT PRIMARY KEY,
  samsara_driver_id VARCHAR(64) NOT NULL UNIQUE,
  driver_name VARCHAR(255) NULL,
  clock_state VARCHAR(32) NULL,          -- driving, on_duty_not_driving, off_duty, sleeper_berth
  drive_used_min INT NULL,
  drive_remaining_min INT NULL,
  duty_used_min INT NULL,
  duty_remaining_min INT NULL,
  cycle_used_min INT NULL,
  cycle_remaining_min INT NULL,
  raw_clock_json JSON NULL,
  fetched_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  INDEX idx_remaining_drive (drive_remaining_min),
  INDEX idx_remaining_duty (duty_remaining_min),
  INDEX idx_clock_state (clock_state),
  INDEX idx_fetched (fetched_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS sync_runs (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  resource VARCHAR(64) NOT NULL,            -- 'drivers', 'vehicles', 'hos_clocks'
  started_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  finished_at DATETIME(6) NULL,
  status ENUM('running','success','error') NOT NULL DEFAULT 'running',
  records_synced INT NOT NULL DEFAULT 0,
  duration_ms INT NULL,
  error_message TEXT NULL,
  source ENUM('mock','live') NOT NULL DEFAULT 'live',
  INDEX idx_resource_started (resource, started_at),
  INDEX idx_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
