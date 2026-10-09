/**
 * Стенд e2e виджета (W1, контракт Э2 §8): два origin на одном процессе.
 *
 *  WIDGET  http://localhost:5181 — origin виджета: статика `dist/v1/*`,
 *          HTML iframe `GET /w/v1/frame?pk=` с CSP (как W2 frame-html.ts) и
 *          публичный API `/widget/v1/*` — МОК W2 (по умолчанию) или прокси
 *          на настоящий sites-backend (`WIDGET_E2E_BACKEND=http://localhost:3010`,
 *          интеграционный прогон координатора §9.3).
 *  SITE    http://<любой>.localhost:5182 — «сайт заказчика»: страницы
 *          собираются из спецификации в `?s=<base64url JSON>` (CSP-заголовок,
 *          атрибуты тега, MPA-ссылки, SPA-кнопки, контейнер inline, чужой iframe).
 *          `*.localhost` — защищённый контекст и общий сайт верхнего уровня
 *          (`example.localhost` и `shop.example.localhost` — одна секция хранилища).
 *
 * Мок НЕ проверяет бизнес-правила W2/W3 (гвард по базе, деньги, маскирование) —
 * только форму протокола и то, что нужно фронту: допуск origin, указатель
 * (тело + CHIPS-cookie), идемпотентность clientRequestId, генерацию, которая
 * не обрывается при разрыве соединения, продолжение стрима из «базы».
 *
 * Э3 (W): мок проверяет ТО ЖЕ, что сервер W на своей стороне стыка
 * (`assist-widget/widget-engagement*.ts`): Origin виджета на маршрутах по
 * visitor-token (GET без Origin — same-origin), Origin страницы = допущенный
 * хост pk на `event`/`goal` загрузчика и `goal-picker/*`, белый список полей
 * пакета событий (неизвестное — 400 EVENT_INVALID, ≤ 20, ≤ 4 КБ, text/plain
 * от sendBeacon), формат цели (orderId-контакт — 422). Бизнес-правила
 * владельцев стыков воспроизведены упрощённо и ПОМЕЧЕНЫ: передача (H) —
 * ответ оператора кладёт `/__mock/operator`; дедуп и атрибуция целей (A) —
 * docId+ключ+детектор, orderId, direct ≤ 30 мин после клика по действию
 * помощника / assisted / unassisted.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import {
  WIDGET_RESUME_COOKIE,
  widgetResumeCookieName,
} from '../../src/shared/brand';
import {
  freshVcLog,
  uiPlanRoute,
  voiceTestRoute,
  type ModelStep,
} from './ui-plan-mock';
import { vcStandRoute } from './vc-stands';
import {
  adminExpire,
  adminLog,
  adminReset,
  adminRoute,
  isAdminHost,
} from './admin-mock';
import { adminVcLog, adminVcReset, adminVcSet } from './admin-vc-mock';
import {
  editorLink,
  editorLog,
  editorReset,
  editorRoute,
  editorZones,
  isEditorHost,
} from './editor-mock';

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..'
);
export const WIDGET_PORT = Number(process.env.WIDGET_E2E_WIDGET_PORT || 5181);
export const SITE_PORT = Number(process.env.WIDGET_E2E_SITE_PORT || 5182);
const WIDGET = `http://localhost:${WIDGET_PORT}`;
const BACKEND = process.env.WIDGET_E2E_BACKEND || '';
// Имя cookie указателя — СВОЁ для каждого pk (как sites-backend: CHIPS
// делит секцию на eTLD+1, общее имя давало перезапись между сайтами).
const cookieName = (pk: string) => widgetResumeCookieName(pk);
const hasResumeCookie = (req: http.IncomingMessage) =>
  Object.keys(cookies(req)).some((n) =>
    n.startsWith(WIDGET_RESUME_COOKIE + '_')
  );

// ── модель мока ────────────────────────────────────────────────────────────

interface Site {
  pk: string;
  siteId: string;
  allowedOrigins: string[];
  status: 'active' | 'lead_only' | 'off';
  config: Record<string, unknown>;
  hosts: Array<{ origin: string; pathMasks: string[]; hideOn: string[] }>;
  allowClientPreview: boolean;
  lead: unknown;
  previewTokens: Record<string, Record<string, unknown>>;
  /** Вид ни разу не опубликован: конфиг → 403 WIDGET_DISABLED (как sites-backend). */
  unpublished?: boolean;
  /** Э3: публичная часть вовлечения/цели/передача — как отдаёт config. */
  engagement?: unknown;
  /** Э3-бис: поле `analytics` конфига (связанный режим по согласию). */
  analytics?: unknown;
  goals?: unknown;
  handoff?: unknown;
  /** Ответ POST handoff: human (по умолчанию) или lead. */
  handoffMode?: 'human' | 'lead';
  /** Токены режима выбора цели: токен → origin, на который выдан. */
  pickerTokens?: Record<string, string>;
  /**
   * Э5: `voice` публичного конфига (как отдаёт сервер) и поведение мока
   * распознавания/озвучки (упрощённо как assist-site-voice: деньги, тариф и
   * провайдер — тесты sites-backend; здесь — форма протокола).
   */
  voice?: unknown;
  voiceMode?: 'ok' | 'limit' | 'not_heard' | 'unavailable';
  voiceText?: string;
  /**
   * Э6-бис: голосовое управление — `voiceControl` конфига, правила кабинета,
   * «ответы модели плана» по командам (ui-plan-mock.ts) и очередь
   * распознанных фраз (`POST /widget/v1/voice` отдаёт их по одной).
   */
  voiceControl?: {
    mode: 'on' | 'degraded';
    denySelectors?: string[];
    allowSelectors?: string[];
    maxSteps?: number;
    /** Э6-тер: у сайта есть мемо; «Я вмію» — имена мемо (skills). */
    memos?: boolean;
    skills?: string[];
  };
  vcRules?: unknown;
  vcModel?: Record<string, ModelStep[] | 'not_command'>;
  voiceTexts?: string[];
  /** Э6-бис (г): одноразовые ссылки мастера проверки (ui-plan-mock.ts). */
  vtTokens?: string[];
  /** Э6-бис (г): выпуск чанков сайта (канарейка) — поле `release` конфига. */
  release?: string;
}
interface Handoff {
  id: string;
  state: 'waiting' | 'active' | 'closed' | 'missed' | 'cancelled';
  requestedAt: string;
  takenAt: string | null;
  timeoutAt: string;
}
interface Msg {
  id: string;
  role: 'visitor' | 'assistant' | 'operator';
  text: string;
  sources: unknown[];
  actions: unknown[];
  streamState: 'streaming' | 'complete' | 'partial' | 'refused';
  rating: number | null;
  createdAt: string;
  crid?: string;
}
interface Conv {
  id: string;
  siteId: string;
  visitorId: string;
  version: number;
  messages: Msg[];
  lastMessageAt: number;
  handoff?: Handoff;
  openedBy?: string | null;
}
interface Token {
  visitorId: string;
  siteId: string;
  pk: string;
  parentOrigin: string;
  exp: number;
  preview: boolean;
}

const bus = new EventEmitter();
bus.setMaxListeners(1000);
let M = fresh();

function fresh() {
  return {
    clock: 0,
    tokenDelayMs: 40,
    /** Задержка ответа `POST session` (гонка «iframe готов, токена ещё нет»). */
    sessionDelayMs: 0,
    sites: new Map<string, Site>(),
    resumes: new Map<string, { visitorId: string; siteId: string }>(),
    tokens: new Map<string, Token>(),
    convs: [] as Conv[],
    modelCalls: [] as Array<{
      crid: string;
      question: string;
      page: unknown;
      context: unknown;
      uiLang: unknown;
      openedBy?: unknown;
      voiceTicket?: unknown;
    }>,
    pings: [] as Array<{ pk: string; v: string; c: string }>,
    configHits: [] as string[],
    leads: [] as unknown[],
    feedback: [] as unknown[],
    forgets: 0,
    sessions: [] as Array<{
      parentOrigin: string;
      resumed: boolean;
      resumeLost: boolean;
      cookie: boolean;
      body: boolean;
      visitorId: string;
    }>,
    requests: [] as Array<{
      method: string;
      path: string;
      origin: string | null;
      hasVisitor: boolean;
      cookie: boolean;
    }>,
    // Э3
    events: [] as Array<{
      pk: string;
      origin: string | null;
      contentType: string;
      events: unknown[];
    }>,
    goals: [] as Array<Record<string, unknown>>,
    goalCalls: 0,
    // Э3-бис: запросы связанного режима (exp, pv, ref, visit).
    ana: [] as Array<{
      path: string;
      origin: string | null;
      contentType: string;
      body: Record<string, unknown>;
    }>,
    handoffs: [] as Array<Record<string, unknown>>,
    cancels: 0,
    picks: [] as Array<Record<string, unknown>>,
    pickerSessions: new Map<string, { pk: string; origin: string }>(),
    usedPickerTokens: new Set<string>(),
    // Э5
    voice: [] as Array<{
      pk: string;
      bytes: number;
      type: string;
      visitorId: string;
    }>,
    tts: [] as Array<{ pk: string; messageId: string; ok: boolean }>,
    // Э6
    videoLinks: [] as Array<{ pk: string; videoId: string; ok: boolean }>,
    videoRedirects: 0,
    highlightMisses: [] as Array<{
      pk: string;
      elementId: string;
      pageUrl: string;
    }>,
    // Ш4 (4): сигналы «элемент найден» подсветкой.
    highlightSeen: [] as Array<{
      pk: string;
      elementId: string;
      pageUrl: string;
    }>,
    // Э6-бис
    vc: freshVcLog(),
    /** Т-1 способ 2: отдавать тестовую сборку voice.js (хук WebAudio). */
    testAudio: false,
  };
}

