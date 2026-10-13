/**
 * Стенд публичного API AI Publisher для проверок сайта (проектный документ
 * §13.1, §13.6): МОК sites-backend `/public/publisher/v1` по замороженным
 * контрактам (`contracts/public-api.ts`, `content-api.ts`; формы ответов —
 * отчёты P-D и P-B1) с инъекцией отказов. Один процесс, один порт.
 *
 *  - `GET  /site-config?key&host` — конфиг (меняется `POST /__stand/config`);
 *    `indexable` — режим `live` и хост ∈ `STAND_INDEXABLE_HOSTS`;
 *  - `GET  /contents`, `/contents/:slug` — два опубликованных материала (в
 *    первом — враждебная разметка для проверки безопасного рендера) и один
 *    снятый (410 `{withdrawn:true}`); неизвестный — 404;
 *  - `POST /leads` — как приём P-D: Origin, 8 КБ, ВАЛИДАЦИЯ НАСТОЯЩИМ
 *    `contracts/lead-validation.ts` бэкенда, повтор `submissionKey` с тем же
 *    телом → 200 с тем же `leadRef` (до лимита), с другим → 409, скользящее
 *    окно `formLimit` → 429 (`Retry-After`, `details.retryAfterSec`,
 *    `altContact`), ловушка → 201 без записи, закрытая форма → 503;
 *    событие `lead_submit_success` пишет СТЕНД (сервер) только при записи;
 *  - `POST /events` — `text/plain` ≤ 2 КБ с JSON, журнал (тип, Origin,
 *    cookie), дедупликация `eventId`, 202.
 *
 * Отказы: `POST /__stand/fail {mode, times}` — `500` (сбой до записи),
 * `busy` (503 PUB_BUSY), `drop` (обрыв соединения ДО записи),
 * `drop-after-commit` (заявка записана, соединение оборвано),
 * `truncated-after-commit` (записана, заголовки 201 пришли, тело оборвано),
 * `reused` (409 `PUB_IDEMPOTENCY_REUSED`), `closed`;
 * `POST /__stand/config {withdrawnExtra, contentsListStatus, contentsSlugStatus}`
 * — снять материал и уронить список/материал (fail-closed middleware);
 * `POST /__stand/config {…, leadDelayMs}` — задержка ответа приёма.
 * Журнал — `GET /__stand/log`; сброс всего — `POST /__stand/reset`, только
 * окна лимита — `POST /__stand/reset-limit` (§13.6: «счётчик стенда
 * сбрасывается между сценариями»).
 *
 * Это мок бизнес-правил без базы и шифрования — сервер проверяют тесты
 * sites-backend (P-D, P-B1); стенд проверяет поведение САЙТА.
 *
 * Запуск: `npx tsx scripts/built/stand.ts` (порт `STAND_PORT`, 3021).
 */
import crypto from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const PORT = Number(process.env.STAND_PORT ?? 3021);
const ROOT = path.resolve(__dirname, '..', '..');
const VALIDATION = path.join(
  ROOT,
  '..',
  'sites-backend',
  'src',
  'modules',
  'publisher',
  'contracts',
  'lead-validation.ts',
);
export const STAND_KEY = process.env.STAND_KEY ?? 'pp_standPublisherKey0000001';
const SITE_ORIGINS = (process.env.STAND_SITE_ORIGINS ?? 'http://localhost:3020,http://127.0.0.1:3020').split(',');
const INDEXABLE_HOSTS = (process.env.STAND_INDEXABLE_HOSTS ?? 'ai-publisher.org')
  .split(',')
  .map((h) => h.trim().toLowerCase());
const PREFIX = '/public/publisher/v1';

type Validate = (
  raw: unknown,
) =>
  | { ok: true; trap: boolean; value: Record<string, unknown> }
  | { ok: false; fields: Array<{ field: string; code: string }> };

interface StandConfig {
  mode: 'closed' | 'test' | 'live';
  formOpen: boolean;
  analyticsStorage: 'none' | 'session';
  consentState: 'granted' | 'denied' | 'unknown' | 'not_required';
  altContact: unknown;
  dataNotice: { version: string | null; text: string | null; approved: boolean } | null;
  faq: unknown[];
  offer: { title: string | null; text: string | null; priceNote: string | null } | null;
  formLimit: { count: number; windowSec: number };
  leadDelayMs: number;
  /** Дополнительно снятые slug (материал ещё есть в CONTENTS). */
  withdrawnExtra: string[];
  /** Принудительный статус `GET /contents` (сбой списка) и `GET /contents/:slug`. */
  contentsListStatus: number | null;
  contentsSlugStatus: number | null;
  /** Параметр `contact_sla` (`{rule}` или null) — контракт Z-2a. */
  contactSla: { rule: string } | null;
}

