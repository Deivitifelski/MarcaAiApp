/**
 * Carga da abertura da agenda.
 *
 * Reproduz o que getEventsByMonthWithRole faz em services/supabase/eventService.ts:
 *   1. GET /auth/v1/user
 *   2. em paralelo:
 *        GET /rest/v1/events          (mês do artista, só agenda)
 *        GET /rest/v1/artist_members  (papel do usuário)
 *
 * Não altera o app. Só leitura.
 *
 * Modos (K6_MODE):
 *   burst        — N usuários disparam 1 vez juntos (padrão: 100)
 *   sustain      — N usuários ficam repetindo a tela por K6_DURATION
 *   progressive  — 10, 25, 50, 100 e 200 ao mesmo tempo, um nível por vez
 */
import encoding from 'k6/encoding';
import http from 'k6/http';
import { check } from 'k6';
import { Counter } from 'k6/metrics';
import exec from 'k6/execution';

const SUPABASE_URL = __ENV.K6_SUPABASE_URL || 'https://ctulmpyaikxsnjqmrzxf.supabase.co';
const ANON_KEY =
  __ENV.K6_ANON_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImN0dWxtcHlhaWt4c25qcW1yenhmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTc2MzkxMjMsImV4cCI6MjA3MzIxNTEyM30.bu0gER4uTIZ5PDV7t1-fcwU01UZAJ6aFG6axFZQlU8U';

const EVENT_SELECT =
  'id,artist_id,created_by,name,description,viewer_description,event_date,start_time,end_time,value,paid_amount,city,state_uf,contractor_phone,confirmed,tag,created_at,updated_at,convite_participacao_id,is_public,ativo,feed_tipo';

const STAGES = [10, 25, 50, 100, 200];
const MODE = __ENV.K6_MODE || 'burst';
const VUS = positiveInt(__ENV.K6_VUS, MODE === 'burst' ? 100 : 10);
const STAGE_SECONDS = durationSeconds(__ENV.K6_STAGE_DURATION, 30);
const SUSTAIN_SECONDS = durationSeconds(__ENV.K6_DURATION, 30);
const GAP_SECONDS = 10;

const timeouts = new Counter('timeouts');
const http4xx = new Counter('http_4xx');
const http5xx = new Counter('http_5xx');

export const options = buildOptions();

export function setup() {
  const bounds = monthBounds();
  const token = resolveToken();
  const userId = userIdFromJwt(token);
  const artistId = resolveArtistId(token, userId);

  return {
    token,
    userId,
    artistId,
    startDate: bounds.startDate,
    endDate: bounds.endDate,
  };
}

export default function agenda(data) {
  const stage = currentStage();
  const baseHeaders = {
    apikey: ANON_KEY,
    Authorization: `Bearer ${data.token}`,
    'X-Client-Info': 'supabase-js-react-native/2.81.0',
    'Accept-Profile': 'public',
  };

  const authRes = http.get(`${SUPABASE_URL}/auth/v1/user`, {
    headers: Object.assign({}, baseHeaders, { Accept: 'application/json' }),
    tags: { endpoint: 'auth_user', stage },
    timeout: '60s',
  });
  record(authRes, 'auth_user', stage);
  check(authRes, {
    'auth_user 200': (r) => r.status === 200,
  });

  const eventsUrl =
    `${SUPABASE_URL}/rest/v1/events` +
    `?select=${EVENT_SELECT}` +
    `&artist_id=eq.${data.artistId}` +
    `&ativo=eq.true` +
    `&feed_tipo=is.null` +
    `&event_date=gte.${data.startDate}` +
    `&event_date=lte.${data.endDate}` +
    `&order=event_date.asc,start_time.asc`;

  const membersUrl =
    `${SUPABASE_URL}/rest/v1/artist_members` +
    `?select=role` +
    `&user_id=eq.${data.userId}` +
    `&artist_id=eq.${data.artistId}`;

  const responses = http.batch([
    [
      'GET',
      eventsUrl,
      null,
      {
        headers: Object.assign({}, baseHeaders, { Accept: 'application/json' }),
        tags: { endpoint: 'events', stage },
        timeout: '60s',
      },
    ],
    [
      'GET',
      membersUrl,
      null,
      {
        headers: Object.assign({}, baseHeaders, {
          Accept: 'application/vnd.pgrst.object+json',
        }),
        tags: { endpoint: 'artist_members', stage },
        timeout: '60s',
      },
    ],
  ]);

  record(responses[0], 'events', stage);
  record(responses[1], 'artist_members', stage);

  check(responses[0], {
    'events 200': (r) => r.status === 200,
    'events é uma lista': (r) => {
      if (r.status !== 200 || !r.body) return false;
      try {
        return Array.isArray(JSON.parse(r.body));
      } catch (e) {
        return false;
      }
    },
  });
  check(responses[1], {
    'artist_members 200': (r) => r.status === 200,
  });
}

