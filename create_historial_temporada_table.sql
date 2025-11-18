-- Tabla para el historial de cambios de temporadas
-- Esta tabla registra todos los cambios realizados en las temporadas y sus tarifas

CREATE TABLE IF NOT EXISTS historial_temporada (
  id INT AUTO_INCREMENT PRIMARY KEY,
  temporada_id INT NOT NULL,
  usuario_id INT NOT NULL,
  operacion ENUM('CREATE', 'UPDATE', 'DELETE') NOT NULL,
  campo_afectado VARCHAR(255) NOT NULL,
  valor_anterior TEXT NULL,
  valor_nuevo TEXT NULL,
  fecha_cambio DATETIME NOT NULL,
  INDEX idx_temporada_id (temporada_id),
  INDEX idx_usuario_id (usuario_id),
  INDEX idx_fecha_cambio (fecha_cambio),
  CONSTRAINT fk_historial_temporada_temporada
    FOREIGN KEY (temporada_id)
    REFERENCES temporada_tarifa(id)
    ON DELETE CASCADE,
  CONSTRAINT fk_historial_temporada_usuario
    FOREIGN KEY (usuario_id)
    REFERENCES usuario(id)
    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Descripción de los campos:
-- id: Identificador único del registro de historial
-- temporada_id: ID de la temporada afectada
-- usuario_id: ID del usuario que realizó el cambio
-- operacion: Tipo de operación realizada (CREATE, UPDATE, DELETE)
-- campo_afectado: Nombre del campo o entidad afectada (ej: 'temporada', 'tarifa_123', 'tarifas')
-- valor_anterior: Valor anterior en formato JSON (NULL para CREATE)
-- valor_nuevo: Valor nuevo en formato JSON (NULL para DELETE)
-- fecha_cambio: Fecha y hora en que se realizó el cambio
