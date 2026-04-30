-- ========================================================
-- Migration 006 — Escalaciones a compliance
-- ========================================================
-- Cuando el bot encuentra un caso operacional que NO puede resolver con
-- data + CFR sólido, llama `escalate_to_compliance`. Esa tool inserta
-- aquí, audit-trackea, y dispara email al equipo de compliance.

CREATE TABLE IF NOT EXISTS escalations (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,                       -- quien hizo la pregunta
  conversation_id BIGINT NULL,                 -- contexto del chat
  trigger_message TEXT NOT NULL,               -- pregunta original
  bot_reasoning TEXT NULL,                     -- por que el bot escalo
  category ENUM(
    'missing_data',
    'ambiguous_compliance',
    'user_requested',
    'complex_decision',
    'potential_violation',
    'other'
  ) NOT NULL DEFAULT 'other',
  urgency ENUM('low','medium','high','critical') NOT NULL DEFAULT 'medium',
  status  ENUM('pending','assigned','in_progress','resolved') NOT NULL DEFAULT 'pending',
  assigned_to_user_id INT NULL,
  resolution_notes TEXT NULL,
  resolved_at DATETIME NULL,
  resolved_by_user_id INT NULL,
  email_sent_at DATETIME NULL,
  email_recipients TEXT NULL,                  -- mails a quien se intento enviar
  email_error TEXT NULL,                       -- si fallo, el motivo
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (assigned_to_user_id) REFERENCES users(id),
  FOREIGN KEY (resolved_by_user_id) REFERENCES users(id),
  INDEX idx_status_urgency (status, urgency, created_at),
  INDEX idx_user_date (user_id, created_at),
  INDEX idx_assigned (assigned_to_user_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