export function handleSummary(data) {
  const report = buildReport(data);
  return {
    stdout: report,
    'load-test/results/resumo.md': report,
    'load-test/results/summary.json': JSON.stringify(data, null, 2),
  };
}

function buildOptions() {
  const thresholds = {
    'http_req_failed{endpoint:events}': [{ threshold: 'rate<0.01', abortOnFail: false }],
    'http_req_duration{endpoint:events}': [
      { threshold: 'p(95)<1000', abortOnFail: false },
      { threshold: 'p(99)<2000', abortOnFail: false },
    ],
    'timeouts{endpoint:events}': [{ threshold: 'count>=0', abortOnFail: false }],
    'http_4xx{endpoint:events}': [{ threshold: 'count>=0', abortOnFail: false }],
    'http_5xx{endpoint:events}': [{ threshold: 'count>=0', abortOnFail: false }],
  };

  const scenarios = {};

  if (MODE === 'progressive') {
    STAGES.forEach((vus, index) => {
      const stage = String(vus);
      scenarios[`vu_${stage}`] = {
        executor: 'constant-vus',
        vus,
        duration: `${STAGE_SECONDS}s`,
        startTime: `${index * (STAGE_SECONDS + GAP_SECONDS)}s`,
        tags: { stage },
        gracefulStop: '30s',
      };
      addStageThresholds(thresholds, stage);
    });
  } else if (MODE === 'sustain') {
    scenarios.sustain = {
      executor: 'constant-vus',
      vus: VUS,
      duration: `${SUSTAIN_SECONDS}s`,
      tags: { stage: String(VUS) },
      gracefulStop: '30s',
    };
    addStageThresholds(thresholds, String(VUS));
  } else {
    scenarios.burst = {
      executor: 'per-vu-iterations',
      vus: VUS,
      iterations: 1,
      maxDuration: '3m',
      tags: { stage: String(VUS) },
      gracefulStop: '30s',
    };
    addStageThresholds(thresholds, String(VUS));
  }

  return {
    scenarios,
    thresholds,
    summaryTrendStats: ['avg', 'med', 'p(90)', 'p(95)', 'p(99)', 'max', 'count'],
    summaryTimeUnit: 'ms',
  };
}

function addStageThresholds(thresholds, stage) {
  ['auth_user', 'events', 'artist_members'].forEach((endpoint) => {
    thresholds[`http_req_duration{endpoint:${endpoint},stage:${stage}}`] = [
      { threshold: 'p(95)<100000', abortOnFail: false },
    ];
    thresholds[`http_reqs{endpoint:${endpoint},stage:${stage}}`] = [
      { threshold: 'count>=0', abortOnFail: false },
    ];
    thresholds[`http_req_failed{endpoint:${endpoint},stage:${stage}}`] = [
      { threshold: 'rate<1', abortOnFail: false },
    ];
    thresholds[`timeouts{endpoint:${endpoint},stage:${stage}}`] = [
      { threshold: 'count>=0', abortOnFail: false },
    ];
    thresholds[`http_4xx{endpoint:${endpoint},stage:${stage}}`] = [
      { threshold: 'count>=0', abortOnFail: false },
    ];
    thresholds[`http_5xx{endpoint:${endpoint},stage:${stage}}`] = [
      { threshold: 'count>=0', abortOnFail: false },
    ];
  });
}

function record(res, endpoint, stage) {
  const tags = { endpoint, stage };
  if (res.status === 0) timeouts.add(1, tags);
  else if (res.status >= 500) http5xx.add(1, tags);
  else if (res.status >= 400) http4xx.add(1, tags);
}

