-- ========================================================
-- Migration 003 — Adjuntos (imagenes) en mensajes del chat
-- ========================================================
-- Permite que los usuarios suban screenshots (de Samsara, FMCSA SMS, etc.)
-- al chat. Las imagenes se mandan a Claude Sonnet 4.6 (multimodal) como
-- parte del content del mensaje user.
--
-- Almacenamiento por defecto: BLOB en DB (transactional, backups incluidos
-- automaticamente). Si la DB crece mucho, se puede migrar a disk/s3 sin
-- cambiar el schema — solo cambiar el handler.

CREATE TABLE IF NOT EXISTS message_attachments (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  message_id BIGINT NOT NULL,
  conversation_id BIGINT NOT NULL,
  user_id INT NOT NULL,
  mime_type VARCHAR(64) NOT NULL,
  byte_size INT NOT NULL,
  sha256 CHAR(64) NOT NULL,
  storage_kind ENUM('db','disk','s3') NOT NULL DEFAULT 'db',
  content_blob MEDIUMBLOB NULL,        -- relleno si storage_kind='db'
  storage_path VARCHAR(512) NULL,      -- relleno si storage_kind='disk'/'s3'
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id),
  INDEX idx_conv_created (conversation_id, created_at),
  INDEX idx_sha (sha256)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