/** Режим продукта после сброса: `test` (умолчание) или `live` (`STAND_MODE`, сборка с двумя ключами индексации в CI). */
const STAND_MODE: StandConfig['mode'] = process.env.STAND_MODE === 'live' ? 'live' : 'test';

const defaults = (): StandConfig => ({
  mode: STAND_MODE,
  formOpen: true,
  analyticsStorage: 'session',
  consentState: 'not_required',
  altContact: { label: 'stand-alt@example.com', href: 'mailto:stand-alt@example.com' },
  dataNotice: {
    version: 'stand-1',
    text: '## Хто обробляє дані\n\nСтенд: текст повідомлення про обробку даних (параметр `data_notice_version`).\n\n- Що збираємо: дані форми.\n- Строк перегляду: за параметром.',
    approved: false,
  },
  faq: [1, 2, 3, 4, 5].map((n) => ({ question: `Стенд: питання ${n}?`, answer: `Стенд: відповідь ${n}.` })),
  offer: {
    title: 'Стенд: назва пропозиції',
    text: 'Стенд: **задача аудиторії** і склад послуги.\n\n- пункт складу 1\n- пункт складу 2',
    priceNote: null,
  },
  formLimit: { count: 5, windowSec: 600 },
  leadDelayMs: 0,
  withdrawnExtra: [],
  contentsListStatus: null,
  contentsSlugStatus: null,
  contactSla: { rule: 'next_business_day_end' },
});

const hash = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

export const CONTENTS = {
  'pershyi-material': {
    title: 'Стенд: як підготувати матеріал із джерелами',
    shortAnswer: 'Стенд: коротка відповідь першого матеріалу.',
    body: [
      'Стенд: основний текст першого матеріалу — він має бути в HTML без JavaScript.',
      '',
      '## Розділ із таблицею',
      '',
      '| Крок | Хто |',
      '| --- | --- |',
      '| Чернетка | AI |',
      '| Погодження | Редактор |',
      '',
      '- [Другий матеріал](/materials/druhyi-material?utm_source=inner&x=1)',
      '- [Зовнішнє джерело](https://example.org/source)',
      '- [Небезпечне посилання](javascript:alert(1))',
      '- [http без TLS](http://example.org/plain)',
      '',
      'Сирий HTML має стати текстом: <script>window.__xss=1</script> <img src=x onerror="window.__xss=2">',
      '',
      '```',
      'const x = "<b>код</b>";',
      '```',
    ].join('\n'),
    example: 'Стенд: приклад застосування.',
    limitations: ['Стенд: обмеження 1', 'Стенд: обмеження 2'],
    editor: 'Стенд: редактор',
    publishedAt: '2026-10-10T09:00:00.000Z',
    substantiallyUpdatedAt: '2026-10-12T09:00:00.000Z',
    sources: [{ title: 'Стенд: відкрите джерело', url: 'https://example.org/source' }, { private: true as const }],
    cta: 'Стенд: обговорити вашу задачу',
    versionHash: hash('pershyi-material:v1'),
    stage: 'test' as const,
  },
  'druhyi-material': {
    title: 'Стенд: другий матеріал',
    shortAnswer: null,
    body: 'Стенд: основний текст другого матеріалу.\n\n[Назад до першого](/materials/pershyi-material)',
    example: null,
    limitations: [],
    editor: null,
    publishedAt: '2026-10-11T09:00:00.000Z',
    substantiallyUpdatedAt: null,
    sources: [],
    cta: null,
    versionHash: hash('druhyi-material:v1'),
    stage: 'test' as const,
  },
};
export const WITHDRAWN_SLUG = 'znyatyi-material';

interface Lead {
  submissionKey: string;
  requestHash: string;
  leadRef: string;
  eventId: string;
  receivedAt: string;
  body: Record<string, unknown>;
}
interface Log {
  leads: Lead[];
  traps: number;
  events: Array<{ contentType: string; origin: string | null; cookie: string | null; body: Record<string, unknown> }>;
  /** Серверные события (успех заявки) — пишет только стенд при записи заявки. */
  serverEvents: Array<{ name: 'lead_submit_success'; eventId: string; leadRef: string }>;
  responses: Array<{ path: string; status: number }>;
  siteConfigHits: number;
}
const freshLog = (): Log => ({ leads: [], traps: 0, events: [], serverEvents: [], responses: [], siteConfigHits: 0 });

