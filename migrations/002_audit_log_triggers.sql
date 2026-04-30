-- ========================================================
-- Migration 002 — Triggers append-only sobre audit_log
-- ========================================================
-- Capa 1 de la defensa tamper-evidence: aborta UPDATE / DELETE.
-- La capa 2 (revoke de permisos al usuario de la app) se aplica fuera
-- del schema, ver docs/DEPLOY.md. La capa 3 (hash chain) la maneja
-- src/db/audit-chain.js en el codigo.
--
-- Nota: estos triggers se pueden re-aplicar sin riesgo (drop + create).

DROP TRIGGER IF EXISTS audit_log_no_update;

CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log
FOR EACH ROW
SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'audit_log es append-only; UPDATE bloqueado';

DROP TRIGGER IF EXISTS audit_log_no_delete;

CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log
FOR EACH ROW
SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'audit_log es append-only; DELETE bloqueado';
