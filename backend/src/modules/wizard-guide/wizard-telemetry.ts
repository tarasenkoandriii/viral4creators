/**
 * Телеметрия шагов мастера — «Тонкая красная линия» §8, этап 8.
 *
 * ## Зачем своя таблица, а не воронка
 *
 * Версия 1 ТЗ предлагала взять «брошенные шаги» из `WorkflowStageEvent`.
 * Это неверно: `WorkflowKind` знает только `SESSION`,
 * `CATALOG_BATCH_ITEM` и `AB_TEST_VARIANT`, обучалка в нём не
 * представлена вовсе, а у greeting и товарки гранулярность —
 * `SessionStatus`, девять статусов на весь путь. Советнику нужны
 * ЧАСТОТЫ по шагам, а не переходы когорты, и добавлять ради них новый
 * `WorkflowKind` значило бы тронуть воронку, по которой уже считается
 * конверсия.
 *
 * ## Чего здесь нет
 *
 * Идентификаторов. Ни пользователя, ни сессии, ни адреса — как в
 * `assistant_events`. Таблица без идентификаторов не может утечь тем,
 * чего в ней нет, а на вопрос «где чаще жмут „тут непонятно“» они и не
 * нужны.
 */

import { PrismaService } from '../../prisma/prisma.service';

export const WIZARD_EVENT_KINDS = [
  /** Человек оказался на шаге. */
  'enter',
  /** Ушёл с шага. */
  'leave',
  /** Раскрыл строку совета. */
  'hint_open',
  /** Нажал «тут непонятно». */
  'hint_useless',
  /** Откатил раунд записи. */
  'undo',
  /** Шаг ответил отказом; `detail` — код, не текст. */
  'error',
  /**
   * Человек нажал на то, что не является шагом: кнопку, ссылку.
   *
   * Заведено этапом 134 под телеметрию кабинета приглашений (§12.2 ТЗ
   * «Условно бесплатный Lite»): там нужны «скопировал ссылку» и «нажал
   * поделиться», а `enter`/`leave` описывают экраны, а не действия.
   * Своей таблицы у кабинета нет намеренно — ТЗ прямо говорит «тем же
   * механизмом, что телеметрия мастера», и вторая таблица без
   * идентификаторов отличалась бы от этой только именем.
   */
  'click',
] as const;

export type WizardEventKind = (typeof WIZARD_EVENT_KINDS)[number];

/** Ретенция — та же, что у журналов консультанта. */
export const WIZARD_TELEMETRY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export async function pruneWizardStepEvents(
  prisma: PrismaService,
  now: Date = new Date(),
): Promise<number> {
  const cutoff = new Date(now.getTime() - WIZARD_TELEMETRY_RETENTION_MS);
  const r = await prisma.wizardStepEvent.deleteMany({
    where: { createdAt: { lt: cutoff } },
  });
  return r.count;
}

export async function pruneWizardHints(
  prisma: PrismaService,
  now: Date = new Date(),
): Promise<number> {
  const cutoff = new Date(now.getTime() - WIZARD_TELEMETRY_RETENTION_MS);
  const r = await prisma.wizardHint.deleteMany({
    where: { createdAt: { lt: cutoff } },
  });
  return r.count;
}

/**
 * Кеш подсказок живёт сутки (§5.5) — и его уборка идёт тем же проходом.
 *
 * Отдельный TTL, а не общая ретенция: записи старше суток не отдаются
 * никогда, и держать их месяц значит хранить мусор, по которому ещё и
 * считается доля попаданий.
 */
export const HINT_CACHE_RETENTION_MS = 24 * 60 * 60 * 1000;

export async function pruneWizardHintCache(
  prisma: PrismaService,
  now: Date = new Date(),
): Promise<number> {
  const cutoff = new Date(now.getTime() - HINT_CACHE_RETENTION_MS);
  const r = await prisma.wizardHintCache.deleteMany({
    where: { createdAt: { lt: cutoff } },
  });
  return r.count;
}

/** Сколько событий принимаем в одном запросе. */
export const WIZARD_EVENT_BATCH_MAX = 20;

/** Длина `detail`: код ошибки, а не текст. */
export const WIZARD_EVENT_DETAIL_MAX = 80;

/**
 * Разобранные кандидаты живут дольше журналов — 90 дней.
 *
 * Дольше, потому что это не телеметрия, а история решений оператора:
 * по ней видно, что уже отклоняли и почему. Но не вечно: сырой текст
 * жалобы — пользовательский ввод, и держать его после того, как
 * решение принято и записано в ситуацию, незачем (§9). Неразобранные
 * (`NEW`) не трогаются никогда: это рабочая очередь.
 */
export const CANDIDATE_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

export async function pruneWizardCandidates(
  prisma: PrismaService,
  now: Date = new Date(),
): Promise<number> {
  const cutoff = new Date(now.getTime() - CANDIDATE_RETENTION_MS);
  const r = await prisma.wizardExperienceCandidate.deleteMany({
    where: {
      createdAt: { lt: cutoff },
      status: { in: ['MERGED', 'PROMOTED', 'REJECTED'] },
    },
  });
  return r.count;
}