/** Э5: WAV 0.4 с, 440 Гц — «озвучка» для WebAudio (decodeAudioData читает WAV). */
function toneWav(seconds = 0.4, rate = 8000): Buffer {
  const n = Math.floor(seconds * rate);
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0);
  b.writeUInt32LE(36 + n * 2, 4);
  b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36);
  b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++)
    b.writeInt16LE(
      Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 8000),
      44 + i * 2
    );
  return b;
}

const now = () => Date.now() + M.clock;
const rid = (p: string) => p + crypto.randomBytes(9).toString('base64url');

function defaultSite(pk: string, patch: Partial<Site>): Site {
  return {
    pk,
    siteId: 'site_' + pk.slice(-6),
    allowedOrigins: [],
    status: 'active',
    config: {},
    hosts: [],
    allowClientPreview: false,
    lead: {
      fields: [
        { field: 'name', required: false },
        { field: 'phone', required: true },
      ],
      consentText: {
        ru: 'Согласен на обработку данных (стенд)',
        uk: 'Згоден на обробку даних (стенд)',
      },
    },
    previewTokens: {},
    ...patch,
  };
}

// ── утилиты http ───────────────────────────────────────────────────────────

function send(
  res: http.ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {}
) {
  const buf =
    typeof body === 'string' || Buffer.isBuffer(body)
      ? body
      : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    ...headers,
  });
  res.end(buf);
}
const ok = (
  res: http.ServerResponse,
  data: unknown,
  h?: Record<string, string>
) => send(res, 200, { success: true, data }, h);
const fail = (res: http.ServerResponse, status: number, code: string) =>
  send(res, status, { success: false, error: { code, message: code } });

async function readBody(
  req: http.IncomingMessage
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    return {};
  }
}

function cookies(req: http.IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

function frameCsp(site: Site | undefined): string {
  const anc =
    site && site.status !== 'off' && site.allowedOrigins.length
      ? site.allowedOrigins.join(' ')
      : "'none'";
  return [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self'",
    "font-src 'self'",
    "connect-src 'self'",
    // Э5/Э6: как frame-html.ts sites-backend — звук озвучки из Blob-URL,
    // ролик — подписанная ссылка своего origin и её редирект (в моке — на
    // свой же origin; в проде — хосты роликов ASSIST_VIDEO_HOSTS).
    "media-src blob: 'self'",
    `frame-ancestors ${anc}`,
    "base-uri 'none'",
    "form-action 'none'",
    "require-trusted-types-for 'script'",
    "trusted-types 'none'",
  ].join('; ');
}

const FRAME_HTML =
  '<!doctype html><html lang="uk"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
  '<link rel="stylesheet" href="/v1/chat.css"></head><body><div id="app"></div><script src="/v1/chat.js" defer></script></body></html>';

const GIF = Buffer.from(
  'R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==',
  'base64'
);
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
);

// ── генерация ответа (не зависит от соединения, §4-бис.4) ─────────────────

function answerFor(
  q: string,
  parentOrigin: string
): { text: string; sources: unknown[]; actions: unknown[] } {
  if (q.includes('__mask__'))
    return {
      text: 'Звоните менеджеру +380 67 123 45 67 в рабочее время.',
      sources: [],
      actions: [],
    };
  // Э6: действия подсветки и ролика — как их собрал бы сервер (селектор и
  // подпись — из карты интерфейса, id ролика — из списка сайта).
  if (q.includes('__hl__') || q.includes('__video__'))
    return {
      text: 'Кнопка «Купить» — справа от цены. Покажу на странице.',
      sources: [],
      actions: [
        ...(q.includes('__hl__')
          ? [
              {
                kind: 'highlight',
                label: 'Показать на странице',
                elementId: 'u1a2b3c4d',
                selector: '#cta-buy',
                caption: 'Кнопка «Купить»',
              },
            ]
          : []),
        ...(q.includes('__video__')
          ? [
              {
                kind: 'video',
                label: 'Смотреть видео',
                videoId: q.includes('__video_gone__') ? 'vid_gone' : 'vid_ok',
                title: 'Как оформить заказ',
              },
            ]
          : []),
      ],
    };
  const words = Array.from({ length: 24 }, (_, i) => `слово${i + 1}`).join(' ');
  return {
    text:
      `Ответ на вопрос «${q}». **Важно:** ${words}.\n\n` +
      `- [Доставка](${parentOrigin}/delivery)\n- [Чужая ссылка](https://evil.example/steal)\n` +
      `- ![картинка](https://evil.example/pixel.png)\n- [JS](javascript:alert(1)) <img src=x onerror="window.__xss=1"> [S1]`,
    sources: [
      { n: 1, url: `${parentOrigin}/delivery`, title: 'Доставка' },
      { n: 2, url: 'https://evil.example/x', title: 'Чужой' },
    ],
    actions: [
      { kind: 'link', label: 'Каталог', url: `${parentOrigin}/catalog` },
      { kind: 'link', label: 'Плохая', url: 'javascript:alert(1)' },
      { kind: 'lead', label: 'Оставить заявку' },
    ],
  };
}

function touch(conv: Conv) {
  conv.version++;
  conv.lastMessageAt = now();
}

function generate(conv: Conv, msg: Msg, q: string, parentOrigin: string) {
  const a = answerFor(q, parentOrigin);
  const tokens = a.text.match(/\S+\s*/g) || [];
  let i = 0;
  const tick = () => {
    if (i >= tokens.length) {
      // «__mask__» (решение 23): поток успел отдать телефон, а в базе он уже
      // маскирован на стыке сброса — правда в state, клиент должен взять её.
      if (q.includes('__mask__'))
        msg.text = msg.text.replace(/\+?\d[\d ]{6,}\d/g, '[телефон скрыт]');
      msg.streamState = 'complete';
      msg.sources = a.sources;
      msg.actions = a.actions;
      touch(conv);
      bus.emit('m:' + msg.id);
      return;
    }
    msg.text += tokens[i++];
    touch(conv);
    bus.emit('m:' + msg.id);
    setTimeout(tick, M.tokenDelayMs);
  };
  setTimeout(tick, M.tokenDelayMs);
}

function waitChange(id: string, ms: number): Promise<void> {
  return new Promise((r) => {
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      bus.off('m:' + id, done);
      r();
    }
    bus.on('m:' + id, done);
  });
}

// ── API виджета (мок W2) ───────────────────────────────────────────────────

function auth(req: http.IncomingMessage): Token | null {
  const t = req.headers['x-assist-visitor'];
  if (typeof t !== 'string') return null;
  const tok = M.tokens.get(t);
  return tok && tok.exp > now() ? tok : null;
}

/**
 * Как `tokenRequestOrigin` + `authenticate` sites-backend: запрос по
 * visitor-token — только с origin виджета; GET без Origin — same-origin.
 */
function tokenOriginOk(req: http.IncomingMessage): boolean {
  const o = req.headers.origin;
  if (o === undefined)
    return (
      (req.method === 'GET' || req.method === 'HEAD') &&
      (req.headers['sec-fetch-site'] === undefined ||
        req.headers['sec-fetch-site'] === 'same-origin')
    );
  return o === WIDGET;
}