function currentStage() {
  const scenario = exec.scenario.name || '';
  if (scenario.indexOf('vu_') === 0) return scenario.slice(3);
  return String(VUS);
}

function resolveToken() {
  if (__ENV.K6_ACCESS_TOKEN) return __ENV.K6_ACCESS_TOKEN.trim().replace(/^Bearer\s+/i, '');
  const email = (__ENV.K6_EMAIL || '').trim().toLowerCase();
  const password = __ENV.K6_PASSWORD || '';
  if (!email || !password) {
    throw new Error(
      'Informe K6_ACCESS_TOKEN ou o par K6_EMAIL e K6_PASSWORD. O teste não inventa sessão.',
    );
  }
  const res = http.post(
    `${SUPABASE_URL}/auth/v1/token?grant_type=password`,
    JSON.stringify({ email, password }),
    {
      headers: {
        apikey: ANON_KEY,
        Authorization: `Bearer ${ANON_KEY}`,
        'Content-Type': 'application/json',
        'X-Client-Info': 'supabase-js-react-native/2.81.0',
      },
      timeout: '30s',
    },
  );
  if (res.status !== 200) {
    throw new Error(`Login recusou a sessão (HTTP ${res.status}). Confira e-mail e senha.`);
  }
  const body = JSON.parse(res.body);
  if (!body.access_token) throw new Error('Login não devolveu access_token.');
  return body.access_token;
}

function resolveArtistId(token, userId) {
  if (__ENV.K6_ARTIST_ID) return __ENV.K6_ARTIST_ID.trim();
  const res = http.get(
    `${SUPABASE_URL}/rest/v1/artist_members?select=artist_id,role&user_id=eq.${userId}`,
    {
      headers: {
        apikey: ANON_KEY,
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        'Accept-Profile': 'public',
      },
      timeout: '30s',
    },
  );
  if (res.status !== 200) {
    throw new Error(`Não foi possível listar artistas do usuário (HTTP ${res.status}). Informe K6_ARTIST_ID.`);
  }
  const rows = JSON.parse(res.body);
  const ids = (rows || []).map((row) => `${row.artist_id} (${row.role})`).join(', ');
  throw new Error(`Informe K6_ARTIST_ID. Artistas desta conta: ${ids || 'nenhum'}`);
}

function userIdFromJwt(token) {
  const raw = token.replace(/^Bearer\s+/i, '');
  const part = raw.split('.')[1];
  if (!part) throw new Error('Access token inválido.');
  let b64 = part.replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64.length % 4;
  if (pad) b64 += '='.repeat(4 - pad);
  const payload = JSON.parse(encoding.b64decode(b64, 'std', 's'));
  if (!payload.sub) throw new Error('Access token sem sub.');
  return payload.sub;
}

