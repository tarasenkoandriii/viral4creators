/**
 * Бриф тестировщика: экран `#/testing` (этап 161,
 * `docs-tz/TZ-Rabota-s-Testirovshchikom.md` §2.3, этап 7).
 *
 * ## Почему это экран, а не лендинг
 *
 * Лендинг решал бы одну из двух задач: довести человека до бота или
 * рассказать, что тестировать. Первую решает сам `t.me`, а лишний
 * переход между ссылкой и START теряет людей на ровном месте. Вторую
 * решает это место — здесь человек уже аутентифицирован, здесь же он и
 * работает, и страница не требует ни нового адреса, ни отдельного
 * деплоя. Публичная же страница с брифом — это URL, который можно
 * переслать кому угодно.
 *
 * ## Что здесь есть и чего нет
 *
 * Есть: что открыто и до какого числа, сколько потрачено из потолка,
 * свои находки со статусами. Нет: чужих находок, чужих сумм и текста
 * ответов оператора — ответ приходит в личку, и второе его место
 * разошлось бы с первым (тот же довод, что у §5.2 про переписку в
 * админке).
 */

import { ForbiddenException, Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { AiUsageService } from '../ai-usage/ai-usage.service';
import { dailyLimitForTestUser } from '../../common/spend-limits';
import {
  FreeScenario,
  normalizeFreeScenarios,
  testAccessActive,
} from '../../common/test-user-scenarios';
import { OPEN_STATUSES } from '../../common/test-ticket';

export interface TestingBriefView {
  /**
   * Что проверять — текст, который оператор написал в приглашении
   * (аудит этапа 161). Первый пункт §2.3 и единственный, которого
   * экран, называющийся брифом, поначалу не содержал вовсе.
   */
  brief: string | null;
  /** Что открыто. Коды — как их называть, решает интерфейс с языками. */
  scenarios: FreeScenario[];
  /** Операции вне проекта: клон голоса, озвучка, скетч, поиск. */
  freeOutsideProject: boolean;
  /** До какого момента действует доступ. null — бессрочно. */
  accessUntil: string | null;
  /**
   * Сколько потрачено за сегодня и где потолок, в микродолларах.
   *
   * Показывается ЗДЕСЬ, хотя в приветствии бота о нём молчат, и это не
   * противоречие: там число прилетает в первую же минуту, ничего не
   * объясняя и уже тревожа; здесь человек пришёл сам, и рядом стоит
   * потраченное — то есть число обрело шкалу.
   */
  spentTodayMicroUsd: number;
  dailyLimitMicroUsd: number;
  /**
   * Сколько находок всего. Список ниже обрезан, и подпись обязана это
   * знать: выдавать длину обрезанного за общее — ровно та ошибка,
   * которую нашёл аудит этапа 158 на вкладке админки.
   */
  ticketsTotal: number;
  /** Свои находки — свежие сверху, не больше `TICKETS_SHOWN`. */
  tickets: Array<{
    number: number;
    createdAt: string;
    status: string;
    /** Открыта ли она с точки зрения очереди: ждут нас или его. */
    open: boolean;
    source: string;
    preview: string;
    /** Ответили ли ему по ней. Текста ответа здесь нет — он в личке. */
    answered: boolean;
  }>;
}

const PREVIEW_CHARS = 80;
const TICKETS_SHOWN = 30;

@Injectable()
export class TestingBriefService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly aiUsage: AiUsageService,
  ) {}

  async of(telegramUserId: string): Promise<TestingBriefView> {
    const user = await this.prisma.user.findUnique({
      where: { telegramId: telegramUserId },
      select: {
        id: true,
        isTestUser: true,
        testAccessUntil: true,
        freeScenarios: true,
        freeOutsideProject: true,
        testDailyLimitUsd: true,
        // Бриф — с действующего приглашения: участок у каждого свой.
        testerInvites: {
          where: { revokedAt: null },
          orderBy: { activatedAt: 'desc' },
          take: 1,
          select: { brief: true },
        },
      },
    });
    if (!user || !testAccessActive(user)) {
      // 403, а не пустой бриф: экран открывается только по ссылке,
      // которой у нетестировщика нет. Раз пришли — что-то разошлось.
      throw new ForbiddenException('Тестовый доступ не действует.');
    }

    // Два независимых запроса — параллельно: у экрана одно ожидание, а
    // не два подряд.
    const [tickets, ticketsTotal, spent] = await Promise.all([
      this.prisma.testTicket.findMany({
        where: { userId: user.id },
        orderBy: { createdAt: 'desc' },
        take: TICKETS_SHOWN,
        select: {
          number: true,
          createdAt: true,
          status: true,
          source: true,
          text: true,
          replySentAt: true,
        },
      }),
      this.prisma.testTicket.count({ where: { userId: user.id } }),
      this.aiUsage.spentTodayByUsers([user.id]),
    ]);

    const open = new Set<string>(OPEN_STATUSES);
    return {
      brief: user.testerInvites[0]?.brief ?? null,
      scenarios: normalizeFreeScenarios(user.freeScenarios),
      freeOutsideProject: user.freeOutsideProject,
      accessUntil: user.testAccessUntil?.toISOString() ?? null,
      spentTodayMicroUsd: spent[user.id] ?? 0,
      dailyLimitMicroUsd:
        user.testDailyLimitUsd === null
          ? dailyLimitForTestUser()
          : Math.round(user.testDailyLimitUsd * 1_000_000),
      ticketsTotal,
      tickets: tickets.map((t) => ({
        number: t.number,
        createdAt: t.createdAt.toISOString(),
        status: t.status,
        open: open.has(t.status),
        source: t.source,
        preview: preview(t.text),
        answered: t.replySentAt !== null,
      })),
    };
  }
}

/** Столько же, сколько нужно, чтобы узнать свою находку в списке. */
function preview(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > PREVIEW_CHARS
    ? `${flat.slice(0, PREVIEW_CHARS)}…`
    : flat;
}
