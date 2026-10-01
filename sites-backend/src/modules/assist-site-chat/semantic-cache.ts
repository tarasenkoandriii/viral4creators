/**
 * Семантический кэш ответов — W3 (ТЗ §4.5, §4-тер.7; приёмка §4-тер.15 п.8).
 * Ключ — semanticCacheKey (assist-knowledge-core, Э1): смена knowledgeVersion
 * или configVersion = другой ключ. В кэш — только: первое сообщение
 * диалога, ≥ 1 источник, без флагов пост-фильтра, вопрос ≤ 200 символов
 * без признаков инъекции (detectInjection), не от suspicious-трафика.
 * 👎 на ответ из кэша удаляет запись. TTL 24 ч.
 *
 * Сверх списка: вопрос или ответ с персональными данными (маскирование
 * меняет текст — «перезвоните на +380…», телефон в ответе) в кэш не идёт:
 * в кэше нет ПДн вовсе (приёмка п.6: «в кэше» тоже), а маскированный
 * ответ другому посетителю был бы испорчен.
 * Под ролью assist_public (S/I/U/D на assist_site_semantic_cache).
 */
import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { WIDGET_DEFAULTS } from '../../config/assist-defaults';
import { AssistPublicDb } from '../../prisma/assist-public-db.service';
import { detectInjection } from '../assist-knowledge-core/injection';
import { maskForJournal } from './answer-checks';
import {
  SITE_ACTION_KINDS,
  type SiteAction,
  type SiteAnswerSource,
} from './chat-types';

export interface CachedAnswer {
  text: string;
  sources: SiteAnswerSource[];
  actions: SiteAction[];
  lang: string | null;
}

/** Почему ответ не попал в кэш (null — подходит). Чистая функция. */
export function cacheRejectReason(p: {
  question: string;
  answer: CachedAnswer;
  firstMessage: boolean;
  flags: string[];
  suspicious: boolean;
}): string | null {
  if (!p.firstMessage) return 'not_first';
  if (p.suspicious) return 'suspicious';
  if (p.flags.length > 0) return 'flags';
  if (p.answer.sources.length === 0) return 'no_sources';
  const q = p.question.trim();
  if (!q || q.length > WIDGET_DEFAULTS.semanticCacheMaxQuestionChars) {
    return 'long_question';
  }
  if (detectInjection(q).quarantine) return 'injection';
  if (maskForJournal(q) !== q) return 'personal_data';
  // Ответ с телефоном/e-mail (хоть бы и самого сайта) в кэш не идёт: кэш
  // хранится маскированным (приёмка п.6), а «[телефон скрыт]» вместо
  // горячей линии магазина другому посетителю — порча ответа.
  if (maskForJournal(p.answer.text) !== p.answer.text) return 'personal_data';
  return null;
}

function parseCached(v: Prisma.JsonValue): CachedAnswer | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.text !== 'string' || !o.text) return null;
  const sources = Array.isArray(o.sources)
    ? o.sources.filter(
        (s): s is SiteAnswerSource =>
          !!s &&
          typeof s === 'object' &&
          typeof (s as SiteAnswerSource).n === 'number',
      )
    : [];
  const actions = Array.isArray(o.actions)
    ? o.actions.filter(
        (a): a is SiteAction =>
          !!a &&
          typeof a === 'object' &&
          (SITE_ACTION_KINDS as readonly string[]).includes(
            (a as SiteAction).kind,
          ),
      )
    : [];
  return {
    text: o.text,
    sources,
    actions,
    lang: typeof o.lang === 'string' ? o.lang : null,
  };
}

@Injectable()
export class SemanticCache {
  /** Часы — для тестов TTL. */
  now: () => Date = () => new Date();

  constructor(private readonly db: AssistPublicDb) {}

  async get(p: { siteId: string; key: string }): Promise<CachedAnswer | null> {
    const rows = await this.db.$queryRawUnsafe<
      Array<{ answer: Prisma.JsonValue }>
    >(
      `UPDATE "sites"."assist_site_semantic_cache" SET "hits" = "hits" + 1
        WHERE "siteId" = $1 AND "key" = $2 AND "expiresAt" > $3
        RETURNING "answer"`,
      p.siteId,
      p.key,
      this.now(),
    );
    return rows.length ? parseCached(rows[0].answer) : null;
  }

  /** Правила допуска в кэш — внутри (возвращает, записано ли). */
  async put(p: {
    siteId: string;
    key: string;
    question: string;
    answer: CachedAnswer;
    knowledgeVersion: number;
    configVersion: number;
    firstMessage: boolean;
    flags: string[];
    suspicious: boolean;
  }): Promise<boolean> {
    if (cacheRejectReason(p) !== null) return false;
    const answer: CachedAnswer = {
      ...p.answer,
      text: maskForJournal(p.answer.text),
    };
    const now = this.now();
    const n = await this.db.$executeRawUnsafe(
      `INSERT INTO "sites"."assist_site_semantic_cache"
         ("id", "siteId", "key", "answer", "knowledgeVersion", "configVersion", "expiresAt", "createdAt")
       VALUES (gen_random_uuid()::text, $1, $2, $3::jsonb, $4, $5, $6, $7)
       ON CONFLICT ("siteId", "key") DO UPDATE
         SET "answer" = EXCLUDED."answer", "expiresAt" = EXCLUDED."expiresAt", "hits" = 0
         WHERE "sites"."assist_site_semantic_cache"."expiresAt" <= $7`,
      p.siteId,
      p.key,
      JSON.stringify(answer),
      p.knowledgeVersion,
      p.configVersion,
      new Date(now.getTime() + WIDGET_DEFAULTS.semanticCacheTtlMs),
      now,
    );
    return n === 1;
  }

  /** 👎 (W2 feedback) → удалить запись по ключу сообщения. */
  async evict(p: { siteId: string; key: string }): Promise<void> {
    await this.db.$executeRawUnsafe(
      `DELETE FROM "sites"."assist_site_semantic_cache" WHERE "siteId" = $1 AND "key" = $2`,
      p.siteId,
      p.key,
    );
  }
}
