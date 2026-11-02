# Teste de carga da agenda

O teste fica só nesta pasta. Ele não muda o aplicativo.

A tela `app/(tabs)/agenda.tsx` carrega o mês em `getEventsByMonthWithRole` (`services/supabase/eventService.ts`). Cada abertura faz, nesta ordem:

1. `GET /auth/v1/user` — confirma a sessão (`supabase.auth.getUser()`).
2. Em paralelo:
   - `GET /rest/v1/events` — eventos ativos do artista, sem anúncio de feed, no mês visível.
   - `GET /rest/v1/artist_members` — papel do usuário naquele artista (`getUserPermissions`).

Projeto usado pelo app: `https://ctulmpyaikxsnjqmrzxf.supabase.co`.

O teste dispara essas três chamadas juntas. Com N usuários virtuais, existem N sequências ao mesmo tempo. Não é uma fila de 100 pedidos um depois do outro.

## Requisição da listagem

Método: `GET`  
URL:

```text
/rest/v1/events?select=id,artist_id,created_by,name,description,viewer_description,event_date,start_time,end_time,value,paid_amount,city,state_uf,contractor_phone,confirmed,tag,created_at,updated_at,convite_participacao_id,is_public,ativo,feed_tipo&artist_id=eq.<ARTISTA>&ativo=eq.true&feed_tipo=is.null&event_date=gte.<AAAA-MM-01>&event_date=lte.<AAAA-MM-ÚLTIMO>&order=event_date.asc,start_time.asc
```

Headers, iguais aos do cliente Supabase do app:

| Header | Valor |
| --- | --- |
| `apikey` | chave anônima de `lib/supabase.ts` |
| `Authorization` | `Bearer <access_token do usuário logado>` |
| `Accept` | `application/json` |
| `Accept-Profile` | `public` |
| `X-Client-Info` | `supabase-js-react-native/2.81.0` |

Não há body. O mês padrão é o mês atual da máquina. Para fixar: `K6_YEAR=2026` e `K6_MONTH=11`.

Resposta esperada: HTTP 200 e um array JSON. Cada item traz as colunas do `select` (id, artista, nome, data, horários, valor, cidade, confirmação, tag, etc.).

A consulta de papel usa `Accept: application/vnd.pgrst.object+json` e devolve um objeto `{ "role": "admin" | "vendedor" | "viewer" }`. Sem body.

## Antes de rodar

Instale o k6: [https://k6.io/docs/get-started/installation/](https://k6.io/docs/get-started/installation/).

Isso chama o Supabase de produção, só com leitura. Ainda assim, 100 ou 200 acessos ao mesmo tempo carregam o projeto. Rode quando puder olhar o painel.

A sessão é a de um usuário real. Duas formas:

```bash
export K6_EMAIL="seu-email"
export K6_PASSWORD="sua-senha"
export K6_ARTIST_ID="uuid-do-artista-ativo"
```

Ou cole o access token já emitido pelo login:

```bash
export K6_ACCESS_TOKEN="eyJ..."
export K6_ARTIST_ID="uuid-do-artista-ativo"
```

O `K6_ARTIST_ID` é o artista selecionado na agenda. Se você omitir, o script lista os artistas da conta e para, para você escolher um.

Não grave e-mail, senha ou token em arquivo do repositório.

Enquanto o teste roda, deixe aberto no Supabase:

- Reports → API (latência, 4xx, 5xx)
- Observability → Query performance (`events`, `artist_members`)
- Database health (conexões e CPU)

O k6 mede o tempo visto pelo cliente. CPU, memória, pool e query lenta só aparecem nesse painel.

## 100 ao mesmo tempo

Cada um dos 100 usuários faz uma abertura e para. Todos começam juntos.

```bash
k6 run -e K6_MODE=burst -e K6_VUS=100 load-test/agenda.js
```

## 10, 50, 100 e 200

O mesmo modelo: N usuários em paralelo, repetindo a abertura durante 30 segundos.

```bash
k6 run -e K6_MODE=sustain -e K6_VUS=10 -e K6_DURATION=30s load-test/agenda.js
k6 run -e K6_MODE=sustain -e K6_VUS=50 -e K6_DURATION=30s load-test/agenda.js
k6 run -e K6_MODE=sustain -e K6_VUS=100 -e K6_DURATION=30s load-test/agenda.js
k6 run -e K6_MODE=sustain -e K6_VUS=200 -e K6_DURATION=30s load-test/agenda.js
```

## Comparação progressiva

Um nível por vez, 30 segundos em cada, com 10 segundos de intervalo: 10 → 25 → 50 → 100 → 200.

```bash
k6 run -e K6_MODE=progressive -e K6_STAGE_DURATION=30s load-test/agenda.js
```

## Como ler o resultado

Ao terminar, o script escreve:

- `load-test/results/resumo.md`
- `load-test/results/summary.json`

O resumo traz, por nível e por requisição: média, p50, p90, p95, p99, máximo, quantidade, RPS, erros, percentual de erros, timeouts, 4xx e 5xx.

Degradação da listagem de eventos:

- erros acima de 1%
- p95 acima de 1 segundo
- p99 acima de 2 segundos

O texto final diz em qual quantidade isso começou, qual chamada foi a mais lenta e se o indício aponta para a query da agenda, para o gateway/rede, ou para erro de sessão (4xx).