let cfg = defaults();
let log = freshLog();
let hits: number[] = [];
let fail: { mode: string; times: number } | null = null;
/**
 * Эмуляция CDN sites-backend (`s-maxage=60`): GET-ответы 200/410 публичного
 * чтения кэшируются по ПОЛНОМУ адресу на `STAND_CDN_SEC` (умолчание 60 с;
 * 0 — выключить). Так стенд проверяет, что ревалидация сайта не
 * перестраивает страницы по устаревшему ответу CDN (эпоха `rv=`, Z-2b).
 * Сброс стенда очищает и этот кэш.
 */
const CDN_SEC = Number(process.env.STAND_CDN_SEC ?? 60);
const cdn = new Map<string, { at: number; status: number; body: string }>();
const seenEvents = new Set<string>();

function send(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers });
  res.end(JSON.stringify(body));
}
const ok = (data: unknown) => ({ success: true, data });
const err = (code: string, details?: unknown) => ({
  success: false,
  error: { code, message: code, details },
  meta: {},
});

function cors(req: http.IncomingMessage): Record<string, string> {
  const origin = req.headers.origin;
  return origin
    ? { 'access-control-allow-origin': origin, vary: 'Origin', 'access-control-expose-headers': 'Retry-After' }
    : {};
}

function readBody(req: http.IncomingMessage, limit: number): Promise<{ text: string; tooLarge: boolean }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) tooLarge = true;
      else chunks.push(c);
    });
    req.on('end', () => resolve({ text: Buffer.concat(chunks).toString('utf8'), tooLarge }));
  });
}

const leadRefOf = () =>
  `L-${crypto
    .randomBytes(8)
    .toString('hex')
    .toUpperCase()
    .replace(/[^A-Z2-7]/g, '7')
    .slice(0, 10)}`;
const canonical = (v: Record<string, unknown>) => {
  const rest = { ...v };
  delete rest.elapsedMs;
  delete rest.key;
  return JSON.stringify(
    Object.keys(rest)
      .sort()
      .map((k) => [k, rest[k]]),
  );
};
const takeFail = (modes: string[]) => {
  if (!fail || !modes.includes(fail.mode) || fail.times <= 0) return null;
  fail.times--;
  const m = fail.mode;
  if (fail.times <= 0) fail = null;
  return m;
};

/**
 * Обрыв соединения так, чтобы браузер НЕ повторил запрос сам: Chromium молча
 * повторяет запрос, если на переиспользованном соединении не пришло ни
 * байта, — поэтому сначала уходит обрывок строки статуса.
 */
function breakConnection(req: http.IncomingMessage, record: (s: number) => void) {
  record(0);
  req.socket.write('HTTP/1.1 50');
  req.socket.destroy();
}

