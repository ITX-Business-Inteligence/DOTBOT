-- ========================================================
-- BOTDOT - Schema inicial
-- Migration 001 — primera version del schema completo.
-- ========================================================
-- IMPORTANTE: las migrations son INMUTABLES. Nunca edites un archivo
-- ya aplicado en algun ambiente — el runner detecta el cambio de
-- checksum y aborta. Para cambios al schema crea una nueva migration
-- con un numero mayor.

SET NAMES utf8mb4;
SET time_zone = '+00:00';

-- Usuarios del sistema (dispatchers, supervisores, compliance, manager)
CREATE TABLE IF NOT EXISTS users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  email VARCHAR(255) NOT NULL UNIQUE,
  full_name VARCHAR(255) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  role ENUM('dispatcher','supervisor','compliance','manager','admin') NOT NULL,
  active TINYINT(1) NOT NULL DEFAULT 1,
  last_login_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Drivers (sincronizado periodicamente desde Samsara)
CREATE TABLE IF NOT EXISTS drivers (
  id INT AUTO_INCREMENT PRIMARY KEY,
  samsara_id VARCHAR(64) NOT NULL UNIQUE,
  full_name VARCHAR(255) NOT NULL,
  cdl_number VARCHAR(64) NULL,
  cdl_state CHAR(2) NULL,
  cdl_expiration DATE NULL,
  medical_card_expiration DATE NULL,
  endorsements VARCHAR(64) NULL,
  active TINYINT(1) NOT NULL DEFAULT 1,
  notes TEXT NULL,
  last_synced_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_active (active),
  INDEX idx_name (full_name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Vehiculos / unidades (sincronizado desde Samsara)
CREATE TABLE IF NOT EXISTS vehicles (
  id INT AUTO_INCREMENT PRIMARY KEY,
  samsara_id VARCHAR(64) NOT NULL UNIQUE,
  vin VARCHAR(32) NOT NULL,
  unit_number VARCHAR(32) NULL,
  type VARCHAR(64) NULL,
  make VARCHAR(64) NULL,
  model VARCHAR(64) NULL,
  year INT NULL,
  license_plate VARCHAR(32) NULL,
  license_state CHAR(2) NULL,
  annual_inspection_date DATE NULL,
  oos_status TINYINT(1) NOT NULL DEFAULT 0,
  active TINYINT(1) NOT NULL DEFAULT 1,
  last_synced_at DATETIME NULL,
  INDEX idx_vin (vin),
  INDEX idx_active (active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Conversaciones del agente (cada chat session)
CREATE TABLE IF NOT EXISTS conversations (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  title VARCHAR(255) NULL,
  started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_activity_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  message_count INT NOT NULL DEFAULT 0,
  FOREIGN KEY (user_id) REFERENCES users(id),
  INDEX idx_user_activity (user_id, last_activity_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Mensajes individuales del agente (cada turn user/assistant + tool calls)
CREATE TABLE IF NOT EXISTS messages (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  conversation_id BIGINT NOT NULL,
  role ENUM('user','assistant','tool_use','tool_result','system') NOT NULL,
  content_json JSON NOT NULL,
  tokens_input INT NULL,
  tokens_output INT NULL,
  tokens_cache_read INT NULL,
  tokens_cache_create INT NULL,
  latency_ms INT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
  INDEX idx_conv_created (conversation_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Audit log tamper-evident de decisiones de compliance/dispatch.
-- Defensas en capas:
--   (1) Triggers BEFORE UPDATE / BEFORE DELETE — ver migration 002.
--   (2) Usuario MySQL de la app SIN permiso UPDATE/DELETE sobre esta tabla
--       (instrucciones en docs/DEPLOY.md).
--   (3) Hash chain: SHA-256(prev_hash || canonical(fila)). Ver
--       src/db/audit-chain.js y scripts/verify-audit-chain.js.
CREATE TABLE IF NOT EXISTS audit_log (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  conversation_id BIGINT NULL,
  action_type VARCHAR(64) NOT NULL,
  subject_type VARCHAR(64) NULL,
  subject_id VARCHAR(64) NULL,
  decision ENUM('proceed','conditional','decline','override','informational') NULL,
  cfr_cited TEXT NULL,
  reasoning TEXT NULL,
  evidence_json JSON NULL,
  override_reason TEXT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  prev_hash CHAR(64) NOT NULL,
  row_hash  CHAR(64) NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id),
  INDEX idx_user_date (user_id, created_at),
  INDEX idx_action (action_type, created_at),
  INDEX idx_subject (subject_type, subject_id),
  INDEX idx_prev_hash (prev_hash),
  UNIQUE KEY uniq_row_hash (row_hash)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Snapshots de SMS / BASICs (historial de percentiles)
CREATE TABLE IF NOT EXISTS sms_snapshots (
  id INT AUTO_INCREMENT PRIMARY KEY,
  snapshot_date DATE NOT NULL,
  basic_name VARCHAR(64) NOT NULL,
  measure DECIMAL(8,3) NULL,
  score_pct INT NULL,
  threshold_pct INT NULL,
  alert TINYINT(1) NOT NULL DEFAULT 0,
  months_in_alert INT NULL,
  violations_count INT NULL,
  oos_count INT NULL,
  source_file VARCHAR(255) NULL,
  imported_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_date_basic (snapshot_date, basic_name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Violaciones individuales del SMS (de los downloads xlsx)
CREATE TABLE IF NOT EXISTS sms_violations (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  snapshot_date DATE NOT NULL,
  basic_name VARCHAR(64) NOT NULL,
  violation_code VARCHAR(64) NOT NULL,
  violation_group VARCHAR(255) NULL,
  description TEXT NULL,
  count INT NOT NULL DEFAULT 0,
  oos_count INT NOT NULL DEFAULT 0,
  severity_weight INT NULL,
  total_points INT GENERATED ALWAYS AS (count * IFNULL(severity_weight, 0)) STORED,
  imported_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_snapshot_basic (snapshot_date, basic_name),
  INDEX idx_code (violation_code),
  INDEX idx_points (total_points DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Inspecciones de roadside (del xlsx SMS)
CREATE TABLE IF NOT EXISTS sms_inspections (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  inspection_number VARCHAR(64) NOT NULL,
  inspection_date DATE NOT NULL,
  state CHAR(2) NULL,
  level INT NULL,
  has_violation TINYINT(1) NOT NULL DEFAULT 0,
  has_oos TINYINT(1) NOT NULL DEFAULT 0,
  driver_name VARCHAR(255) NULL,
  vehicle_vin VARCHAR(32) NULL,
  imported_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_inspection (inspection_number),
  INDEX idx_date (inspection_date),
  INDEX idx_state_oos (state, has_oos),
  INDEX idx_driver (driver_name),
  INDEX idx_vin (vehicle_vin)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Crashes (del xlsx SMS)
CREATE TABLE IF NOT EXISTS sms_crashes (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  crash_number VARCHAR(64) NOT NULL UNIQUE,
  crash_date DATE NOT NULL,
  state CHAR(2) NULL,
  fatalities INT NOT NULL DEFAULT 0,
  injuries INT NOT NULL DEFAULT 0,
  tow_away TINYINT(1) NOT NULL DEFAULT 0,
  hm_released TINYINT(1) NOT NULL DEFAULT 0,
  not_preventable TINYINT(1) NULL,
  severity_weight INT NULL,
  time_weight INT NULL,
  dataqs_disputed TINYINT(1) NOT NULL DEFAULT 0,
  dataqs_disputed_at DATETIME NULL,
  vehicle_vin VARCHAR(32) NULL,
  driver_license VARCHAR(64) NULL,
  imported_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_date (crash_date),
  INDEX idx_state (state),
  INDEX idx_dataqs (dataqs_disputed, not_preventable)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Decisiones de asignacion (cuando dispatcher consulta al bot)
CREATE TABLE IF NOT EXISTS assignment_decisions (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  conversation_id BIGINT NULL,
  driver_id INT NULL,
  vehicle_id INT NULL,
  load_reference VARCHAR(64) NULL,
  origin VARCHAR(255) NULL,
  destination VARCHAR(255) NULL,
  pickup_time DATETIME NULL,
  delivery_time DATETIME NULL,
  estimated_drive_minutes INT NULL,
  bot_recommendation ENUM('proceed','conditional','decline') NOT NULL,
  bot_reasoning TEXT NULL,
  cfr_cited TEXT NULL,
  hos_snapshot_json JSON NULL,
  final_decision ENUM('accepted','rejected','overridden') NULL,
  override_reason TEXT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (driver_id) REFERENCES drivers(id),
  FOREIGN KEY (vehicle_id) REFERENCES vehicles(id),
  INDEX idx_user_date (user_id, created_at),
  INDEX idx_recommendation (bot_recommendation, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
