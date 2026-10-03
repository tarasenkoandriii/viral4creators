/**
 * Лимиты частоты в Postgres (ТЗ §4.13 п.2–3) — W2: окно — строка `bucket`
 * в assist_rate_buckets, одним запросом `INSERT … ON CONFLICT DO UPDATE SET
 * count = count + 1 WHERE count < :limit RETURNING count` (нет строки в
 * ответе — лимит). Под ролью assist_public. Ключи — хеши (ipHash сайта,
 * visitorId), сырого IP в базе нет.
 *
 * Окна фиксированные (начало окна = floor(now / windowMs)), `bucket` —
 * ISO-время начала окна; `expiresAt` — конец окна (строки снимает ретенция
 * W3). Параллельные запросы сериализует блокировка строки в ON CONFLICT —
 * лимит не проскакивает (тот же приём, что счётчики песочницы Э1).
 */
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AssistPublicDb } from '../../prisma/assist-public-db.service';
import { widgetError } from './widget-errors';

export type RateScope =
  | 'widget-session-ip'
  | 'widget-msg-visitor-min'
  | 'widget-msg-visitor-hour'
  | 'widget-msg-visitor-day'
  | 'widget-msg-ip-site-min'
  | 'widget-lead-visitor-hour'
  // Э3:
  | 'widget-handoff-visitor-hour'
  | 'widget-event-ip-min'
  | 'widget-goal-ip-min'
  | 'widget-picker-ip-min'
  | 'landing-event-ip-min'
  | 'landing-draft-ip-day'
  // Э5: голос посетителя (распознавание и озвучка) — в минуту и в сутки.
  | 'widget-stt-visitor-min'
  | 'widget-stt-visitor-day'
  | 'widget-tts-visitor-min'
  | 'widget-tts-visitor-day'
  // Э5: те же лимиты на ipHash+сайт — новый visitor-token их не обнуляет.
  | 'widget-stt-ip-site-min'
  | 'widget-stt-ip-site-day'
  | 'widget-tts-ip-site-min'
  | 'widget-tts-ip-site-day'
  // Э6: ссылки на ролики и сигналы «элемент не найден» (посетитель и IP+сайт).
  | 'widget-video-visitor-min'
  | 'widget-video-ip-site-min'
  | 'widget-uimiss-visitor-min'
  | 'widget-uimiss-ip-site-min'
  // Э-С Ш4: сигналов «элемент не найден» с IP на сайт в сутки.
  | 'widget-uimiss-ip-site-day'
  // Э6-бис: планы голосового управления (посетитель, IP+сайт, потолок сайта
  // в сутки) и отчёты шагов.
  | 'widget-uiplan-visitor-min'
  | 'widget-uiplan-visitor-day'
  | 'widget-uiplan-ip-site-min'
  | 'widget-uiplan-ip-site-day'
  | 'widget-uiplan-site-day'
  | 'widget-uistep-visitor-min'
  // Э6-бис (г): мастер проверки Т-2 — обмен ссылки (IP+сайт) и запросы сессии.
  | 'widget-vtest-ip-site-min'
  | 'widget-vtest-visitor-min';

export interface RateHit {
  scope: RateScope;
  key: string;
  limit: number;
  windowMs: number;
  now?: Date;
}

export function rateWindow(
  now: Date,
  windowMs: number,
): { bucket: string; endsAt: Date } {
  const start = Math.floor(now.getTime() / windowMs) * windowMs;
  return {
    bucket: new Date(start).toISOString(),
    endsAt: new Date(start + windowMs),
  };
}

@Injectable()
export class WidgetRateLimit {
  constructor(private readonly db: AssistPublicDb) {}

  /** true — уложились (счётчик увеличен). */
  async hit(p: RateHit): Promise<boolean> {
    if (p.limit <= 0) return false;
    const { bucket, endsAt } = rateWindow(p.now ?? new Date(), p.windowMs);
    const rows = await this.db.$queryRaw<Array<{ count: number }>>(Prisma.sql`
      INSERT INTO "sites"."assist_rate_buckets" ("scope", "key", "bucket", "count", "expiresAt")
      VALUES (${p.scope}, ${p.key}, ${bucket}, 1, ${endsAt})
      ON CONFLICT ("scope", "key", "bucket") DO UPDATE
        SET "count" = "sites"."assist_rate_buckets"."count" + 1
        WHERE "sites"."assist_rate_buckets"."count" < ${p.limit}
      RETURNING "count"`);
    return rows.length === 1;
  }

  /**
   * Все лимиты по порядку; первый превышенный — 429 RATE_LIMITED с
   * `retryAfterMs` до конца его окна. Уже засчитанные окна не откатываем:
   * долбящий клиент и должен тратить своё окно.
   */
  async enforce(hits: RateHit[], now: Date = new Date()): Promise<void> {
    for (const h of hits) {
      if (!(await this.hit({ ...h, now }))) {
        const { endsAt } = rateWindow(now, h.windowMs);
        throw widgetError('RATE_LIMITED', {
          retryAfterMs: Math.max(0, endsAt.getTime() - now.getTime()),
        });
      }
    }
  }
}