async function main() {
  const mod = (await import(pathToFileURL(VALIDATION).href)) as {
    validateLeadBody?: Validate;
    default?: { validateLeadBody: Validate };
  };
  const validateLeadBody = (mod.validateLeadBody ?? mod.default?.validateLeadBody) as Validate;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
    const p = url.pathname;
    const origin = req.headers.origin ?? null;
    const record = (status: number) => log.responses.push({ path: p, status });

    // ── управление стендом ──
    if (p.startsWith('/__stand/')) {
      const { text } = await readBody(req, 64 * 1024);
      const body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
      if (p === '/__stand/log') return send(res, 200, { ...log, hits: hits.length, config: cfg, fail });
      if (p === '/__stand/reset') {
        cfg = defaults();
        log = freshLog();
        hits = [];
        fail = null;
        seenEvents.clear();
        cdn.clear();
        return send(res, 200, { ok: true });
      }
      if (p === '/__stand/reset-limit') {
        hits = [];
        return send(res, 200, { ok: true });
      }
      if (p === '/__stand/config') {
        cfg = { ...cfg, ...(body as Partial<StandConfig>) };
        return send(res, 200, { ok: true, config: cfg });
      }
      if (p === '/__stand/fail') {
        fail = body.mode ? { mode: String(body.mode), times: Number(body.times ?? 1) } : null;
        return send(res, 200, { ok: true, fail });
      }
      return send(res, 404, { ok: false });
    }

    if (!p.startsWith(PREFIX)) return send(res, 404, err('PUB_NOT_FOUND'));
    const route = p.slice(PREFIX.length);
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        ...cors(req),
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        'access-control-allow-headers': 'content-type, accept-language',
        'access-control-max-age': '600',
      });
      return res.end();
    }
    const h = cors(req);
    if (origin && !SITE_ORIGINS.includes(origin)) {
      record(403);
      return send(res, 403, err('PUB_ORIGIN_DENIED'), h);
    }

    if (req.method === 'GET') {
      if (url.searchParams.get('key') !== STAND_KEY) return send(res, 404, err('PUB_NOT_FOUND'), h);
      const hit = CDN_SEC > 0 ? cdn.get(req.url ?? '') : undefined;
      if (hit && Date.now() - hit.at < CDN_SEC * 1000) {
        res.writeHead(hit.status, { 'content-type': 'application/json; charset=utf-8', 'x-stand-cdn': 'HIT', ...h });
        return res.end(hit.body);
      }
      if (CDN_SEC > 0) {
        const origEnd = res.end.bind(res);
        res.end = ((chunk?: unknown, ...rest: unknown[]) => {
          if ((res.statusCode === 200 || res.statusCode === 410) && typeof chunk === 'string') {
            cdn.set(req.url ?? '', { at: Date.now(), status: res.statusCode, body: chunk });
          }
          return (origEnd as (...a: unknown[]) => http.ServerResponse)(chunk, ...rest);
        }) as typeof res.end;
      }
      if (route === '/site-config') {
        log.siteConfigHits++;
        const host = (url.searchParams.get('host') ?? '').toLowerCase();
        const { leadDelayMs: _d, withdrawnExtra: _w, contentsListStatus: _l, contentsSlugStatus: _s, ...view } = cfg;
        void [_d, _w, _l, _s];
        // Как представление `pub_public_products`: индексируемые хосты — только у live.
        return send(res, 200, ok({ ...view, indexable: cfg.mode === 'live' && INDEXABLE_HOSTS.includes(host) }), {
          ...h,
          'cache-control': 'public, s-maxage=60',
        });
      }
      if (route === '/contents') {
        if (cfg.contentsListStatus) return send(res, cfg.contentsListStatus, err('PUB_BUSY'), h);
        const list = Object.entries(CONTENTS).map(([slug, c]) => ({
          slug,
          title: c.title,
          description: c.shortAnswer,
          publishedAt: c.publishedAt,
          updatedAt: c.substantiallyUpdatedAt ?? c.publishedAt,
          stage: c.stage,
          withdrawn: cfg.withdrawnExtra.includes(slug),
        }));
        list.push({
          slug: WITHDRAWN_SLUG,
          title: null,
          description: null,
          publishedAt: null,
          updatedAt: null,
          stage: 'test',
          withdrawn: true,
        } as never);
        return send(res, 200, ok(list), h);
      }
      const m = /^\/contents\/([a-z0-9-]+)$/.exec(route);
      if (m) {
        if (cfg.contentsSlugStatus) return send(res, cfg.contentsSlugStatus, err('PUB_BUSY'), h);
        if (m[1] === WITHDRAWN_SLUG || cfg.withdrawnExtra.includes(m[1]))
          return send(res, 410, ok({ withdrawn: true }), h);
        const c = (CONTENTS as Record<string, unknown>)[m[1]];
        return c ? send(res, 200, ok(c), h) : send(res, 404, err('PUB_NOT_FOUND'), h);
      }
      return send(res, 404, err('PUB_NOT_FOUND'), h);
    }

    if (req.method === 'POST' && route === '/events') {
      const { text, tooLarge } = await readBody(req, 2048);
      if (!origin) return send(res, 403, err('PUB_ORIGIN_DENIED'), h);
      if (tooLarge) return send(res, 413, err('PUB_PAYLOAD_TOO_LARGE'), h);
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(text) as Record<string, unknown>;
      } catch {
        return send(res, 400, err('PUB_VALIDATION', { fields: [{ field: '$', code: 'type' }] }), h);
      }
      if (body.key !== STAND_KEY) return send(res, 404, err('PUB_NOT_FOUND'), h);
      if (body.name !== 'content_view' && body.name !== 'cta_click') {
        return send(res, 400, err('PUB_VALIDATION', { fields: [{ field: 'name', code: 'enum' }] }), h);
      }
      const id = String(body.eventId);
      if (!seenEvents.has(id)) {
        seenEvents.add(id);
        log.events.push({
          contentType: String(req.headers['content-type'] ?? ''),
          origin,
          cookie: req.headers.cookie ?? null,
          body,
        });
      }
      return send(res, 202, ok({}), h);
    }

    if (req.method === 'POST' && route === '/leads') {
      const { text, tooLarge } = await readBody(req, 8 * 1024);
      if (cfg.leadDelayMs > 0) await new Promise((r) => setTimeout(r, cfg.leadDelayMs));
      const done = (status: number, body: unknown, extra: Record<string, string> = {}) => {
        record(status);
        send(res, status, body, { ...h, 'cache-control': 'no-store', ...extra });
      };
      if (!origin) return done(403, err('PUB_ORIGIN_DENIED'));
      if (tooLarge) return done(413, err('PUB_PAYLOAD_TOO_LARGE'));
      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch {
        return done(400, err('PUB_VALIDATION', { fields: [{ field: '$', code: 'type' }] }));
      }
      if ((raw as { key?: unknown })?.key !== STAND_KEY) return done(404, err('PUB_NOT_FOUND'));
      const v = validateLeadBody(raw);
      if (!v.ok) return done(400, err('PUB_VALIDATION', { fields: v.fields }));
      if (!cfg.formOpen || takeFail(['closed']))
        return done(503, err('PUB_FORM_CLOSED', { altContact: cfg.altContact, reason: 'closed' }));
      const early = takeFail(['500', 'busy', 'drop', 'reused']);
      if (early === '500') return done(500, err('INTERNAL'));
      if (early === 'reused') return done(409, err('PUB_IDEMPOTENCY_REUSED'));
      if (early === 'busy') return done(503, err('PUB_BUSY'));
      if (early === 'drop') return breakConnection(req, record);
      const value = v.value;
      const requestHash = hash(canonical(value));
      const prev = log.leads.find((l) => l.submissionKey === value.submissionKey);
      if (prev) {
        if (prev.requestHash !== requestHash) return done(409, err('PUB_IDEMPOTENCY_REUSED'));
        return done(200, ok({ leadRef: prev.leadRef, receivedAt: prev.receivedAt, eventId: prev.eventId }));
      }
      const now = Date.now();
      hits = hits.filter((t) => t > now - cfg.formLimit.windowSec * 1000);
      if (hits.length >= cfg.formLimit.count) {
        const retryAfterSec = Math.max(1, Math.ceil((hits[0] + cfg.formLimit.windowSec * 1000 - now) / 1000));
        return done(429, err('PUB_RATE_LIMITED', { retryAfterSec, altContact: cfg.altContact }), {
          'retry-after': String(retryAfterSec),
        });
      }
      hits.push(now);
      if (v.trap) {
        log.traps++;
        return done(
          201,
          ok({ leadRef: leadRefOf(), receivedAt: new Date().toISOString(), eventId: crypto.randomUUID() }),
        );
      }
      const lead: Lead = {
        submissionKey: String(value.submissionKey),
        requestHash,
        leadRef: leadRefOf(),
        eventId: crypto.randomUUID(),
        receivedAt: new Date().toISOString(),
        body: raw as Record<string, unknown>,
      };
      log.leads.push(lead);
      log.serverEvents.push({ name: 'lead_submit_success', eventId: lead.eventId, leadRef: lead.leadRef });
      const after = takeFail(['drop-after-commit', 'truncated-after-commit']);
      if (after === 'drop-after-commit') return breakConnection(req, record);
      if (after === 'truncated-after-commit') {
        // Заголовки успеха пришли, тело оборвано: без `leadRef` это НЕ успех.
        record(201);
        req.socket.write(
          `HTTP/1.1 201 Created\r\ncontent-type: application/json\r\naccess-control-allow-origin: ${origin}\r\ncontent-length: 400\r\n\r\n{"success":true,"data":{"leadR`,
        );
        return req.socket.destroy();
      }
      return done(201, ok({ leadRef: lead.leadRef, receivedAt: lead.receivedAt, eventId: lead.eventId }));
    }
    return send(res, 404, err('PUB_NOT_FOUND'), h);
  });
  server.listen(PORT, () =>
    console.log(`publisher stand :${PORT} (key ${STAND_KEY}; сайт ${SITE_ORIGINS.join(', ')})`),
  );
}

if (require.main === module) void main();
