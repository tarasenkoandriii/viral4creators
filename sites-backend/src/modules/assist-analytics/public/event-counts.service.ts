/**
 * Счётчики событий виджета — A (ТЗ §4.16 `POST /widget/v1/event`,
 * §5-тер.12 п.10). Маршрут — W (батч ≤ 20, тело ≤ 4 КБ, Origin =
 * verified public-хост, белый список полей — неизвестное поле 400); здесь —
 * один UPSERT на (сайт, день UTC, вид, ключ, час) под AssistPublicDb.
 * Ни посетителя, ни страницы — только счётчики.
 *
 * Уточнения A: батч сворачивается в памяти (одинаковые вид+ключ — одна
 * строка VALUES, иначе ON CONFLICT споткнётся о «вторую правку той же
 * строки»), один запрос `INSERT … ON CONFLICT DO UPDATE SET count =
 * count + EXCLUDED.count` (права роли: SELECT, INSERT, UPDATE(count)).
 * Неизвестный вид или кривой ключ — пропуск (белый список — у W, это
 * вторая линия). Больше eventsPerBatch — хвост не считается.
 */
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ANALYTICS_DEFAULTS } from '../../../config/assist-defaults';
import { AssistPublicDb } from '../../../prisma/assist-public-db.service';

export const WIDGET_EVENT_KINDS = [
  'widget_view',
  'open',
  'proactive_shown',
  'proactive_accepted',
  'proactive_dismissed',
  'scenario_started',
  'scenario_done',
  'link_click',
  // Э6 (пишет сервер на своих маршрутах): ролик открыт, элемент карты не
  // найден на странице (сигнал «карта устарела»).
  'video_play',
  'highlight_miss',
  // Э3-бис: посетитель дал согласие на аналитику и получил ключ визита
  // (раз на визит, чанк ana.js) — база мощности экспериментов (§5-тер.2);
  // итог просмотра принят сервером (квота поведения, §5-тер.10).
  'visit_new',
  'bf_pv',
] as const;
export type WidgetEventKind = (typeof WIDGET_EVENT_KINDS)[number];

/**
 * Э6: виды, которые считает ТОЛЬКО сервер на своих маршрутах (ссылка на
 * ролик выдана, сигнал «элемент не найден» принят) — пакет загрузчика
 * `POST /widget/v1/event` их не принимает (страница не накручивает).
 */
export const SERVER_EVENT_KINDS: readonly WidgetEventKind[] = [
  'video_play',
  'highlight_miss',
  'bf_pv',
];

/** Ключ триггера/сценария: короткий идентификатор конфигурации вида. */
export const EVENT_KEY = /^[A-Za-z0-9_:.-]{1,64}$/;

@Injectable()
export class EventCounts {
  constructor(readonly db: AssistPublicDb) {}

  async record(p: {
    siteId: string;
    events: Array<{ kind: WidgetEventKind; key: string | null }>;
    now: Date;
  }): Promise<void> {
    const counts = new Map<string, { kind: string; key: string; n: number }>();
    for (const e of p.events.slice(0, ANALYTICS_DEFAULTS.eventsPerBatch)) {
      if (!(WIDGET_EVENT_KINDS as readonly string[]).includes(e?.kind))
        continue;
      const key = e.key === null || e.key === undefined ? '' : e.key;
      if (typeof key !== 'string' || (key && !EVENT_KEY.test(key))) continue;
      const id = `${e.kind}\u0000${key}`;
      const c = counts.get(id);
      if (c) c.n++;
      else counts.set(id, { kind: e.kind, key, n: 1 });
    }
    if (!counts.size) return;
    const iso = p.now.toISOString();
    const day = iso.slice(0, 10);
    const hour = p.now.getUTCHours();
    const values = [...counts.values()].map(
      (c) =>
        Prisma.sql`(${p.siteId}, ${day}, ${c.kind}, ${c.key}, ${hour}, ${c.n})`,
    );
    await this.db.$executeRaw(Prisma.sql`
      INSERT INTO "sites"."assist_site_event_counts" ("siteId", "day", "kind", "key", "hour", "count")
      VALUES ${Prisma.join(values)}
      ON CONFLICT ("siteId", "day", "kind", "key", "hour") DO UPDATE
        SET "count" = "sites"."assist_site_event_counts"."count" + EXCLUDED."count"`);
  }
}
