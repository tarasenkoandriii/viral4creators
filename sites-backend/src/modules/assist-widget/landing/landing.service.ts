/**
 * Лендинг — W2: события (INSERT под assist_public, ipHash суточный,
 * лимит на ipHash в минуту), снимок тарифов, анонимные черновики вида
 * («к Л3»: parseWidgetConfig W4 без hosts/картинок, ≤ 2 КБ, ≤ 10 в сутки
 * на ipHash, id 128 бит). Атрибуция кабинета — cabinet/acquisition.*
 * (основная роль). Origin — ASSIST_LANDING_ORIGINS (фильтр, не
 * защита; как песочница Э1).
 *
 * Запись — `createMany` (INSERT без RETURNING): SELECT на эти таблицы у
 * роли нет и не нужен. Лимит черновиков считают окна assist_rate_buckets
 * (`landing-draft-ip-day`), а не COUNT по таблице, которую роль не видит.
 */
import { Injectable, Logger } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { LANDING_DEFAULTS } from '../../../config/assist-defaults';
import { widgetIpSecret } from '../../../config/widget-env';
import { AssistPublicDb } from '../../../prisma/assist-public-db.service';
import { hashIpWithDailySalt } from '../../../shared/assist-chat-core';
import {
  ipLimitKey,
  landingOriginAllowed,
} from '../../assist-sandbox/sandbox-limits';
import { parseWidgetConfig } from '../../assist-site-setup/widget-config';
import { WidgetRateLimit } from '../rate-limit';
import { widgetError } from '../widget-errors';
import { publicPlans } from '../../assist-billing/plans';
import {
  DIALOG_IDLE_MS,
  DIALOG_WEIGHT_STEPS,
  PUBLIC_DIALOG_WEIGHTS,
} from '../../assist-billing/units';
import type {
  AssistPlansResponse,
  LandingEventBatch,
  WidgetDraftCreated,
} from './landing-types';

const DAY = 24 * 60 * 60 * 1000;

const NAME_RE = /^[a-z0-9_.-]{1,64}$/;
const PROP_KEY_RE = /^[A-Za-z0-9_.-]{1,40}$/;
const VARIANT_RE = /^[A-Za-z0-9_.-]{1,32}$/;
const MAX_PROPS = 20;
const MAX_PROP_CHARS = 200;
const MAX_PATH_CHARS = 200;

type LandingEvent = LandingEventBatch['events'][number];

/** Путь страницы без query и якоря (§6.6): в query бывают токены и e-mail. */
export function cleanLandingPath(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw.startsWith('/')) return null;
  const path = raw.split(/[?#]/, 1)[0];
  if (!path || path.length > MAX_PATH_CHARS || /[\s<>"']/.test(path)) {
    return null;
  }
  return path;
}

/**
 * Одно событие → строка для базы или null (мусор — отбрасывается, батч
 * при этом принимается: одна битая метрика не должна терять остальные).
 */
export function cleanLandingEvent(raw: unknown): LandingEvent | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.name !== 'string' || !NAME_RE.test(o.name)) return null;
  const out: LandingEvent = { name: o.name };
  if (o.props !== undefined) {
    if (!o.props || typeof o.props !== 'object' || Array.isArray(o.props)) {
      return null;
    }
    const entries = Object.entries(o.props as Record<string, unknown>);
    if (entries.length > MAX_PROPS) return null;
    const props: Record<string, string | number | boolean> = {};
    for (const [k, v] of entries) {
      if (!PROP_KEY_RE.test(k)) return null;
      if (typeof v === 'string') {
        if (v.length > MAX_PROP_CHARS) return null;
        props[k] = v;
      } else if (typeof v === 'number' && Number.isFinite(v)) {
        props[k] = v;
      } else if (typeof v === 'boolean') {
        props[k] = v;
      } else {
        return null;
      }
    }
    out.props = props;
  }
  if (o.locale !== undefined) {
    if (o.locale !== 'uk' && o.locale !== 'ru' && o.locale !== 'en') {
      return null;
    }
    out.locale = o.locale;
  }
  if (o.variant !== undefined) {
    if (typeof o.variant !== 'string' || !VARIANT_RE.test(o.variant)) {
      return null;
    }
    out.variant = o.variant;
  }
  if (o.path !== undefined) {
    const path = cleanLandingPath(o.path);
    if (path === null) return null;
    out.path = path;
  }
  return out;
}

@Injectable()
export class LandingService {
  private readonly logger = new Logger(LandingService.name);

  constructor(
    private readonly db: AssistPublicDb,
    private readonly rate: WidgetRateLimit,
  ) {}

