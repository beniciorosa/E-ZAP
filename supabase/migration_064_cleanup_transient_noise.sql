-- Migration 064: cleanup seletivo de eventos ruidosos (transient_drop + reconnected)
--
-- Contexto: session:transient_drop + session:reconnected disparam em pares,
-- frequentemente multiplos por hora por sessao (keep-alive/ping), resultando
-- em ~280 events/hora em produção com 20+ sessões ativas. Em 30d isso seria
-- ~6M rows de baixa relevancia.
--
-- Decisao: retencao destes 2 event_types vira 48h (suficiente pra debug).
-- Os demais event_types (group_create, dm, welcome, wa:stream_error,
-- iq:snapshot, etc) continuam com retencao ETERNA — sao valiosos pra
-- auditoria, calibracao empirica e futura analise.
--
-- Uso: cron do whatsapp-server chama esta RPC a cada 6h (ver src/index.js).
-- Tambem pode ser invocada manualmente:
--   POST https://xsqpqdjffjqxdcmoytfc.supabase.co/rest/v1/rpc/cleanup_transient_events
--   body: {"keep_hours": 48}

CREATE OR REPLACE FUNCTION cleanup_transient_events(keep_hours int DEFAULT 48)
RETURNS int LANGUAGE plpgsql AS $$
DECLARE
  deleted_count int := 0;
  batch_count int;
BEGIN
  LOOP
    DELETE FROM activity_events
    WHERE id IN (
      SELECT id FROM activity_events
      WHERE event_type IN ('session:transient_drop', 'session:reconnected')
        AND occurred_at < now() - (keep_hours || ' hours')::interval
      LIMIT 1000
    );
    GET DIAGNOSTICS batch_count = ROW_COUNT;
    deleted_count := deleted_count + batch_count;
    EXIT WHEN batch_count = 0;
  END LOOP;
  RETURN deleted_count;
END;
$$;

COMMENT ON FUNCTION cleanup_transient_events(int) IS
  'Apaga session:transient_drop e session:reconnected com mais de keep_hours horas. Batches de 1000. Outros event_types intactos.';