function monthBounds() {
  const now = new Date();
  const year = __ENV.K6_YEAR ? Number(__ENV.K6_YEAR) : now.getFullYear();
  const month = __ENV.K6_MONTH ? Number(__ENV.K6_MONTH) : now.getMonth() + 1;
  const lastDay = new Date(year, month, 0).getDate();
  return {
    startDate: `${year}-${pad2(month)}-01`,
    endDate: `${year}-${pad2(month)}-${pad2(lastDay)}`,
  };
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function positiveInt(value, fallback) {
  const n = Number(value || fallback);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.floor(n);
}

function durationSeconds(value, fallback) {
  if (!value) return fallback;
  const match = String(value).trim().match(/^(\d+)s$/);
  if (!match) throw new Error(`Duração inválida "${value}". Use segundos, por exemplo 30s.`);
  return Number(match[1]);
}

function buildReport(data) {
  const stages = stageList();
  const lines = [];
  lines.push('# Carga da agenda');
  lines.push('');
  lines.push(`Modo: **${MODE}**. Cada usuário virtual repete a abertura real da tela: autenticação e, em seguida, eventos e papel ao mesmo tempo.`);
  lines.push('');
  lines.push('Limites usados para marcar degradação: erro da listagem de eventos acima de 1%, p95 acima de 1 s, p99 acima de 2 s.');
  lines.push('');

  stages.forEach((stage) => {
    lines.push(`## ${stage} usuários`);
    lines.push('');
    lines.push('| Requisição | Média | p50 | p90 | p95 | p99 | Máximo | Requisições | RPS | Erros | % erros | Timeouts | 4xx | 5xx |');
    lines.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
    ['auth_user', 'events', 'artist_members'].forEach((endpoint) => {
      lines.push(`| ${endpointLabel(endpoint)} | ${endpointRow(data, endpoint, stage)} |`);
    });
    lines.push('');
    const verdict = stageVerdict(data, stage);
    lines.push(verdict);
    lines.push('');
  });

  lines.push('## Leitura');
  lines.push('');
  lines.push(overallReading(data, stages));
  lines.push('');
  lines.push('## O que este teste não vê');
  lines.push('');
  lines.push('CPU, memória, conexões, pool e queries lentas ficam no painel do Supabase, no mesmo horário do teste:');
  lines.push('');
  lines.push('- Reports → API: volume, latência e 5xx do gateway.');
  lines.push('- Observability → Query performance: queries lentas em `events` e `artist_members`.');
  lines.push('- Database → Database health / connections: conexões e saturação do Postgres.');
  lines.push('');
  lines.push('Se a listagem de eventos fica lenta e o auth continua rápido, o indício é banco ou PostgREST. Se auth, eventos e papel sobem juntos, o indício é rede ou o gateway. Confira o painel antes de cravar a causa.');
  lines.push('');
  return lines.join('\n');
}

function stageList() {
  if (MODE === 'progressive') return STAGES.map(String);
  return [String(VUS)];
}

function endpointRow(data, endpoint, stage) {
  const duration = metricValues(data, `http_req_duration{endpoint:${endpoint},stage:${stage}}`);
  const reqs = metricValues(data, `http_reqs{endpoint:${endpoint},stage:${stage}}`);
  const failed = metricValues(data, `http_req_failed{endpoint:${endpoint},stage:${stage}}`);
  const timeoutCount = countOf(data, `timeouts{endpoint:${endpoint},stage:${stage}}`);
  const e4 = countOf(data, `http_4xx{endpoint:${endpoint},stage:${stage}}`);
  const e5 = countOf(data, `http_5xx{endpoint:${endpoint},stage:${stage}}`);
  const total = reqs.count || 0;
  const errorRate = failed.rate || 0;
  const errors = Math.round(total * errorRate);
  return [
    ms(duration.avg),
    ms(duration.med),
    ms(duration['p(90)']),
    ms(duration['p(95)']),
    ms(duration['p(99)']),
    ms(duration.max),
    String(total),
    num((reqs.rate || 0).toFixed(2)),
    String(errors),
    `${(errorRate * 100).toFixed(2)}%`,
    String(timeoutCount),
    String(e4),
    String(e5),
  ].join(' | ');
}

function stageVerdict(data, stage) {
  const events = metricValues(data, `http_req_duration{endpoint:events,stage:${stage}}`);
  const failed = metricValues(data, `http_req_failed{endpoint:events,stage:${stage}}`);
  const p95 = events['p(95)'] || 0;
  const p99 = events['p(99)'] || 0;
  const errorRate = failed.rate || 0;
  const problems = [];
  if (errorRate > 0.01) problems.push(`erros em ${(errorRate * 100).toFixed(2)}% das listagens`);
  if (p95 > 1000) problems.push(`p95 da listagem em ${ms(p95)}`);
  if (p99 > 2000) problems.push(`p99 da listagem em ${ms(p99)}`);
  if (problems.length === 0) {
    return `Com ${stage} usuários a listagem de eventos ficou dentro dos limites.`;
  }
  return `Degradação com ${stage} usuários: ${problems.join('; ')}.`;
}

function overallReading(data, stages) {
  let firstBad = null;
  let lastGood = null;
  stages.forEach((stage) => {
    const events = metricValues(data, `http_req_duration{endpoint:events,stage:${stage}}`);
    const failed = metricValues(data, `http_req_failed{endpoint:events,stage:${stage}}`);
    const bad =
      (failed.rate || 0) > 0.01 || (events['p(95)'] || 0) > 1000 || (events['p(99)'] || 0) > 2000;
    if (bad && !firstBad) firstBad = stage;
    if (!bad) lastGood = stage;
  });

  const slowest = slowestEndpoint(data, stages);
  const where = bottleneckHint(data, stages, slowest);

  const limit = lastGood
    ? `O último nível ainda dentro dos limites foi **${lastGood} usuários**.`
    : 'Nenhum nível ficou dentro dos limites.';
  const degrade = firstBad
    ? `A degradação apareceu a partir de **${firstBad} usuários**.`
    : 'Não houve degradação nos níveis executados.';
  const slow = slowest
    ? `A requisição mais lenta foi **${endpointLabel(slowest.endpoint)}** (média ${ms(slowest.avg)} no nível de ${slowest.stage} usuários).`
    : 'Não houve amostras para comparar as requisições.';

  return `${limit} ${degrade} ${slow} ${where}`;
}

function slowestEndpoint(data, stages) {
  let best = null;
  stages.forEach((stage) => {
    ['auth_user', 'events', 'artist_members'].forEach((endpoint) => {
      const values = metricValues(data, `http_req_duration{endpoint:${endpoint},stage:${stage}}`);
      const avg = values.avg || 0;
      if (!best || avg > best.avg) best = { endpoint, stage, avg };
    });
  });
  return best && best.avg > 0 ? best : null;
}

function bottleneckHint(data, stages, slowest) {
  if (!slowest) return '';
  const eventsAvg = avgAcross(data, stages, 'events');
  const authAvg = avgAcross(data, stages, 'auth_user');
  const membersAvg = avgAcross(data, stages, 'artist_members');
  const eventsErrors = maxRate(data, stages, 'events');
  const events5xx = sumCount(data, stages, 'http_5xx', 'events');
  const timeoutsN = sumCount(data, stages, 'timeouts', 'events');

  if (events5xx > 0 || timeoutsN > 0) {
    return 'Há 5xx ou timeout na listagem: o serviço ou o banco passou a recusar ou não responder a tempo. Veja conexões e queries lentas no Supabase.';
  }
  if (eventsErrors > 0.01 && events5xx === 0) {
    return 'Os erros da listagem são 4xx. Confira se o token expirou ou se o artista não pertence a essa conta. Isso não é lentidão de banco.';
  }
  if (eventsAvg > authAvg * 2 && eventsAvg > membersAvg * 1.5) {
    return 'A listagem de eventos puxa a lentidão, enquanto o auth fica mais rápido. O indício principal é a query da agenda no Postgres, via PostgREST.';
  }
  if (authAvg > 800 && eventsAvg > 800 && membersAvg > 800) {
    return 'As três chamadas ficam lentas juntas. O indício principal é rede ou o gateway do Supabase, não uma query isolada.';
  }
  return 'A diferença entre as chamadas não isola um único componente. Compare este horário com CPU, conexões e queries no painel do Supabase.';
}

function avgAcross(data, stages, endpoint) {
  let total = 0;
  let n = 0;
  stages.forEach((stage) => {
    const avg = metricValues(data, `http_req_duration{endpoint:${endpoint},stage:${stage}}`).avg || 0;
    if (avg > 0) {
      total += avg;
      n += 1;
    }
  });
  return n ? total / n : 0;
}

function maxRate(data, stages, endpoint) {
  let max = 0;
  stages.forEach((stage) => {
    const rate = metricValues(data, `http_req_failed{endpoint:${endpoint},stage:${stage}}`).rate || 0;
    if (rate > max) max = rate;
  });
  return max;
}

function sumCount(data, stages, metric, endpoint) {
  let total = 0;
  stages.forEach((stage) => {
    total += countOf(data, `${metric}{endpoint:${endpoint},stage:${stage}}`);
  });
  return total;
}

function metricValues(data, name) {
  const metric = data.metrics[name];
  return (metric && metric.values) || {};
}

function countOf(data, name) {
  const values = metricValues(data, name);
  return values.count || 0;
}

function endpointLabel(endpoint) {
  if (endpoint === 'auth_user') return 'GET /auth/v1/user';
  if (endpoint === 'events') return 'GET /rest/v1/events';
  return 'GET /rest/v1/artist_members';
}

function ms(value) {
  if (value === undefined || value === null || Number.isNaN(value)) return '—';
  return `${Math.round(value)} ms`;
}

function num(value) {
  return value;
}
