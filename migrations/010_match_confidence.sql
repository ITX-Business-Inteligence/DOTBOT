-- ========================================================
-- Migration 010 — match_confidence en drivers
-- ========================================================
-- Razon: el matching Excel ↔ Samsara puede caer en falsos positivos cuando
-- los CDLs no estan en ambos lados y el algoritmo cae a fuzzy name match.
-- Caso real detectado: 'Robert L Sanchez' (Excel terminated) hizo fuzzy
-- match con 'Roberto Sanchez' (Samsara mock) por distancia Levenshtein 2.
-- Eran personas distintas pero el nombre es char-similar.
--
-- Solucion: cada driver registra la confianza con la que se hizo su ultima
-- vinculacion entre Samsara y Excel:
--   high   — match por CDL exacto (signal mas fuerte)
--   low    — match por fuzzy name (revisar antes de tratar como definitivo)
--   manual — admin/compliance lo edito a mano (confirma la vinculacion)
--   NULL   — sin match aun (drivers nuevos de Samsara puro o Excel puro)
--
-- La UI muestra badge de warning cuando confidence='low'.
-- Compliance debe revisar y confirmar (PATCH driver) → confidence='manual'.

ALTER TABLE drivers
  ADD COLUMN match_confidence VARCHAR(16) NULL
  COMMENT 'high (CDL exact), low (fuzzy name), manual (admin confirmed), NULL (no match)';

-- Backfill: drivers existentes con data_source 'samsara+excel' no sabemos
-- como matchearon (CDL o name) — los marcamos 'low' para forzar review.
-- Drivers con data_source 'samsara' o 'excel' o 'manual' no tienen match
-- entre fuentes — quedan NULL.
UPDATE drivers
  SET match_confidence = 'low'
  WHERE data_source = 'samsara+excel';