  /** Суточный хеш IP лендинга (своя метка поверх соли виджета). */
  private ipHash(ip: string, now: Date): string {
    const secret = widgetIpSecret();
    if (!secret) throw widgetError('BAD_REQUEST');
    return hashIpWithDailySalt(ipLimitKey(ip), `${secret}:landing`, now);
  }

  async recordEvents(p: {
    body: LandingEventBatch;
    ip: string;
    origin: string | undefined;
    now?: Date;
  }): Promise<{ accepted: number }> {
    const now = p.now ?? new Date();
    if (!landingOriginAllowed(p.origin, process.env)) {
      throw widgetError('ORIGIN_DENIED');
    }
    const body = p.body as unknown;
    const raw =
      body && typeof body === 'object' && !Array.isArray(body)
        ? (body as Record<string, unknown>).events
        : undefined;
    if (
      !Array.isArray(raw) ||
      raw.length === 0 ||
      raw.length > LANDING_DEFAULTS.eventsPerBatch ||
      Buffer.byteLength(JSON.stringify(body)) >
        LANDING_DEFAULTS.eventBodyMaxBytes
    ) {
      throw widgetError('BAD_REQUEST');
    }
    const ipHash = this.ipHash(p.ip, now);
    await this.rate.enforce(
      [
        {
          scope: 'landing-event-ip-min',
          key: ipHash,
          limit: LANDING_DEFAULTS.eventBatchesPerMinute,
          windowMs: 60_000,
        },
      ],
      now,
    );
    const events = raw
      .map(cleanLandingEvent)
      .filter((e): e is LandingEvent => e !== null);
    if (events.length) {
      await this.db.assistLandingEvent.createMany({
        data: events.map((e) => ({
          name: e.name,
          props: e.props ?? undefined,
          locale: e.locale ?? null,
          variant: e.variant ?? null,
          path: e.path ?? null,
          ipHash,
          createdAt: now,
        })),
      });
    }
    return { accepted: events.length };
  }

  /** Э4: живые тарифы (было — файл-снимок до Э4). */
  plans(): AssistPlansResponse {
    return publicPlans({
      idleCloseMinutes: DIALOG_IDLE_MS / 60_000,
      weightSteps: DIALOG_WEIGHT_STEPS,
      weights: PUBLIC_DIALOG_WEIGHTS,
    });
  }

  /** «к Л3» */
  async createWidgetDraft(p: {
    config: unknown;
    ip: string;
    origin: string | undefined;
    now?: Date;
  }): Promise<WidgetDraftCreated> {
    const now = p.now ?? new Date();
    if (!landingOriginAllowed(p.origin, process.env)) {
      throw widgetError('ORIGIN_DENIED');
    }
    const c = p.config;
    if (
      !c ||
      typeof c !== 'object' ||
      Array.isArray(c) ||
      Buffer.byteLength(JSON.stringify(c)) >
        LANDING_DEFAULTS.widgetDraftMaxBytes
    ) {
      throw widgetError('BAD_REQUEST');
    }
    const input = c as Record<string, unknown>;
    // Хосты — свойство кабинета и сайта, у анонимного черновика их нет.
    if (Array.isArray(input.hosts) && input.hosts.length > 0) {
      throw widgetError('BAD_REQUEST');
    }
    const ipKey = this.ipHash(p.ip, now);
    await this.rate.enforce(
      [
        {
          scope: 'landing-draft-ip-day',
          key: ipKey,
          limit: LANDING_DEFAULTS.widgetDraftsPerIpPerDay,
          windowMs: DAY,
        },
      ],
      now,
    );
    const parsed = parseWidgetConfig({ ...input, hosts: [] });
    if (!parsed.ok) {
      throw widgetError('BAD_REQUEST', {
        message: 'Конфигурация вида не прошла проверку',
      });
    }
    const brand = parsed.config.brand;
    // Картинок у анонимного черновика нет (логотип — только в кабинете).
    if (brand.logoAssetId !== null || brand.avatar.kind === 'asset') {
      throw widgetError('BAD_REQUEST');
    }
    const { hosts: _hosts, ...config } = parsed.config;
    const id = randomBytes(16).toString('base64url');
    const expiresAt = new Date(
      now.getTime() + LANDING_DEFAULTS.widgetDraftTtlMs,
    );
    await this.db.assistWidgetDraft.createMany({
      data: [
        {
          id,
          config: config as object,
          ipKey,
          expiresAt,
          createdAt: now,
        },
      ],
    });
    this.logger.log('widget draft created');
    return { id, expiresAt: expiresAt.toISOString() };
  }
}
