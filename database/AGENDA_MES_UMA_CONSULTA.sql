-- Agenda do mês numa chamada só.
-- O token do usuário já identifica quem pergunta (auth.uid()).
-- Devolve o papel e os eventos do intervalo, com cachê oculto para quem não pode ver.
-- Não altera a consulta antiga. Pode rodar de novo.
-- Execute no SQL Editor do Supabase.

CREATE INDEX IF NOT EXISTS idx_artist_members_user_artist
  ON public.artist_members (user_id, artist_id);

CREATE INDEX IF NOT EXISTS idx_events_agenda_mes
  ON public.events (artist_id, event_date, start_time)
  WHERE ativo IS TRUE AND feed_tipo IS NULL;

CREATE INDEX IF NOT EXISTS idx_convite_part_origem_agenda
  ON public.convite_participacao_evento (evento_origem_id, criado_em)
  WHERE status IN ('pendente', 'aceito');

CREATE OR REPLACE FUNCTION public.rpc_app_agenda_mes(
  p_artista_id uuid,
  p_inicio date,
  p_fim date
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_role text;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Usuário não autenticado';
  END IF;

  IF p_artista_id IS NULL OR p_inicio IS NULL OR p_fim IS NULL OR p_fim < p_inicio THEN
    RAISE EXCEPTION 'Período da agenda inválido';
  END IF;

  SELECT am.role
  INTO v_role
  FROM public.artist_members am
  WHERE am.user_id = v_uid
    AND am.artist_id = p_artista_id
  LIMIT 1;

  IF v_role IS NULL THEN
    RAISE EXCEPTION 'Usuário não tem acesso a este artista';
  END IF;

  RETURN (
    WITH mes AS (
      SELECT e.*
      FROM public.events e
      WHERE e.artist_id = p_artista_id
        AND e.ativo IS TRUE
        AND e.feed_tipo IS NULL
        AND e.event_date >= p_inicio
        AND e.event_date <= p_fim
    ),
    marcacao AS (
      SELECT
        e.id,
        e.artist_id,
        e.convite_participacao_id,
        c.evento_origem_id,
        c.artista_que_convidou_id,
        NULLIF(trim(COALESCE(c.ciclo_status, '')), '') AS ciclo_status,
        (
          e.convite_participacao_id IS NOT NULL
          AND NOT (
            c.id IS NOT NULL
            AND e.id = c.evento_origem_id
            AND e.artist_id = c.artista_que_convidou_id
          )
        ) AS eh_copia
      FROM mes e
      LEFT JOIN public.convite_participacao_evento c
        ON c.id = e.convite_participacao_id
    ),
    origens AS (
      SELECT m.id AS origem_id
      FROM marcacao m
      WHERE m.artist_id = p_artista_id
        AND NOT m.eh_copia
      UNION
      SELECT m.evento_origem_id
      FROM marcacao m
      WHERE m.eh_copia
        AND m.evento_origem_id IS NOT NULL
    ),
    convites AS (
      SELECT
        c.evento_origem_id,
        c.artista_que_convidou_id,
        c.artista_convidado_id,
        c.criado_em,
        c.status
      FROM public.convite_participacao_evento c
      WHERE c.evento_origem_id IN (SELECT o.origem_id FROM origens o)
        AND c.status IN ('pendente', 'aceito')
    ),
    hosts AS (
      SELECT DISTINCT ON (c.evento_origem_id)
        c.evento_origem_id,
        c.artista_que_convidou_id AS artist_id
      FROM convites c
      WHERE c.artista_que_convidou_id IS NOT NULL
      ORDER BY c.evento_origem_id, c.criado_em ASC
    ),
    guests AS (
      SELECT DISTINCT ON (c.evento_origem_id, c.artista_convidado_id)
        c.evento_origem_id,
        c.artista_convidado_id AS artist_id,
        c.criado_em
      FROM convites c
      WHERE c.status = 'aceito'
        AND c.artista_convidado_id IS NOT NULL
      ORDER BY c.evento_origem_id, c.artista_convidado_id, c.criado_em ASC
    ),
    linhas AS (
      SELECT h.evento_origem_id, h.artist_id, 0 AS ord, true AS is_host
      FROM hosts h
      UNION ALL
      SELECT
        g.evento_origem_id,
        g.artist_id,
        ROW_NUMBER() OVER (PARTITION BY g.evento_origem_id ORDER BY g.criado_em)::int,
        false
      FROM guests g
      JOIN hosts h
        ON h.evento_origem_id = g.evento_origem_id
       AND h.artist_id IS DISTINCT FROM g.artist_id
    ),
    artistas AS (
      SELECT
        a.id,
        COALESCE(NULLIF(trim(a.name), ''), 'Artista') AS name,
        NULLIF(trim(COALESCE(a.profile_url, '')), '') AS profile_url
      FROM public.artists a
      WHERE a.id IN (SELECT l.artist_id FROM linhas l)
         OR a.id IN (
           SELECT m.artista_que_convidou_id
           FROM marcacao m
           WHERE m.eh_copia
             AND m.artista_que_convidou_id IS NOT NULL
         )
    ),
    listas_origem AS (
      SELECT
        l.evento_origem_id,
        jsonb_agg(
          jsonb_build_object(
            'id', l.artist_id,
            'name', COALESCE(ar.name, 'Artista'),
            'profile_url', ar.profile_url,
            'isHost', l.is_host
          )
          ORDER BY l.ord
        ) AS lista
      FROM linhas l
      LEFT JOIN artistas ar ON ar.id = l.artist_id
      GROUP BY l.evento_origem_id
    )
    SELECT jsonb_build_object(
      'role', v_role,
      'convidados_inclusos', true,
      'events', COALESCE(
        (
          SELECT jsonb_agg(
            jsonb_build_object(
              'id', e.id,
              'artist_id', e.artist_id,
              'created_by', e.created_by,
              'name', e.name,
              'description', e.description,
              'viewer_description', e.viewer_description,
              'event_date', e.event_date,
              'start_time', e.start_time,
              'end_time', e.end_time,
              'value', CASE
                WHEN v_role IN ('admin', 'owner') THEN e.value
                WHEN v_role IN ('vendedor', 'editor') AND e.created_by = v_uid THEN e.value
                ELSE NULL
              END,
              'paid_amount', CASE
                WHEN v_role IN ('admin', 'owner') THEN e.paid_amount
                WHEN v_role IN ('vendedor', 'editor') AND e.created_by = v_uid THEN e.paid_amount
                ELSE NULL
              END,
              'city', e.city,
              'state_uf', e.state_uf,
              'contractor_phone', e.contractor_phone,
              'confirmed', e.confirmed,
              'tag', e.tag,
              'created_at', e.created_at,
              'updated_at', e.updated_at,
              'convite_participacao_id', e.convite_participacao_id,
              'is_public', e.is_public,
              'ativo', e.ativo,
              'feed_tipo', e.feed_tipo
            )
            ORDER BY e.event_date, e.start_time
          )
          FROM mes e
        ),
        '[]'::jsonb
      ),
      'participantes', COALESCE(
        (
          SELECT jsonb_object_agg(x.event_id, x.lista)
          FROM (
            SELECT lo.evento_origem_id AS event_id, lo.lista
            FROM listas_origem lo
            UNION ALL
            SELECT m.id, lo.lista
            FROM marcacao m
            JOIN listas_origem lo ON lo.evento_origem_id = m.evento_origem_id
            WHERE m.eh_copia
          ) x
        ),
        '{}'::jsonb
      ),
      'parceiros', COALESCE(
        (
          SELECT jsonb_object_agg(
            m.convite_participacao_id,
            jsonb_build_object(
              'name', COALESCE(ar.name, 'Artista'),
              'profile_url', ar.profile_url
            )
          )
          FROM marcacao m
          LEFT JOIN artistas ar ON ar.id = m.artista_que_convidou_id
          WHERE m.eh_copia
            AND m.convite_participacao_id IS NOT NULL
        ),
        '{}'::jsonb
      ),
      'ciclos', COALESCE(
        (
          SELECT jsonb_object_agg(m.convite_participacao_id, m.ciclo_status)
          FROM marcacao m
          WHERE m.convite_participacao_id IS NOT NULL
            AND m.ciclo_status IS NOT NULL
        ),
        '{}'::jsonb
      ),
      'copias', COALESCE(
        (
          SELECT jsonb_object_agg(m.id, m.convite_participacao_id)
          FROM marcacao m
          WHERE m.eh_copia
            AND m.convite_participacao_id IS NOT NULL
        ),
        '{}'::jsonb
      ),
      'origens_do_dono', COALESCE(
        (
          SELECT jsonb_agg(m.id)
          FROM marcacao m
          WHERE m.convite_participacao_id IS NOT NULL
            AND NOT m.eh_copia
        ),
        '[]'::jsonb
      )
    )
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.rpc_app_agenda_mes(uuid, date, date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_app_agenda_mes(uuid, date, date) TO service_role;

NOTIFY pgrst, 'reload schema';
