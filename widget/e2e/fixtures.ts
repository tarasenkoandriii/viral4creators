/**
 * Общие помощники e2e: управление моком W2, адреса стендов, доступ к
 * кнопке (Shadow DOM — Playwright CSS проникает в открытый shadow) и к
 * iframe чата.
 */
import { expect, test, type Page, type FrameLocator } from '@playwright/test';
import { encodeSpec, type StandSpec } from './stand/server';
import {
  WIDGET_MESSAGE_NS,
  WIDGET_PROTOCOL_VERSION,
  WIDGET_STORAGE_PREFIX,
  WIDGET_CHANNEL_PREFIX,
} from '../src/shared/brand';

export {
  WIDGET_MESSAGE_NS,
  WIDGET_PROTOCOL_VERSION,
  WIDGET_STORAGE_PREFIX,
  WIDGET_CHANNEL_PREFIX,
};
export const WIDGET = 'http://localhost:5181';
export const SITE_PORT = 5182;
export const INTEGRATION = !!process.env.WIDGET_E2E_BACKEND;

export const origin = (host: string) => `http://${host}:${SITE_PORT}`;
export const A = origin('example.localhost');
export const SHOP = origin('shop.example.localhost');
export const OTHER = origin('other.localhost');

let seq = 0;
/** Уникальный pk на тест (мок изолирует состояние по сайту). */
export function newPk(): string {
  seq++;
  return `pk_live_e2e${Date.now().toString(36)}${seq}`;
}

export async function mock(path: string, body: unknown = {}) {
  // Интеграционный прогон (настоящий sites-backend): управления моком нет —
  // такие тесты пропускаются, проверку даёт e2e/integration.spec.ts.
  test.skip(INTEGRATION, 'только на моке W2');
  const r = await fetch(`${WIDGET}/__mock/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`mock ${path}: ${r.status}`);
}

export interface MockLog {
  modelCalls: Array<{
    crid: string;
    question: string;
    page: { url: string | null; title: string | null };
    context: unknown;
    uiLang: unknown;
    openedBy?: string | null;
    voiceTicket?: string | null;
  }>;
  pings: Array<{ pk: string; v: string; c: string }>;
  configHits: string[];
  leads: Array<Record<string, unknown>>;
  feedback: Array<Record<string, unknown>>;
  forgets: number;
  sessions: Array<{
    parentOrigin: string;
    resumed: boolean;
    resumeLost: boolean;
    cookie: boolean;
    body: boolean;
    visitorId: string;
  }>;
  requests: Array<{
    method: string;
    path: string;
    origin: string | null;
    hasVisitor: boolean;
    cookie: boolean;
  }>;
  convs: Array<{
    id: string;
    visitorId: string;
    messages: number;
    openedBy: string | null;
    handoff: { id: string; state: string } | null;
  }>;
  // Э3
  events: Array<{
    pk: string;
    origin: string | null;
    contentType: string;
    events: Array<{ kind: string; key: string | null }>;
  }>;
  goals: Array<Record<string, unknown>>;
  goalCalls: number;
  handoffs: Array<Record<string, unknown>>;
  cancels: number;
  picks: Array<Record<string, unknown>>;
  // Э5
  voice: Array<{ pk: string; bytes: number; type: string; visitorId: string }>;
  tts: Array<{ pk: string; messageId: string; ok: boolean }>;
}

export async function log(): Promise<MockLog> {
  const r = await fetch(`${WIDGET}/__mock/log`, { method: 'POST' });
  return ((await r.json()) as { data: MockLog }).data;
}

export interface SiteOpts {
  allowedOrigins?: string[];
  status?: 'active' | 'lead_only' | 'off';
  config?: Record<string, unknown>;
  hosts?: Array<{ origin: string; pathMasks?: string[]; hideOn?: string[] }>;
  allowClientPreview?: boolean;
  previewTokens?: Record<string, Record<string, unknown>>;
  unpublished?: boolean;
  // Э3
  engagement?: unknown;
  goals?: unknown;
  handoff?: unknown;
  handoffMode?: 'human' | 'lead';
  pickerTokens?: Record<string, string>;
  // Э5
  voice?: unknown;
  voiceMode?: 'ok' | 'limit' | 'not_heard' | 'unavailable';
  voiceText?: string;
}

/** Сайт в моке: по умолчанию разрешён A и SHOP (verified-хосты одного сайта). */
export async function site(pk: string, o: SiteOpts = {}) {
  const allowed = o.allowedOrigins ?? [A, SHOP];
  await mock('site', {
    pk,
    allowedOrigins: allowed,
    status: o.status ?? 'active',
    config: o.config ?? {},
    hosts: (o.hosts ?? allowed.map((x) => ({ origin: x }))).map((h) => ({
      pathMasks: [],
      hideOn: [],
      ...h,
    })),
    allowClientPreview: o.allowClientPreview ?? false,
    previewTokens: o.previewTokens ?? {},
    unpublished: o.unpublished ?? false,
    engagement: o.engagement,
    goals: o.goals,
    handoff: o.handoff,
    handoffMode: o.handoffMode ?? 'human',
    pickerTokens: o.pickerTokens ?? {},
    voice: o.voice,
    voiceMode: o.voiceMode,
    voiceText: o.voiceText,
  });
}

/**
 * Аналитика в Playwright выключена сама: `navigator.webdriver === true`
 * (§5-тер.1, наши воркеры/QA). Тестам целей и счётчиков — «обычный» браузер.
 */
export async function humanBrowser(page: Page) {
  await page.addInitScript(() =>
    Object.defineProperty(Navigator.prototype, 'webdriver', {
      get: () => false,
    })
  );
}

/** Все счётчики событий из пакетов загрузчика (вид:ключ). */
export async function eventKinds(): Promise<string[]> {
  return (await log()).events.flatMap((b) =>
    b.events.map((e) => (e.key ? `${e.kind}:${e.key}` : e.kind))
  );
}

export function stand(host: string, spec: StandSpec, path = '/page'): string {
  return `${origin(host)}${path}?s=${encodeSpec(spec)}`;
}

export const launcher = (page: Page) => page.locator('[data-v4c] button.l');
export const panel = (page: Page) =>
  page.locator('[data-v4c] .p, [data-v4c] .I').first();
export const frameEl = (page: Page) => page.locator('[data-v4c] iframe');
export const chat = (page: Page): FrameLocator =>
  page.frameLocator('[data-v4c] iframe');

/** Открыть чат кнопкой и дождаться готовности ленты. */
export async function openChat(page: Page) {
  await launcher(page).click();
  await expect(chat(page).locator('.cmp textarea')).toBeEnabled();
}

export async function ask(page: Page, q: string) {
  const ta = chat(page).locator('.cmp textarea');
  await ta.fill(q);
  await ta.press('Enter');
}

/** Последний ответ помощника дописан (есть оценка 👍/👎). */
export async function waitAnswer(page: Page, n = 1) {
  await expect(chat(page).locator('.msg.bot .fb')).toHaveCount(n, {
    timeout: 20_000,
  });
}
