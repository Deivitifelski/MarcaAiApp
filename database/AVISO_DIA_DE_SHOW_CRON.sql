-- No dia do show, avisa a equipe do artista. Roda só no banco (pg_cron).
-- O app já lista a tabela notifications, então não precisa de atualização.
--
-- No Supabase: Database → Extensions → habilite pg_cron.
-- Depois rode este arquivo no SQL Editor.
-- Horário: 08:00 em Brasília (11:00 UTC).

CREATE EXTENSION IF NOT EXISTS pg_cron;

CREATE OR REPLACE FUNCTION public.avisar_dia_de_show()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_hoje DATE := public.feed_data_hoje_brasil();
  v_count INTEGER := 0;
BEGIN
  INSERT INTO public.notifications (
    to_user_id,
    from_user_id,
    artist_id,
    event_id,
    title,
    message,
    type,
    read,
    created_at
  )
  SELECT
    am.user_id,
    NULL,
    e.artist_id,
    e.id,
    'Hoje dia de show!',
    trim(both ' ·' FROM concat_ws(
      ' · ',
      COALESCE(NULLIF(trim(e.name), ''), 'Show'),
      CASE
        WHEN e.start_time IS NOT NULL THEN to_char(e.start_time, 'HH24:MI')
        ELSE NULL
      END,
      NULLIF(
        trim(both ' /' FROM concat_ws(
          '/',
          NULLIF(trim(COALESCE(e.city, '')), ''),
          NULLIF(upper(trim(COALESCE(e.state_uf, ''))), '')
        )),
        ''
      )
    )),
    'event',
    false,
    NOW()
  FROM public.events e
  INNER JOIN public.artist_members am ON am.artist_id = e.artist_id
  WHERE e.event_date = v_hoje
    AND COALESCE(e.ativo, true) = true
    AND e.feed_tipo IS NULL
    AND am.user_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM public.notifications n
      WHERE n.event_id = e.id
        AND n.to_user_id = am.user_id
        AND n.title = 'Hoje dia de show!'
        AND (n.created_at AT TIME ZONE 'America/Sao_Paulo')::date = v_hoje
    );

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

GRANT EXECUTE ON FUNCTION public.avisar_dia_de_show() TO service_role;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM cron.job WHERE jobname = 'avisar-dia-de-show'
  ) THEN
    PERFORM cron.unschedule('avisar-dia-de-show');
  END IF;
END;
$$;

SELECT cron.schedule(
  'avisar-dia-de-show',
  '0 11 * * *',
  $$SELECT public.avisar_dia_de_show();$$
);
