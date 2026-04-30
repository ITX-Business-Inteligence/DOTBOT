-- ========================================================
-- Migration 008 — Notifications proactivas
-- ========================================================
-- Cron diario (6 AM) escanea drivers y emite notificaciones cuando un CDL
-- o medical card cruza thresholds 60d / 30d / 14d / 7d / expirado.
--
-- UNIQUE(kind, subject_id, threshold) evita re-notificar en runs sucesivos
-- cuando un driver permanece en el mismo bucket (ej. 60d → 59d → 58d todos
-- van al mismo bucket "60d", solo el primero genera notificacion).

CREATE TABLE IF NOT EXISTS notifications (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  kind ENUM(
    'cdl_expiring',           -- CDL vence dentro del horizon
    'medical_expiring',        -- medical card vence dentro del horizon
    'cdl_expired',             -- CDL ya vencio
    'medical_expired'          -- medical ya vencio
  ) NOT NULL,
  subject_type VARCHAR(32) NOT NULL DEFAULT 'driver',
  subject_id   INT NOT NULL,                       -- driver_id
  threshold    INT NOT NULL,                       -- 60, 30, 14, 7, 0 (expired today), -1 (overdue)
  urgency      ENUM('low','medium','high','critical') NOT NULL,
  title        VARCHAR(255) NOT NULL,
  body         TEXT NULL,
  status       ENUM('active','dismissed','resolved') NOT NULL DEFAULT 'active',
  email_sent_at      DATETIME NULL,
  email_recipients   TEXT NULL,
  email_error        TEXT NULL,
  dismissed_at       DATETIME NULL,
  dismissed_by_user_id INT NULL,
  dismissal_note     TEXT NULL,
  created_at   DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  UNIQUE KEY uniq_kind_subject_threshold (kind, subject_id, threshold),
  INDEX idx_status_urgency (status, urgency, created_at),
  INDEX idx_subject (subject_type, subject_id),
  FOREIGN KEY (dismissed_by_user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