/** Тело маршрута страницы: JSON или text/plain-строка sendBeacon, ≤ 4 КБ. */
async function readPageBody(
  req: http.IncomingMessage
): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const buf = Buffer.concat(chunks);
  if (buf.length > 4096) return null;
  try {
    const v = JSON.parse(buf.toString('utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

const EVENT_KINDS = [
  'widget_view',
  'open',
  'proactive_shown',
  'proactive_accepted',
  'proactive_dismissed',
  'scenario_started',
  'scenario_done',
  'link_click',
  // Э3-бис: согласие посетителя → ключ визита (раз на визит).
  'visit_new',
];
const ONLY = (o: Record<string, unknown>, keys: string[]) =>
  Object.keys(o).every((k) => keys.includes(k));

function validEventBatch(b: Record<string, unknown> | null): boolean {
  if (!b || !ONLY(b, ['pk', 'events']) || typeof b.pk !== 'string')
    return false;
  const ev = b.events;
  return (
    Array.isArray(ev) &&
    ev.length > 0 &&
    ev.length <= 20 &&
    ev.every(
      (e) =>
        e &&
        typeof e === 'object' &&
        ONLY(e, ['kind', 'key']) &&
        EVENT_KINDS.includes(e.kind) &&
        (e.key === null ||
          (typeof e.key === 'string' && /^[a-z0-9_-]{1,32}$/.test(e.key)))
    )
  );
}

const GOAL_FIELDS = [
  'pk',
  'goalKey',
  'detector',
  'docId',
  'path',
  'orderId',
  'value',
  'currency',
  'conversationId',
  'lastAssistClickAt',
  'assist',
  // Э3-бис: ключ визита посетителя с согласием.
  'visit',
];

/** Формат цели — как parseGoalRequest (W): null — 400, 'ORDER' — 422. */
function goalFormat(
  b: Record<string, unknown> | null,
  iframe: boolean
): 'ok' | 'bad' | 'order' {
  if (!b || !ONLY(b, GOAL_FIELDS)) return 'bad';
  if (
    !iframe &&
    ['conversationId', 'lastAssistClickAt', 'assist'].some(
      (k) => b[k] !== undefined && b[k] !== null
    )
  )
    return 'bad';
  if (!iframe && typeof b.pk !== 'string') return 'bad';
  if (typeof b.goalKey !== 'string' || !/^[a-z0-9_-]{1,40}$/.test(b.goalKey))
    return 'bad';
  if (!['url', 'click', 'form_submit', 'js'].includes(String(b.detector)))
    return 'bad';
  if (typeof b.docId !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(b.docId))
    return 'bad';
  if (
    b.orderId !== undefined &&
    b.orderId !== null &&
    (typeof b.orderId !== 'string' ||
      !/^[A-Za-z0-9._:-]{1,64}$/.test(b.orderId))
  )
    return 'order';
  return 'ok';
}

function siteOfPk(pk: unknown): Site | undefined {
  return typeof pk === 'string' ? M.sites.get(pk) : undefined;
}

function msgView(m: Msg) {
  const { crid: _c, ...v } = m;
  return v;
}

async function api(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL
) {
  const p = url.pathname;
  M.requests.push({
    method: req.method || '',
    path: p,
    origin: (req.headers.origin as string) || null,
    hasVisitor: !!req.headers['x-assist-visitor'],
    cookie: hasResumeCookie(req),
  });
  if (p === '/widget/v1/config') {
    const pk = url.searchParams.get('pk') || '';
    M.configHits.push(pk);
    const s = M.sites.get(pk);
    const h = {
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=300',
    };
    if (!s)
      return send(
        res,
        404,
        { success: false, error: { code: 'WIDGET_UNKNOWN_KEY', message: '' } },
        h
      );
    if (s.unpublished)
      return send(
        res,
        403,
        { success: false, error: { code: 'WIDGET_DISABLED', message: '' } },
        h
      );
    return ok(
      res,
      {
        status: s.status,
        widgetVersion: 3,
        config: s.config,
        hosts: s.hosts,
        allowClientPreview: s.allowClientPreview,
        lead: s.lead,
        suggestedQuestions: [
          'Сколько стоит доставка?',
          'Как оформить возврат?',
        ],
        poweredByUrl: 'https://powered.example/assistant?utm_source=widget',
        ...(s.engagement !== undefined ? { engagement: s.engagement } : {}),
        ...(s.analytics !== undefined ? { analytics: s.analytics } : {}),
        ...(s.goals !== undefined ? { goals: s.goals } : {}),
        ...(s.handoff !== undefined ? { handoff: s.handoff } : {}),
        ...(s.voice !== undefined ? { voice: s.voice } : {}),
        ...(s.release !== undefined ? { release: s.release } : {}),
        ...(s.voiceControl !== undefined
          ? {
              voiceControl: {
                mode: s.voiceControl.mode,
                denySelectors: s.voiceControl.denySelectors ?? [],
                allowSelectors: s.voiceControl.allowSelectors ?? [],
                maxSteps: s.voiceControl.maxSteps ?? 6,
                memos: s.voiceControl.memos === true,
              },
            }
          : {}),
      },
      h
    );
  }
  // ── Э3: маршруты СТРАНИЦЫ (загрузчик, picker.js): CORS отражает origin ──
  const pageRoute =
    p === '/widget/v1/event' ||
    p === '/widget/v1/goal' ||
    p === '/widget/v1/goal-picker/session' ||
    p === '/widget/v1/goal-picker/pick' ||
    // Э3-бис: связанный режим со страницы.
    p === '/widget/v1/exp' ||
    p === '/widget/v1/pv' ||
    p === '/widget/v1/ref';
  const reqOrigin = (req.headers.origin as string) || '';
  const cors: Record<string, string> =
    pageRoute && reqOrigin
      ? {
          'Access-Control-Allow-Origin': reqOrigin,
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, X-Assist-Visitor',
          Vary: 'Origin',
        }
      : {};
  if (pageRoute && req.method === 'OPTIONS') {
    res.writeHead(204, cors);
    return res.end();
  }
  // Э3-бис: связанный режим (форма — sites-backend; здесь запись для e2e).
  if (
    req.method === 'POST' &&
    (p === '/widget/v1/exp' || p === '/widget/v1/pv' || p === '/widget/v1/ref')
  ) {
    const b = await readPageBody(req);
    const s = b && siteOfPk(b.pk);
    if (!s || !s.allowedOrigins.includes(reqOrigin))
      return send(
        res,
        403,
        { success: false, error: { code: 'ORIGIN_DENIED', message: '' } },
        cors
      );
    M.ana.push({
      path: p,
      origin: reqOrigin,
      contentType: String(req.headers['content-type'] || ''),
      body: b as Record<string, unknown>,
    });
    if (p === '/widget/v1/ref')
      return send(res, 200, { success: true, data: { ref: 'r1.test' } }, cors);
    res.writeHead(204, cors);
    return res.end();
  }
  if (req.method === 'POST' && p === '/widget/v1/visit') {
    const visitor = auth(req);
    if (!visitor) return fail(res, 401, 'SESSION_EXPIRED');
    const b = await readPageBody(req);
    M.ana.push({
      path: p,
      origin: (req.headers.origin as string) || null,
      contentType: String(req.headers['content-type'] || ''),
      body: b as Record<string, unknown>,
    });
    res.writeHead(204);
    return res.end();
  }
  if (req.method === 'POST' && p === '/widget/v1/event') {
    const b = await readPageBody(req);
    if (!validEventBatch(b))
      return send(
        res,
        400,
        { success: false, error: { code: 'EVENT_INVALID', message: '' } },
        cors
      );
    const s = siteOfPk((b as Record<string, unknown>).pk);
    if (!s || !s.allowedOrigins.includes(reqOrigin))
      return send(
        res,
        403,
        { success: false, error: { code: 'ORIGIN_DENIED', message: '' } },
        cors
      );
    M.events.push({
      pk: s.pk,
      origin: reqOrigin,
      contentType: String(req.headers['content-type'] || ''),
      events: (b as { events: unknown[] }).events,
    });
    res.writeHead(204, cors);
    return res.end();
  }
  if (req.method === 'POST' && p === '/widget/v1/goal') {
    M.goalCalls++;
    const iframeTok = req.headers['x-assist-visitor'];
    const b = await readPageBody(req);
    let siteId: string;
    let visitor: Token | null = null;
    if (iframeTok !== undefined) {
      visitor = auth(req);
      if (!visitor) return fail(res, 401, 'SESSION_EXPIRED');
      if (!tokenOriginOk(req)) return fail(res, 403, 'ORIGIN_DENIED');
      siteId = visitor.siteId;
    } else {
      const s = siteOfPk(b && b.pk);
      if (!s || !s.allowedOrigins.includes(reqOrigin))
        return send(
          res,
          403,
          { success: false, error: { code: 'ORIGIN_DENIED', message: '' } },
          cors
        );
      siteId = s.siteId;
    }
    const f = goalFormat(b, !!visitor);
    if (f !== 'ok')
      return send(
        res,
        f === 'order' ? 422 : 400,
        {
          success: false,
          error: {
            code: f === 'order' ? 'GOAL_ORDER_ID_INVALID' : 'BAD_REQUEST',
            message: '',
          },
        },
        cors
      );
    const g = b as Record<string, unknown>;
    // Упрощённо как A: дедуп «раз на документ» (docId+ключ+детектор, кроме js) и по orderId.
    const dup = M.goals.some(
      (x) =>
        x.siteId === siteId &&
        x.goalKey === g.goalKey &&
        ((g.detector !== 'js' &&
          x.docId === g.docId &&
          x.detector === g.detector) ||
          (!!g.orderId && x.orderId === g.orderId))
    );
    if (!dup) {
      const click =
        typeof g.lastAssistClickAt === 'string'
          ? Date.parse(g.lastAssistClickAt)
          : NaN;
      const own =
        visitor &&
        M.convs.some(
          (c) => c.id === g.conversationId && c.visitorId === visitor!.visitorId
        );
      M.goals.push({
        ...g,
        siteId,
        source: visitor ? 'iframe' : 'loader',
        attribution: !visitor
          ? 'unassisted'
          : !isNaN(click) && now() - click <= 30 * 60_000
            ? 'direct'
            : own
              ? 'assisted'
              : 'unassisted',
      });
    }
    res.writeHead(204, cors);
    return res.end();
  }
  if (req.method === 'POST' && p === '/widget/v1/goal-picker/session') {
    const b = await readBody(req);
    const s = siteOfPk(b.pk);
    const tok = String(b.token);
    const forOrigin = s && s.pickerTokens && s.pickerTokens[tok];
    if (
      !s ||
      !forOrigin ||
      forOrigin !== reqOrigin ||
      M.usedPickerTokens.has(tok)
    )
      return send(
        res,
        403,
        { success: false, error: { code: 'PICKER_INVALID', message: '' } },
        cors
      );
    M.usedPickerTokens.add(tok);
    const session = crypto.randomBytes(32).toString('base64url');
    M.pickerSessions.set(session, { pk: s.pk, origin: reqOrigin });
    return send(
      res,
      200,
      {
        success: true,
        data: {
          pickerSession: session,
          expiresAt: new Date(now() + 30 * 60_000).toISOString(),
        },
      },
      cors
    );
  }
  if (req.method === 'POST' && p === '/widget/v1/goal-picker/pick') {
    const b = await readBody(req);
    const ses = M.pickerSessions.get(String(b.pickerSession));
    const d = b.descriptor as Record<string, unknown> | undefined;
    if (!ses || ses.origin !== reqOrigin)
      return send(
        res,
        403,
        { success: false, error: { code: 'PICKER_INVALID', message: '' } },
        cors
      );
    // Как parseDescriptor (W): поле ввода выбрать нельзя.
    if (
      !d ||
      ['input', 'textarea', 'select', 'option'].includes(String(d.tag)) ||
      (b.kind !== 'click' && b.kind !== 'form_submit')
    )
      return send(
        res,
        400,
        { success: false, error: { code: 'BAD_REQUEST', message: '' } },
        cors
      );
    M.picks.push(b);
    return send(res, 200, { success: true, data: { ok: true } }, cors);
  }
  if (p === '/widget/v1/ping') {
    M.pings.push({
      pk: url.searchParams.get('pk') || '',
      v: url.searchParams.get('v') || '',
      c: url.searchParams.get('c') || '',
    });
    res.writeHead(200, {
      'Content-Type': 'image/gif',
      'Cache-Control': 'no-store',
    });
    return res.end(GIF);
  }
  if (p.startsWith('/widget/v1/asset/')) {
    res.writeHead(200, {
      'Content-Type': 'image/png',
      'X-Content-Type-Options': 'nosniff',
    });
    return res.end(PNG);
  }
  if (req.method === 'POST' && p === '/widget/v1/preview/exchange') {
    const b = await readBody(req);
    const s = M.sites.get(String(b.pk));
    const cfg = s && s.previewTokens[String(b.token)];
    if (!s || !cfg || !s.allowedOrigins.includes(String(b.parentOrigin)))
      return fail(res, 403, 'PREVIEW_INVALID');
    delete s.previewTokens[String(b.token)]; // одноразовый
    return ok(res, {
      previewSession: rid('ps_'),
      expiresAt: new Date(now() + 7200e3).toISOString(),
      config: cfg,
    });
  }
  if (
    req.method === 'POST' &&
    (p === '/widget/v1/session' || p === '/widget/v1/session/resume')
  ) {
    const b = await readBody(req);
    if (M.sessionDelayMs)
      await new Promise((r) => setTimeout(r, M.sessionDelayMs));
    const s = M.sites.get(String(b.pk));
    if (!s) return fail(res, 404, 'WIDGET_UNKNOWN_KEY');
    // (в) Origin запроса — только origin iframe; (б) origin родителя — точный из списка.
    if (
      req.headers.origin !== WIDGET ||
      !s.allowedOrigins.includes(String(b.parentOrigin))
    )
      return fail(res, 403, 'ORIGIN_DENIED');
    const fromCookie = cookies(req)[cookieName(s.pk)];
    const fromBody = typeof b.resumeKey === 'string' ? b.resumeKey : null;
    let visitorId: string | null = null;
    let resumeLost = false;
    // Как sites-backend: при наличии cookie побеждает она (HttpOnly), тело —
    // только для браузеров без CHIPS. Поэтому чужая cookie под тем же
    // именем стоила бы диалога — имя своё у каждого pk.
    const presented = fromCookie || fromBody;
    if (presented) {
      const r = M.resumes.get(presented);
      if (r && r.siteId === s.siteId) visitorId = r.visitorId;
      else resumeLost = true;
    }
    let resumeKey: string | null = null;
    const headers: Record<string, string> = {};
    if (!visitorId) {
      visitorId = rid('v_');
      resumeKey = crypto.randomBytes(32).toString('base64url');
      M.resumes.set(resumeKey, { visitorId, siteId: s.siteId });
      headers['Set-Cookie'] =
        `${cookieName(s.pk)}=${resumeKey}; Path=/; Max-Age=2592000; Secure; HttpOnly; SameSite=None; Partitioned`;
    }
    const token = rid('vt_');
    M.tokens.set(token, {
      visitorId,
      siteId: s.siteId,
      pk: s.pk,
      parentOrigin: String(b.parentOrigin),
      exp: now() + 24 * 3600e3,
      preview: !!b.previewSession,
    });
    M.sessions.push({
      parentOrigin: String(b.parentOrigin),
      resumed: !resumeKey,
      resumeLost,
      cookie: !!fromCookie,
      body: !!fromBody,
      visitorId,
    });
    return ok(
      res,
      {
        visitorToken: token,
        expiresAt: new Date(now() + 24 * 3600e3).toISOString(),
        resumeKey,
        resumed: !resumeKey,
        resumeLost,
        preview: !!b.previewSession,
      },
      headers
    );
  }
  // Э6: редирект подписанной ссылки на ролик — без visitor-token (его
  // открывает <video> iframe), подпись в моке — форма токена.
  if (req.method === 'GET' && p.startsWith('/widget/v1/video/')) {
    if (!/^\/widget\/v1\/video\/v1\.[A-Za-z0-9_.-]+$/.test(p))
      return fail(res, 404, 'VIDEO_UNAVAILABLE');
    M.videoRedirects++;
    res.writeHead(302, {
      Location: `${WIDGET}/__media/tutorial.wav`,
      'Cache-Control': 'private, no-store',
      'Referrer-Policy': 'no-referrer',
    });
    return res.end();
  }
  const tok = auth(req);
  if (p.startsWith('/widget/v1/') && !tok) {
    return fail(
      res,
      401,
      req.headers['x-assist-visitor'] ? 'SESSION_EXPIRED' : 'SESSION_REQUIRED'
    );
  }
  if (!tokenOriginOk(req)) return fail(res, 403, 'ORIGIN_DENIED');
  const t = tok as Token;
  const mine = () =>
    M.convs
      .filter((c) => c.visitorId === t.visitorId && c.siteId === t.siteId)
      .sort((a, b) => b.lastMessageAt - a.lastMessageAt);
  // ── Э5: голос (упрощённо как assist-site-voice/public) ──
  if (req.method === 'POST' && p === '/widget/v1/voice') {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const bytes = Buffer.concat(chunks);
    const type = String(req.headers['content-type'] || '');
    M.voice.push({
      pk: t.pk,
      bytes: bytes.length,
      type,
      visitorId: t.visitorId,
    });
    const site = [...M.sites.values()].find((x) => x.siteId === t.siteId);
    const mode = site?.voiceMode ?? 'ok';
    if (!/^audio\//.test(type) || bytes.length < 512)
      return fail(res, 400, 'AUDIO_INVALID');
    if (mode === 'limit') return fail(res, 429, 'VOICE_LIMIT');
    if (mode === 'unavailable') return fail(res, 403, 'VOICE_UNAVAILABLE');
    if (mode === 'not_heard') return fail(res, 422, 'VOICE_NOT_HEARD');
    // Э6-бис: очередь фраз (команда, затем «стоп»/«так») — по одной на запись.
    const queued = site?.voiceTexts?.length
      ? site.voiceTexts.shift()
      : undefined;
    const text = queued ?? site?.voiceText ?? 'Скільки коштує доставка?';
    return ok(
      res,
      { text, lang: 'uk', voiceTicket: `v1.9999999999.${'T'.repeat(43)}` },
      { 'Cache-Control': 'no-store' }
    );
  }
  // ── Э6-бис: голосовое управление (ui-plan-mock.ts — настоящие проверки) ──
  if (
    p.startsWith('/widget/v1/ui-plan') ||
    p.startsWith('/widget/v1/voice-test')
  ) {
    const site = [...M.sites.values()].find((x) => x.siteId === t.siteId);
    const route = p.startsWith('/widget/v1/ui-plan')
      ? uiPlanRoute
      : voiceTestRoute;
    await route(
      req,
      p,
      t,
      site,
      async () => {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const raw = Buffer.concat(chunks).toString('utf8');
        let json: Record<string, unknown> = {};
        try {
          json = JSON.parse(raw || '{}');
        } catch {
          json = {};
        }
        return { raw, json };
      },
      M.vc,
      (status, body) => send(res, status, body, { 'Cache-Control': 'no-store' })
    );
    return;
  }
  // ── Э6: ссылка на ролик и сигнал «карта устарела» (упрощённо как
  // assist-widget/widget-media.controller.ts: барьеры сайта — sites-backend).
  if (req.method === 'POST' && p === '/widget/v1/video') {
    const b = await readBody(req);
    const videoId = typeof b.videoId === 'string' ? b.videoId : '';
    const ok_ = videoId === 'vid_ok';
    M.videoLinks.push({ pk: t.pk, videoId, ok: ok_ });
    if (!ok_) return fail(res, 404, 'VIDEO_UNAVAILABLE');
    return ok(
      res,
      {
        url: `/widget/v1/video/v1.${t.siteId}.${videoId}.9999999999.${'s'.repeat(43)}`,
        title: 'Как оформить заказ',
        expiresAt: new Date(now() + 600e3).toISOString(),
      },
      { 'Cache-Control': 'no-store' }
    );
  }
  if (
    req.method === 'POST' &&
    (p === '/widget/v1/highlight-miss' || p === '/widget/v1/highlight-seen')
  ) {
    const b = await readBody(req);
    if (
      typeof b.elementId !== 'string' ||
      !/^u[0-9a-f]{8}$/.test(b.elementId) ||
      typeof b.pageUrl !== 'string'
    )
      return fail(res, 400, 'BAD_REQUEST');
    (p === '/widget/v1/highlight-seen'
      ? M.highlightSeen
      : M.highlightMisses
    ).push({
      pk: t.pk,
      elementId: b.elementId,
      pageUrl: b.pageUrl,
    });
    return ok(res, { ok: true, recorded: true });
  }
  if (req.method === 'POST' && p === '/widget/v1/tts') {
    const b = await readBody(req);
    const id = typeof b.messageId === 'string' ? b.messageId : '';
    const site = [...M.sites.values()].find((x) => x.siteId === t.siteId);
    const own = mine().some((c) =>
      c.messages.some(
        (m) =>
          m.id === id && m.role !== 'visitor' && m.streamState === 'complete'
      )
    );
    M.tts.push({ pk: t.pk, messageId: id, ok: own });
    if (site?.voiceMode === 'limit') return fail(res, 429, 'VOICE_LIMIT');
    if (!own) return fail(res, 404, 'NOT_FOUND');
    res.writeHead(200, {
      'Content-Type': 'audio/mpeg',
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    return res.end(toneWav());
  }
  if (req.method === 'GET' && p === '/widget/v1/state') {
    const c = mine()[0];
    const fresh7 = c && now() - c.lastMessageAt < 7 * 24 * 3600e3;
    const since = url.searchParams.get('since');
    return ok(res, {
      conversation:
        c && fresh7
          ? {
              id: c.id,
              stateVersion: c.version,
              messages:
                since !== null && Number(since) === c.version
                  ? []
                  : c.messages.map(msgView),
              streamingMessageId:
                c.messages.find((m) => m.streamState === 'streaming')?.id ??
                null,
              lastMessageAt: new Date(c.lastMessageAt).toISOString(),
              handoff: c.handoff ?? null,
            }
          : null,
      previousConversationId: c && !fresh7 ? c.id : null,
    });
  }
  if (req.method === 'POST' && p === '/widget/v1/chat') {
    const b = await readBody(req);
    const q = typeof b.question === 'string' ? b.question : '';
    const crid = typeof b.clientRequestId === 'string' ? b.clientRequestId : '';
    if (!q || !crid) return fail(res, 400, 'BAD_REQUEST');
    if (q.length > 600) return fail(res, 400, 'QUESTION_TOO_LONG');
    // Функция/прокси оборвали поток до первого события (200 без meta).
    if (q.includes('__empty_stream__')) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      return res.end();
    }
    const owned = mine().find((c) => c.id === b.conversationId);
    // Э3 (упрощённо как H): открытая передача — вопрос уходит человеку, модели нет.
    if (
      owned &&
      owned.handoff &&
      (owned.handoff.state === 'waiting' || owned.handoff.state === 'active')
    ) {
      owned.messages.push({
        id: rid('m_'),
        role: 'visitor',
        text: q,
        sources: [],
        actions: [],
        streamState: 'complete',
        rating: null,
        createdAt: new Date(now()).toISOString(),
        crid,
      });
      touch(owned);
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(
        `event: handoff\ndata: ${JSON.stringify({ type: 'handoff', state: owned.handoff.state, relayed: true })}\n\n`
      );
      return res.end(`event: done\ndata: {}\n\n`);
    }
    let conv = owned;
    let answer: Msg | undefined;
    let replay = false;
    // Идемпотентность — только в диалоге ЭТОГО посетителя (§4-бис.4).
    if (owned) {
      const vi = owned.messages.findIndex(
        (m) => m.crid === crid && m.role === 'visitor'
      );
      if (vi >= 0) {
        answer = owned.messages[vi + 1];
        replay = true;
      }
    }
    if (!answer) {
      if (!conv) {
        conv = {
          id: rid('c_'),
          siteId: t.siteId,
          visitorId: t.visitorId,
          version: 0,
          messages: [],
          lastMessageAt: now(),
          openedBy: typeof b.openedBy === 'string' ? b.openedBy : null,
        };
        M.convs.push(conv);
      }
      const v: Msg = {
        id: rid('m_'),
        role: 'visitor',
        text: q,
        sources: [],
        actions: [],
        streamState: 'complete',
        rating: null,
        createdAt: new Date(now()).toISOString(),
        crid,
      };
      answer = {
        id: rid('m_'),
        role: 'assistant',
        text: '',
        sources: [],
        actions: [],
        streamState: 'streaming',
        rating: null,
        createdAt: new Date(now()).toISOString(),
      };
      conv.messages.push(v, answer);
      touch(conv);
      M.modelCalls.push({
        crid,
        question: q,
        page: b.page,
        context: b.context,
        uiLang: b.uiLang,
        openedBy: b.openedBy ?? null,
        voiceTicket: b.voiceTicket ?? null,
      });
      const err = /error:([a-z_]+)/.exec(q);
      if (err) {
        conv.messages.pop();
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(
          `event: meta\ndata: ${JSON.stringify({ conversationId: conv.id, messageId: answer.id, replay: false })}\n\n`
        );
        res.end(
          `event: error\ndata: ${JSON.stringify({ code: err[1], message: 'x' })}\n\n`
        );
        return;
      }
      generate(conv, answer, q, t.parentOrigin);
    }
    const c = conv as Conv;
    const a = answer as Msg;
    if (String(req.headers.accept).includes('application/json')) {
      while (a.streamState === 'streaming') await waitChange(a.id, 10000);
      return ok(res, {
        conversationId: c.id,
        messageId: a.id,
        text: a.text,
        sources: a.sources,
        actions: a.actions,
        refused: false,
        streaming: false,
      });
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.write(
      `event: meta\ndata: ${JSON.stringify({ conversationId: c.id, messageId: a.id, replay })}\n\n`
    );
    let sent = 0;
    let closed = false;
    res.on('close', () => (closed = true));
    for (;;) {
      if (closed) return; // генерация продолжается без нас
      if (a.text.length > sent) {
        res.write(
          `event: token\ndata: ${JSON.stringify({ t: a.text.slice(sent) })}\n\n`
        );
        sent = a.text.length;
      }
      if (a.streamState !== 'streaming') break;
      await waitChange(a.id, 5000);
    }
    res.write(
      `event: sources\ndata: ${JSON.stringify({ items: a.sources })}\n\n`
    );
    res.write(
      `event: actions\ndata: ${JSON.stringify({ items: a.actions })}\n\n`
    );
    res.end(
      `event: done\ndata: ${JSON.stringify({ usage: { in: 1, out: 1, cached: 0 } })}\n\n`
    );
    return;
  }
  const sm = /^\/widget\/v1\/messages\/([A-Za-z0-9_-]+)\/stream$/.exec(p);
  if (req.method === 'GET' && sm) {
    const a = mine()
      .flatMap((c) => c.messages)
      .find((m) => m.id === sm[1]);
    if (!a) return fail(res, 404, 'NOT_FOUND');
    const from = Math.max(0, Number(url.searchParams.get('from')) || 0);
    if (a.streamState === 'streaming' && a.text.length <= from)
      await waitChange(a.id, 2000);
    const text = a.text.slice(from);
    return ok(res, {
      messageId: a.id,
      text,
      offset: from + text.length,
      streamState: a.streamState,
      sources: a.sources,
      actions: a.actions,
    });
  }
  if (req.method === 'POST' && p === '/widget/v1/lead') {
    const b = await readBody(req);
    if (b.consent !== true) return fail(res, 400, 'CONSENT_REQUIRED');
    M.leads.push(b);
    return ok(res, { ok: true });
  }
  if (req.method === 'POST' && p === '/widget/v1/handoff') {
    const b = await readBody(req);
    M.handoffs.push(b);
    const s = [...M.sites.values()].find((x) => x.siteId === t.siteId);
    const c = mine().find((x) => x.id === b.conversationId);
    if (!s || s.handoffMode === 'lead' || !c)
      return ok(res, {
        mode: 'lead',
        reason: c ? 'off_hours' : 'no_conversation',
      });
    if (
      c.handoff &&
      (c.handoff.state === 'waiting' || c.handoff.state === 'active')
    )
      return ok(res, {
        mode: 'human',
        handoff: c.handoff,
        etaMinutes: 4,
        existing: true,
      });
    c.handoff = {
      id: rid('h_'),
      state: 'waiting',
      requestedAt: new Date(now()).toISOString(),
      takenAt: null,
      timeoutAt: new Date(now() + 5 * 60_000).toISOString(),
    };
    return ok(res, {
      mode: 'human',
      handoff: c.handoff,
      etaMinutes: 4,
      existing: false,
    });
  }
  if (req.method === 'POST' && p === '/widget/v1/handoff/cancel') {
    const b = await readBody(req);
    const c = mine().find((x) => x.id === b.conversationId);
    if (!c) return fail(res, 404, 'NOT_FOUND');
    if (c.handoff && c.handoff.state === 'waiting') {
      c.handoff = { ...c.handoff, state: 'cancelled' };
      M.cancels++;
    }
    return ok(res, { ok: true });
  }
  if (req.method === 'POST' && p === '/widget/v1/feedback') {
    M.feedback.push(await readBody(req));
    return ok(res, { ok: true });
  }
  if (req.method === 'POST' && p === '/widget/v1/forget') {
    const before = M.convs.length;
    M.convs = M.convs.filter(
      (c) => !(c.visitorId === t.visitorId && c.siteId === t.siteId)
    );
    for (const [k, r] of M.resumes)
      if (r.visitorId === t.visitorId) M.resumes.delete(k);
    M.forgets++;
    return ok(
      res,
      { conversationsDeleted: before - M.convs.length },
      {
        'Set-Cookie': `${cookieName(
          [...M.sites.values()].find((x) => x.siteId === t.siteId)?.pk ?? ''
        )}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=None; Partitioned`,
      }
    );
  }
  return fail(res, 404, 'NOT_FOUND');
}

// ── прокси на настоящий sites-backend (интеграционный прогон) ─────────────

function proxy(req: http.IncomingMessage, res: http.ServerResponse) {
  const target = new URL(req.url || '/', BACKEND);
  const fwd = http.request(
    target,
    {
      method: req.method,
      headers: {
        ...req.headers,
        host: target.host,
        'x-forwarded-for': '127.0.0.1',
      },
    },
    (r) => {
      res.writeHead(r.statusCode || 502, r.headers);
      r.pipe(res);
    }
  );
  fwd.on('error', () => fail(res, 502, 'UPSTREAM'));
  req.pipe(fwd);
}

// ── origin виджета ─────────────────────────────────────────────────────────

const STATIC: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.woff2': 'font/woff2',
};

async function widgetServer(
  req: http.IncomingMessage,
  res: http.ServerResponse
) {
  const url = new URL(req.url || '/', WIDGET);
  const p = url.pathname;
  // Э7: сброс мока «Админки» (admin-mock.ts) — до общего control.
  if (p === '/__mock/admin-reset') {
    adminReset();
    adminVcReset();
    res.writeHead(204);
    return res.end();
  }
  // Э6-бис (б): голосовое управление «Админкой» — режим, «ответы модели»,
  // «дефект сервера», ссылка мастера (admin-vc-mock.ts).
  if (p === '/__mock/admin-vc') {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    let b: Record<string, unknown> = {};
    try {
      b = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    } catch {
      b = {};
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(adminVcSet(b)));
  }
  // Э8: журнал мока «Админки» (исполнения «Да» — для п.4 (б) §4-бис.10).
  if (p === '/__mock/admin-log') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    // Э6-бис (б): + планы, снимки и мастер голосового управления.
    return res.end(JSON.stringify({ ...adminLog(), vc: adminVcLog() }));
  }
  // Э6-тер: мок редактора голосовой карты (editor-mock.ts).
  if (p === '/__mock/editor-reset') {
    editorReset();
    res.writeHead(204);
    return res.end();
  }
  if (p === '/__mock/editor-link') {
    const b = (await readBody(req)) as { token?: string; origin?: string };
    editorLink(String(b.token || ''), String(b.origin || ''));
    res.writeHead(204);
    return res.end();
  }
  // Раунд исправлений захода 11: истечение сессий сотрудников и зоны «Админки».
  if (p === '/__mock/admin-expire') {
    adminExpire();
    res.writeHead(204);
    return res.end();
  }
  if (p === '/__mock/editor-zones') {
    const b = (await readBody(req)) as { deny?: string[]; allow?: string[] };
    editorZones(b.deny ?? [], b.allow ?? []);
    res.writeHead(204);
    return res.end();
  }
  if (p === '/__mock/editor-log') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(editorLog()));
  }
  if (p.startsWith('/__mock/')) return control(req, res, p);
  if (p === '/evil-frame.html') {
    // Страница ТОГО ЖЕ origin виджета, но не наш iframe: подделка source.
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(
      `<!doctype html><script>for (const s of ['closed','min']) parent.postMessage({ns:'v4c-widget',v:1,type:'ui-state',state:s}, '*');` +
        `parent.postMessage({ns:'v4c-widget',v:1,type:'unavailable',code:'ORIGIN_DENIED'}, '*');</script>`
    );
  }
  if (p === '/__media/tutorial.wav') {
    // Э6: «ролик» в моке — короткий звук (метаданные <video> читаются).
    res.writeHead(200, {
      'Content-Type': 'audio/wav',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    return res.end(toneWav(1));
  }
  if (p.startsWith('/v1/')) {
    // Э6-бис (Т-1 способ 2): тестовая сборка чанка голоса с хуком WebAudio —
    // только по флагу мока (боевая сборка хука не содержит).
    const testAudio =
      M.testAudio &&
      p === '/v1/voice.js' &&
      fs.existsSync(path.join(ROOT, 'dist-test/v1/voice.js'));
    const file = testAudio
      ? path.join(ROOT, 'dist-test/v1/voice.js')
      : path.join(ROOT, 'dist', path.normalize(p).replace(/^\/+/, ''));
    if (!file.startsWith(path.join(ROOT, 'dist')) || !fs.existsSync(file))
      return fail(res, 404, 'NOT_FOUND');
    res.writeHead(200, {
      'Content-Type': STATIC[path.extname(file)] || 'application/octet-stream',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    return res.end(fs.readFileSync(file));
  }
  // Э7: origin «Админки» (127.0.0.1:<порт>) — только /wa/v1/frame и
  // /assist-admin/v1/* (как `has host` в vercel.json); публичное — 404.
  if (isAdminHost(req))
    return adminRoute(req, res, url, `http://*.localhost:${SITE_PORT}`);
  // Э6-тер: origin панели редактора (127.0.0.2:<порт>) — только /we/v1/frame
  // и /editor/v1/* (как `has host` в vercel.json).
  if (isEditorHost(req))
    return editorRoute(req, res, url, `http://*.localhost:${SITE_PORT}`);
  if (BACKEND && (p.startsWith('/widget/v1/') || p.startsWith('/w/v1/')))
    return proxy(req, res);
  if (p === '/w/v1/frame') {
    const s = M.sites.get(url.searchParams.get('pk') || '');
    M.requests.push({
      method: 'GET',
      path: p,
      origin: null,
      hasVisitor: false,
      cookie: hasResumeCookie(req),
    });
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': frameCsp(s),
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Cache-Control': 'no-store',
    });
    return res.end(FRAME_HTML);
  }
  if (p.startsWith('/widget/v1/')) return api(req, res, url);
  return fail(res, 404, 'NOT_FOUND');
}

async function control(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  p: string
) {
  const b = req.method === 'POST' ? await readBody(req) : {};
  switch (p) {
    case '/__mock/reset':
      M = fresh();
      return ok(res, {});
    case '/__mock/site': {
      const pk = String(b.pk);
      M.sites.set(pk, defaultSite(pk, b as Partial<Site>));
      return ok(res, {});
    }
    case '/__mock/operator': {
      // Ответ оператора (H, вебхук-реплай) в последний диалог посетителя сайта pk.
      const s = M.sites.get(String(b.pk));
      const c = M.convs
        .filter((x) => s && x.siteId === s.siteId)
        .sort((x, y) => y.lastMessageAt - x.lastMessageAt)[0];
      if (!c) return fail(res, 404, 'NOT_FOUND');
      if (typeof b.state === 'string' && c.handoff)
        c.handoff = {
          ...c.handoff,
          state: b.state as Handoff['state'],
          takenAt: c.handoff.takenAt || new Date(now()).toISOString(),
        };
      if (typeof b.text === 'string') {
        if (c.handoff && c.handoff.state === 'waiting')
          c.handoff = {
            ...c.handoff,
            state: 'active',
            takenAt: new Date(now()).toISOString(),
          };
        c.messages.push({
          id: rid('m_'),
          role: 'operator',
          text: b.text,
          sources: [],
          actions: [],
          streamState: 'complete',
          rating: null,
          createdAt: new Date(now()).toISOString(),
        });
      }
      touch(c);
      return ok(res, { at: Date.now() });
    }
    case '/__mock/set':
      if (typeof b.clock === 'number') M.clock = b.clock;
      if (typeof b.tokenDelayMs === 'number') M.tokenDelayMs = b.tokenDelayMs;
      if (typeof b.sessionDelayMs === 'number')
        M.sessionDelayMs = b.sessionDelayMs;
      if (typeof b.testAudio === 'boolean') M.testAudio = b.testAudio;
      return ok(res, {});
    case '/__mock/log':
      return ok(res, {
        modelCalls: M.modelCalls,
        pings: M.pings,
        configHits: M.configHits,
        leads: M.leads,
        feedback: M.feedback,
        forgets: M.forgets,
        sessions: M.sessions,
        requests: M.requests,
        convs: M.convs.map((c) => ({
          id: c.id,
          visitorId: c.visitorId,
          messages: c.messages.length,
          openedBy: c.openedBy ?? null,
          handoff: c.handoff ?? null,
        })),
        events: M.events,
        goals: M.goals,
        goalCalls: M.goalCalls,
        ana: M.ana,
        handoffs: M.handoffs,
        cancels: M.cancels,
        picks: M.picks,
        voice: M.voice,
        tts: M.tts,
        videoLinks: M.videoLinks,
        videoRedirects: M.videoRedirects,
        highlightMisses: M.highlightMisses,
        highlightSeen: M.highlightSeen,
        vc: M.vc,
      });
  }
  return fail(res, 404, 'NOT_FOUND');
}

// ── «сайт заказчика» ───────────────────────────────────────────────────────

export interface StandSpec {
  pk: string;
  /** Атрибуты тега загрузчика (без data-site), например { 'data-position': 'top-left' }. */
  attrs?: Record<string, string>;
  csp?: string | null;
  /** Номер страницы MPA (1…5). */
  n?: number;
  lang?: string;
  theme?: 'light' | 'dark';
  /** Сниппет очереди до тега (внешний файл — работает под строгим CSP). */
  queue?: boolean;
  /** Своя кнопка #own → V4CAssist('open'). */
  ownButton?: boolean;
  /**
   * Контейнер inline #help-chat ('auto' — без заданной высоты, 'below' —
   * ниже первого экрана: отступ в stand.css, до разбора разметки).
   */
  container?: boolean | 'auto' | 'below';
  /** Чужая фиксированная помеха в правом нижнем углу. */
  obstacle?: boolean;
  /** Длинная страница (прокрутка). */
  long?: boolean;
  /** Без тега загрузчика (замер «без виджета»). */
  noWidget?: boolean;
  /** Э7: origin тега загрузчика (режим «Админка» — `http://127.0.0.1:<порт>`). */
  loaderOrigin?: string;
  /** iframe виджета напрямую, без загрузчика (проверка frame-ancestors). */
  directFrame?: boolean;
  /** Чужой iframe (другой origin), который шлёт поддельные сообщения. */
  evilFrame?: string;
  /** SPA-кнопки (History API). */
  spa?: boolean;
  /** Тяжёлый LCP-элемент (для замера CWV). */
  heavy?: boolean;
  /** Э3: элементы для целей и режима выбора (tel:, мессенджер, кнопки, формы, поле ввода). */
  goalsKit?: boolean;
  /**
   * Э6: кнопка для подсветки «показать на экране»: `v1` — `#cta-buy` (как в
   * карте интерфейса), `v2` — вёрстка сменилась (`#cta-order`), `dup` — два
   * элемента под одним селектором (неоднозначно — не подсвечиваем).
   */
  uiKit?: 'v1' | 'v2' | 'dup';
  /**
   * Э6-тер: элементы для редактора голосовой карты — «В кошик» с разметкой
   * (счётчик кликов сайта), ссылка, «Оплатити», кликабельный div без роли,
   * поле с ВВЕДЁННЫМ значением (не должно уйти в панель).
   */
  editorKit?: boolean;
  /** Аудит Э6-тер (3): ссылка с ПД в пути (`/u/<e-mail>/orders/<номер>`). */
  editorPdLink?: boolean;
  /** Э6-тер: «злой скрипт» шлёт поддельные сообщения пикеру и панели. */
  editorEvil?: boolean;
  /**
   * Э6-бис (б): страница админки — меню, таблица заказов с ПД клиентов и
   * «Видалити» в строках, форма «Нотатка/Статус/Зберегти» (счётчики
   * сохранений и удалений — snippets/admin-kit.js).
   */
  adminKit?: boolean;
}

export function encodeSpec(s: StandSpec): string {
  return Buffer.from(JSON.stringify(s)).toString('base64url');
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function standHtml(spec: StandSpec, host: string): string {
  const n = spec.n || 1;
  const link = (k: number) => `/page?s=${encodeSpec({ ...spec, n: k })}`;
  const attrs = Object.entries(spec.attrs || {})
    .map(([k, v]) => ` ${esc(k)}="${esc(v)}"`)
    .join('');
  const parts: string[] = [];
  parts.push(
    `<!doctype html><html lang="${esc(spec.lang || 'ru')}"${spec.theme ? ` data-theme="${spec.theme}"` : ''}><head>`
  );
  parts.push(
    `<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`
  );
  parts.push(
    `<title>Стенд ${n}</title><link rel="stylesheet" href="/stand.css"></head><body>`
  );
  parts.push(
    `<header class="top"><h1 id="h">Страница ${n} — ${esc(host)}</h1></header>`
  );
  if (spec.heavy)
    parts.push(
      `<img id="hero" src="/hero.png" width="800" height="300" alt="hero">`
    );
  parts.push(
    `<nav>${[1, 2, 3, 4, 5].map((k) => `<a id="p${k}" href="${link(k)}">стр. ${k}</a>`).join(' ')}</nav>`
  );
  parts.push(
    `<p>Обычный текст сайта заказчика. <a id="anchor" href="#v4c-assist">Спросить помощника</a></p>`
  );
  if (spec.ownButton)
    parts.push(`<button id="own" type="button">Наша кнопка помощи</button>`);
  if (spec.spa)
    parts.push(
      `<button id="spa-next" type="button">SPA: дальше</button><button id="spa-back" type="button">SPA: назад</button>`
    );
  if (spec.container)
    parts.push(
      `<div id="help-chat"${typeof spec.container === 'string' ? ` class="${esc(spec.container)}"` : ''}></div>`
    );
  if (spec.obstacle)
    parts.push(`<div id="cookie-banner">Мы используем cookie</div>`);
  if (spec.goalsKit)
    parts.push(
      `<p><a id="tel" href="tel:+380441234567">Позвонить</a> <a id="tg" href="https://t.me/shop_example">Telegram</a></p>` +
        `<p><button id="buy" type="button" data-assist-goal="buy">Купить</button> ` +
        `<button id="order" type="button">Оформить заказ</button> ` +
        `<a id="danger" href="/danger?s=${encodeSpec(spec)}">Опасная ссылка</a></p>` +
        `<form id="f-ok" action="/thanks" method="get"><input type="hidden" name="s" value="${encodeSpec(spec)}"><input id="field" name="q" placeholder="Поле"><button id="send" type="submit">Отправить</button></form>` +
        `<form id="f-pd" data-assist-goal-submit="sub"><button id="send-pd" type="submit">Подписаться</button></form>` +
        `<div id="editable" contenteditable="true">Редактируемый текст</div><div id="clicked"></div>`
    );
  if (spec.uiKit === 'v1')
    parts.push(
      `<div class="long-top"></div><p class="price">1 500 грн <button id="cta-buy" type="button">Купить</button></p>`
    );
  if (spec.uiKit === 'v2')
    parts.push(
      `<p class="price">1 500 грн <button id="cta-order" type="button">Оформить</button></p>`
    );
  if (spec.uiKit === 'dup')
    parts.push(
      `<p><button id="cta-buy" type="button">Купить</button><button id="cta-buy" type="button">Купить 2</button></p>`
    );
  if (spec.editorKit)
    parts.push(
      `<section id="ed-kit"><h2>Футболка синя</h2>` +
        `<button id="ed-cart" type="button" data-assist-id="add-to-cart">В кошик</button> ` +
        `<a id="ed-delivery" href="/page?s=${encodeSpec({ ...spec, n: 2 })}">Доставка</a> ` +
        `<button id="ed-pay" type="button">Оплатити</button> ` +
        `<div id="ed-div" class="clicky">Іконка кошика</div>` +
        `<input id="ed-email" name="email" value="owner.secret@example.com"> ` +
        (spec.editorPdLink
          ? `<a class="ed-profile" href="/u/ivan.petrenko@example.com/orders/123456789012">Мій кабінет</a> `
          : '') +
        `<span id="ed-clicks">0</span></section>`
    );
  if (spec.adminKit)
    parts.push(
      `<nav id="ak-nav"><a href="${link(1)}">Замовлення</a> <a href="${link(2)}">Клієнти</a></nav>` +
        `<table id="ak-table"><tr><th>№</th><th>Клієнт</th><th>Дії</th></tr>` +
        `<tr><td>1042</td><td><a href="#c1">Іван Петренко</a></td><td><button type="button" class="ak-del">Видалити</button> <a href="#o1042">Деталі 1042</a></td></tr>` +
        `<tr><td>1043</td><td><a href="#c2">Олена Коваль</a></td><td><button type="button" class="ak-del">Видалити</button> <a href="#o1043">Деталі 1043</a></td></tr></table>` +
        `<p><button id="ak-del-all" type="button" class="ak-del">Видалити вибрані</button></p>` +
        // Аудит Э6-бис (б): голый глагол, иконка с подписью внутри, ссылка
        // с действием в адресе, список клиентов `li` вне навигации.
        `<p><button id="ak-cancel" type="button" class="ak-del">Скасувати</button> <button id="ak-icon" type="button" class="ak-del">⋯<i title="Видалити"></i></button> <a id="ak-link-del" class="ak-del" href="/admin/orders/1042/delete">Деталі замовлення</a></p>` +
        `<ul id="ak-list"><li><a href="#c3">Петро Сидоренко</a></li></ul>` +
        `<form id="ak-auto-form" action="/admin/autosave" method="get"><label>Пріоритет <select id="ak-prio" name="prio"><option>Звичайний</option><option>Високий</option></select></label></form>` +
        `<form id="ak-form"><label>Нотатка <input id="ak-note" name="note"></label> <label>Коментар <input id="ak-comment" name="comment"></label> <label>Місто <input id="ak-city" name="city"></label> <button id="ak-save" type="submit">Зберегти</button></form>` +
        `<p>Збережено: <span id="ak-saves">0</span>, видалено: <span id="ak-deletes">0</span></p>`
    );
  if (spec.long) parts.push(`<div class="long">длинная страница</div>`);
  if (spec.evilFrame)
    parts.push(
      `<iframe id="evil" src="${esc(spec.evilFrame)}" width="10" height="10"></iframe>`
    );
  if (spec.directFrame)
    parts.push(
      `<iframe id="direct" src="${WIDGET}/w/v1/frame?pk=${encodeURIComponent(spec.pk)}" width="380" height="500"></iframe>`
    );
  if (spec.queue) parts.push(`<script src="/snippets/queue.js"></script>`);
  if (spec.ownButton) parts.push(`<script src="/snippets/own.js"></script>`);
  if (spec.spa) parts.push(`<script src="/snippets/spa.js"></script>`);
  if (spec.goalsKit) parts.push(`<script src="/snippets/goals.js"></script>`);
  if (spec.editorKit)
    parts.push(`<script src="/snippets/editor-kit.js"></script>`);
  if (spec.editorEvil)
    parts.push(`<script src="/snippets/editor-evil.js"></script>`);
  if (spec.adminKit)
    parts.push(`<script src="/snippets/admin-kit.js"></script>`);
  if (!spec.noWidget && !spec.directFrame)
    parts.push(
      `<script async src="${spec.loaderOrigin && /^http:\/\/127\.0\.0\.1:\d+$/.test(spec.loaderOrigin) ? spec.loaderOrigin : WIDGET}/v1/loader.js" data-site="${esc(spec.pk)}"${attrs}></script>`
    );
  parts.push(`</body></html>`);
  return parts.join('\n');
}

const SNIPPETS: Record<string, string> = {
  // Э6-тер: действие сайта на «В кошик» — счётчик (выбор в редакторе его не трогает).
  '/snippets/editor-kit.js':
    "window.__siteClicks=0;document.getElementById('ed-cart').addEventListener('click',function(){window.__siteClicks++;document.getElementById('ed-clicks').textContent=String(window.__siteClicks);});document.getElementById('ed-div').style.cursor='pointer';",
  // Э6-тер: злой скрипт страницы — поддельные pick/ops/publish/exit всем окнам.
  '/snippets/editor-evil.js':
    "(function(){var m=function(o){o.ns='v4c-editor';o.v=1;return o;};var d={tag:'button',role:'button',text:'Оплатити',assistId:'add-to-cart',unique:true};setInterval(function(){var t=[window];for(var i=0;i<window.frames.length;i++)t.push(window.frames[i]);t.forEach(function(w){try{w.postMessage(m({type:'pick',descriptor:d,how:'assist-id',stability:'strong',never:false,crumbs:[]}),'*');w.postMessage(m({type:'ops',expectedRevision:0,ops:[{op:'upsert-target',target:{key:'evil',descriptor:d,names:{uk:'В кошик'}}}]}),'*');w.postMessage(m({type:'publish-request'}),'*');w.postMessage(m({type:'exit'}),'*');w.postMessage(m({type:'targets',items:[]}),'*');}catch(e){}});},150);})();",
  // Э6-бис (б): «сохранение» формы админки (AJAX) и «удаление» — счётчики.
  '/snippets/admin-kit.js':
    "document.getElementById('ak-form').addEventListener('submit',function(e){e.preventDefault();var s=document.getElementById('ak-saves');s.textContent=String(Number(s.textContent)+1);});" +
    "document.querySelectorAll('.ak-del').forEach(function(b){b.addEventListener('click',function(e){if(b.tagName==='A')e.preventDefault();var d=document.getElementById('ak-deletes');d.textContent=String(Number(d.textContent)+1);});});" +
    // Автосохранение старых админок: `form.submit()` в `onchange` (без события submit).
    "document.getElementById('ak-prio').addEventListener('change',function(){this.form.submit();});",
  '/snippets/queue.js':
    'window.V4CAssist = window.V4CAssist || function(){(V4CAssist.q=V4CAssist.q||[]).push(arguments)};',
  '/snippets/own.js':
    "document.getElementById('own').addEventListener('click', function(){ window.V4CAssist('open'); });",
  // Форма с preventDefault сайта (AJAX) и «действие сайта» на кнопке — для режима выбора.
  '/snippets/goals.js':
    "document.getElementById('f-pd').addEventListener('submit',function(e){e.preventDefault();document.getElementById('clicked').textContent='ajax';});" +
    "document.getElementById('order').addEventListener('click',function(){document.getElementById('clicked').textContent='order';});",
  '/snippets/spa.js':
    "var k=1;document.getElementById('spa-next').addEventListener('click',function(){k++;history.pushState({k:k},'','/spa/'+k);document.title='SPA '+k;document.getElementById('h').textContent='SPA '+k;});" +
    "document.getElementById('spa-back').addEventListener('click',function(){history.back();});",
};

const STAND_CSS = `body{font-family:Georgia,serif;margin:0;padding:16px}nav a{margin-right:8px}
#help-chat{width:420px;height:520px;border:1px solid #ccc}#help-chat.auto{height:auto}#help-chat.below{margin-top:3000px}
#cookie-banner{position:fixed;right:0;bottom:0;width:100%;height:90px;background:#333;color:#fff;z-index:2147483647}
.long{height:3000px}#hero{display:block;max-width:100%}.long-top{height:1400px}`;

function siteServer(req: http.IncomingMessage, res: http.ServerResponse) {
  const host = req.headers.host || 'localhost';
  const url = new URL(req.url || '/', `http://${host}`);
  const p = url.pathname;
  // Э6-бис: стенды голосового управления (React/Vue/jQuery/MPA, полигон).
  if (p.startsWith('/vc/'))
    return void vcStandRoute(req, res, url, host, WIDGET);
  if (p === '/stand.css') {
    res.writeHead(200, { 'Content-Type': 'text/css' });
    return res.end(STAND_CSS);
  }
  if (p === '/hero.png') {
    res.writeHead(200, { 'Content-Type': 'image/png' });
    return res.end(PNG);
  }
  if (SNIPPETS[p]) {
    res.writeHead(200, { 'Content-Type': 'text/javascript' });
    return res.end(SNIPPETS[p]);
  }
  if (p === '/evil.html') {
    // Чужой origin внутри страницы: пытается командовать и загрузчиком (parent), и iframe чата.
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(
      `<!doctype html><script>
      const m = (o) => Object.assign({ns:'v4c-widget',v:1}, o);
      setInterval(() => {
        parent.postMessage(m({type:'ui-state',state:'closed'}), '*');
        parent.postMessage(m({type:'unavailable',code:'ORIGIN_DENIED'}), '*');
        const targets = [];
        for (let i = 0; i < parent.frames.length; i++) targets.push(parent.frames[i]);
        // Окно того же origin, что страница, достаёт iframe чата через открытый shadowRoot
        // (iframe в Shadow DOM нет в window.frames); чужому origin это недоступно.
        try {
          parent.document.querySelectorAll('[data-v4c]').forEach((h) => {
            const f = h.shadowRoot && h.shadowRoot.querySelector('iframe');
            if (f) targets.push(f.contentWindow);
          });
        } catch (e) {}
        for (const t of targets) {
          try { t.postMessage(m({type:'ask',question:'ВНЕДРЁННЫЙ ВОПРОС'}), '*'); } catch (e) {}
        }
      }, 200);
      </script>`
    );
  }
  if (
    p === '/page' ||
    p.startsWith('/spa/') ||
    p === '/thanks' ||
    p === '/danger' ||
    p.startsWith('/checkout/') ||
    p.startsWith('/product/')
  ) {
    let spec: StandSpec;
    try {
      spec = JSON.parse(
        Buffer.from(url.searchParams.get('s') || '', 'base64url').toString(
          'utf8'
        )
      );
    } catch {
      return fail(res, 400, 'BAD_SPEC');
    }
    const h: Record<string, string> = {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    };
    if (spec.csp)
      h['Content-Security-Policy'] = spec.csp.replace(/\{W\}/g, WIDGET);
    res.writeHead(200, h);
    return res.end(standHtml(spec, host));
  }
  res.writeHead(404);
  res.end();
}

export function start(): Promise<() => void> {
  const a = http.createServer((q, r) => void widgetServer(q, r));
  const b = http.createServer(siteServer);
  return new Promise((resolve) => {
    let n = 0;
    const done = () => ++n === 2 && resolve(() => (a.close(), b.close()));
    a.listen(WIDGET_PORT, done);
    b.listen(SITE_PORT, done);
  });
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  void start().then(() =>
    console.log(
      `стенд: виджет ${WIDGET}, сайт http://*.localhost:${SITE_PORT}${BACKEND ? `, API → ${BACKEND}` : ' (мок W2)'}`
    )
  );
}
