/**
 * Очередь разбора находок тестировщика (этап 158,
 * `docs-tz/TZ-Rabota-s-Testirovshchikom.md` §5).
 *
 * ## Что такое «похожие»
 *
 * Тикеты с тем же `envKey`. Ключ грубый намеренно — до семейства ОС,
 * без версии, — потому что мелкий ключ не собирает групп вовсе, а
 * смысл его ровно в том, чтобы группы были.
 *
 * Но у тикета ИЗ БОТА ни сценария, ни шага нет, и ключ вырождается в
 * «та же платформа и локаль». Это честный ответ на вопрос «это у всех
 * или у него одного», но НЕ список похожих находок, и наружу он уходит
 * под своим именем (`sameEnvironment`), чтобы оператор не прочитал его
 * как подсказку, которой он не является.
 *
 * ## Чего здесь нет
 *
 * Переписки. Тикет — это находка и ответ на неё, а не чат: переписка
 * живёт в личке с ботом, и второе её место разойдётся с первым.
 * Комментарии в карточке показываются только чтением.
 */

import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { TelegramNotifyService } from '../notify/telegram-notify.service';
import {
  envSummary,
  isTicketStatus,
  needsReason,
  OPEN_STATUSES,
  TicketStatus,
} from '../../common/test-ticket';
import {
  FreeScenario,
  FREE_SCENARIOS,
  scenarioOfProjectType,
} from '../../common/test-user-scenarios';

export interface TicketRowView {
  id: string;
  number: number;
  createdAt: Date;
  source: string;
  status: string;
  /** Первые слова — в списке нужен повод открыть, а не весь текст. */
  preview: string;
  scenario: string | null;
  uiLocale: string;
  envKey: string | null;
  envSummary: string;
  /** Снято ли окружение в момент находки. */
  envStale: boolean;
  attachments: number;
  tester: { id: string; telegramId: string; label: string };
  replySentAt: Date | null;
  replyFailedAt: Date | null;
}

export interface TicketDetailView extends TicketRowView {
  text: string;
  env: unknown;
  envCapturedAt: Date | null;
  appBuild: string | null;
  sessionId: string | null;
  sessionLocale: string | null;
  stepId: string | null;
  attachmentList: unknown;
  comments: unknown;
  statusBy: string | null;
  statusAt: Date | null;
  statusNote: string | null;
  /** Может ли бот вообще написать этому человеку (§3.9). */
  canReply: boolean;
  /** Сколько их всего — список ниже обрезан. */
  sameEnvironmentTotal: number;
  /** Тикеты с тем же окружением — не «похожие находки», см. шапку. */
  sameEnvironment: Array<{
    id: string;
    number: number;
    createdAt: Date;
    status: string;
    preview: string;
  }>;
}

export interface TesterProgressView {
  userId: string;
  telegramId: string;
  label: string;
  /** Сколько прогонов и тикетов по каждому сценарию. */
  scenarios: Array<{
    scenario: FreeScenario;
    /** Открыт ли сценарий этому тестировщику. */
    open: boolean;
    sessions: number;
    tickets: number;
  }>;
  /** До какого числа действует доступ. NULL — бессрочно. */
  accessUntil: Date | null;
  accessActive: boolean;
  openTickets: number;
  closedTickets: number;
  lastActivityAt: Date | null;
}

const PREVIEW_CHARS = 120;

/** Сколько соседей по окружению показываем в карточке. */
const SAME_ENV_LIMIT = 10;

@Injectable()
export class AdminTestTicketsService {
  private readonly logger = new Logger(AdminTestTicketsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notify: TelegramNotifyService,
  ) {}

  async list(opts: {
    status?: string;
    userId?: string;
    envKey?: string;
    take?: number;
  }): Promise<TicketRowView[]> {
    const where: Record<string, unknown> = {};
    if (opts.status && isTicketStatus(opts.status)) where.status = opts.status;
    // «Открытые» — не статус, а вопрос «что ждёт нас»; он и есть
    // рабочий вид вкладки.
    if (opts.status === 'OPEN') where.status = { in: [...OPEN_STATUSES] };
    if (opts.userId) where.userId = opts.userId;
    if (opts.envKey) where.envKey = opts.envKey;

    const rows = await this.prisma.testTicket.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: Math.min(opts.take ?? 100, 200),
      include: { user: { select: userSelect } },
    });
    return rows.map((row) => this.row(row));
  }

  async get(id: string): Promise<TicketDetailView> {
    const row = await this.prisma.testTicket.findUnique({
      where: { id },
      include: { user: { select: { ...userSelect, botChatOpenedAt: true } } },
    });
    if (!row) throw new NotFoundException(`Ticket ${id} not found`);

    const where = { envKey: row.envKey ?? '', id: { not: id } };
    // Список ОБРЕЗАН, и рядом едет полное число (аудит этапа 158).
    // Подпись, выдающая длину обрезанного списка за общее, сообщает
    // «ещё 10» там, где их полсотни, — то есть ровно в том случае,
    // когда число и важно. Счёт по индексу на `envKey`, он дешёвый.
    const [sameEnvironment, sameEnvironmentTotal] = row.envKey
      ? await Promise.all([
          this.prisma.testTicket.findMany({
            where,
            orderBy: { createdAt: 'desc' },
            take: SAME_ENV_LIMIT,
            select: {
              id: true,
              number: true,
              createdAt: true,
              status: true,
              text: true,
            },
          }),
          this.prisma.testTicket.count({ where }),
        ])
      : [[], 0];

    return {
      ...this.row(row),
      text: row.text,
      env: row.env,
      envCapturedAt: row.envCapturedAt,
      appBuild: row.appBuild,
      sessionId: row.sessionId,
      sessionLocale: row.sessionLocale,
      stepId: row.stepId,
      attachmentList: row.attachments,
      comments: row.comments,
      statusBy: row.statusBy,
      statusAt: row.statusAt,
      statusNote: row.statusNote,
      // Право писать известно ДО отправки: пусто — кнопка ответа
      // неактивна с подписью «диалог с ботом не открыт». Это не сбой, а
      // положение дел, и узнавать о нём из неотправленного сообщения
      // незачем.
      canReply: Boolean(row.user?.botChatOpenedAt),
      sameEnvironmentTotal,
      sameEnvironment: sameEnvironment.map((s) => ({
        id: s.id,
        number: s.number,
        createdAt: s.createdAt,
        status: s.status,
        preview: preview(s.text),
      })),
    };
  }

  /** Смена статуса. Для «отклонено» и «дубль» причина обязательна. */
  async setStatus(
    actorId: string,
    id: string,
    status: string,
    note: string | null,
  ): Promise<TicketDetailView> {
    if (!isTicketStatus(status)) {
      throw new BadRequestException(`Неизвестный статус: ${status}`);
    }
    const reason = note?.trim() || null;
    if (needsReason(status) && !reason) {
      throw new BadRequestException(
        'Для «отклонено» и «дубль» нужна причина: без неё человек, ' +
          'потративший время на находку, прочитает это как «нам всё равно».',
      );
    }
    const exists = await this.prisma.testTicket.findUnique({
      where: { id },
      select: { number: true },
    });
    if (!exists) throw new NotFoundException(`Ticket ${id} not found`);

    await this.prisma.testTicket.update({
      where: { id },
      data: {
        status,
        statusBy: actorId,
        statusAt: new Date(),
        // Причина не затирается пустой: снятая галочка не должна
        // стирать объяснение, которое оператор уже написал.
        ...(reason ? { statusNote: reason } : {}),
      },
    });
    this.logger.log(
      `оператор ${actorId} перевёл тикет #${exists.number} в ${status}`,
    );
    return this.get(id);
  }

  /**
   * Ответ тестировщику в личку.
   *
   * Единственное место, где «бот не пишет первым» перестаёт быть
   * ограничением: диалог создан нажатием START. Поэтому право
   * проверяется по `botChatOpenedAt` — до отправки, а не после.
   *
   * `dm()` глотает отказ молча, и для тикета этого мало: без видимого
   * признака оператор будет думать, что ответил. Отсюда `replyFailedAt`
   * рядом с `replySentAt`.
   */
  async reply(
    actorId: string,
    id: string,
    text: string,
  ): Promise<TicketDetailView> {
    const body = text?.trim();
    if (!body)
      throw new BadRequestException('Пустой ответ отправлять незачем.');

    const row = await this.prisma.testTicket.findUnique({
      where: { id },
      select: {
        id: true,
        number: true,
        comments: true,
        user: { select: { telegramId: true, botChatOpenedAt: true } },
      },
    });
    if (!row) throw new NotFoundException(`Ticket ${id} not found`);
    if (!row.user?.botChatOpenedAt) {
      throw new ForbiddenException(
        'Диалог с ботом не открыт — написать первым Telegram не даёт. ' +
          'Человек должен нажать START по ссылке приглашения.',
      );
    }

    const sent = await this.notify.dmWithId(
      row.user.telegramId,
      `По находке #${row.number}:\n${body}`,
    );
    const now = new Date();
    const comments = Array.isArray(row.comments) ? row.comments : [];
    await this.prisma.testTicket.update({
      where: { id },
      data: {
        comments: [
          ...comments,
          { at: now.toISOString(), from: 'OPERATOR', by: actorId, text: body },
        ] as unknown as object,
        // Успех отмечается, неудача — тоже, но НЕ затирая успех (аудит
        // этапа 158). Раньше провалившийся второй ответ ставил
        // `replySentAt: null`, и карточка начинала утверждать, что мы
        // не отвечали никогда, — при том что первый ответ человек
        // получил. Последний провал стирается следующей удачей, а факт
        // состоявшегося ответа не стирается ничем.
        ...(sent.ok ? { replySentAt: now, replyFailedAt: null } : {}),
        ...(sent.ok ? {} : { replyFailedAt: now }),
        // Ответ переводит тикет в «ждём тестировщика»: очередь теперь
        // ждёт ЕГО, и без этого различия оператор не видит, где мяч на
        // чужой стороне.
        ...(sent.ok
          ? { status: 'ANSWERED', statusBy: actorId, statusAt: now }
          : {}),
        // Идентификатор нашего сообщения — по нему ответ тестировщика
        // найдёт этот тикет и ляжет комментарием, а не новой находкой.
        ...(sent.messageId !== null
          ? { botMessageIds: { push: sent.messageId } }
          : {}),
      },
    });
    if (!sent.ok) {
      this.logger.warn(
        `ответ по тикету #${row.number} не доставлен — человек мог ` +
          'заблокировать бота',
      );
    }
    return this.get(id);
  }

  /**
   * Прогресс тестировщиков (§5.1).
   *
   * Покрытие сценариев считается из УЖЕ существующих данных: у сессии
   * есть `userId` и `projectId`, у проекта — тип, а
   * `scenarioOfProjectType()` переводит тип в сценарий. Ни одной новой
   * таблицы это не требует, а сценарий, по которому у тестировщика
   * тишина, виден сразу — и это главный вопрос к любому тестированию.
   */
  async progress(): Promise<TesterProgressView[]> {
    const testers = await this.prisma.user.findMany({
      where: { isTestUser: true },
      select: { ...userSelect, freeScenarios: true, testAccessUntil: true },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    if (!testers.length) return [];
    const ids = testers.map((t) => t.id);

    // Считает БАЗА, а не мы по вытащенным строкам (аудит этапа 158).
    // Раньше здесь было два `findMany` с `take: 2000` и без сортировки:
    // на тестировщике с тремя тысячами сессий счётчики становились
    // произвольными — и молча, потому что наружу они уходят как факты.
    // Агрегат такого потолка не знает вовсе.
    //
    // Три независимых запроса — параллельно: на serverless
    // последовательные ожидания складываются в ответ оператору.
    const [sessionRows, ticketRows, lastTickets] = await Promise.all([
      // Сырой SQL, потому что группировать надо по ТИПУ ПРОЕКТА —
      // полю связанной таблицы, а `groupBy` в Prisma по связям не умеет.
      this.prisma.$queryRaw<
        Array<{ userId: string; type: string | null; n: bigint }>
      >`
        SELECT s."userId", p."type"::text AS "type", COUNT(*) AS n
        FROM "sessions" s
        LEFT JOIN "projects" p ON p."id" = s."projectId"
        WHERE s."userId" = ANY(${ids}::text[])
        GROUP BY s."userId", p."type"
      `,
      this.prisma.testTicket.groupBy({
        by: ['userId', 'status', 'scenario'],
        where: { userId: { in: ids } },
        _count: { _all: true },
      }) as unknown as Promise<
        Array<{
          userId: string;
          status: string;
          scenario: string | null;
          _count: { _all: number };
        }>
      >,
      this.prisma.testTicket.groupBy({
        by: ['userId'],
        where: { userId: { in: ids } },
        _max: { createdAt: true },
      }),
    ]);

    const lastBy = new Map(
      lastTickets.map((r) => [r.userId, r._max.createdAt ?? null]),
    );

    const open = new Set<string>(OPEN_STATUSES);
    const now = new Date();
    return testers.map((tester) => {
      const mySessions = sessionRows.filter((s) => s.userId === tester.id);
      const myTickets = ticketRows.filter((t) => t.userId === tester.id);
      // Срок тестового доступа истёк — сценарии больше не открыты,
      // сколько бы галочек ни стояло (аудит этапа 158). Вкладка,
      // рисующая «открыто» там, где доступа уже нет, отправляет
      // оператора ждать прогонов, которых не будет.
      const active =
        !tester.testAccessUntil ||
        tester.testAccessUntil.getTime() > now.getTime();
      return {
        userId: tester.id,
        telegramId: tester.telegramId,
        label: label(tester),
        accessUntil: tester.testAccessUntil,
        accessActive: active,
        scenarios: FREE_SCENARIOS.map((scenario) => ({
          scenario,
          open: active && tester.freeScenarios.includes(scenario),
          sessions: sum(
            mySessions
              .filter((s) => scenarioOfProjectType(s.type) === scenario)
              .map((s) => Number(s.n)),
          ),
          tickets: sum(
            myTickets
              .filter((t) => t.scenario === scenario)
              .map((t) => t._count._all),
          ),
        })),
        openTickets: sum(
          myTickets.filter((t) => open.has(t.status)).map((t) => t._count._all),
        ),
        closedTickets: sum(
          myTickets
            .filter((t) => !open.has(t.status))
            .map((t) => t._count._all),
        ),
        lastActivityAt: lastBy.get(tester.id) ?? null,
      };
    });
  }

  private row(row: TicketRow): TicketRowView {
    return {
      id: row.id,
      number: row.number,
      createdAt: row.createdAt,
      source: row.source,
      status: row.status,
      preview: preview(row.text),
      scenario: row.scenario,
      uiLocale: row.uiLocale,
      envKey: row.envKey,
      envSummary: envSummary(row.env),
      // Снято раньше самой находки — сигнал сам по себе: окружение к
      // ней, скорее всего, отношения не имеет. Из бота оно ВСЕГДА
      // последнее известное, поэтому признак считается по датам, а не
      // по источнику.
      envStale: isStale(row.envCapturedAt, row.createdAt),
      attachments: Array.isArray(row.attachments) ? row.attachments.length : 0,
      tester: {
        id: row.user?.id ?? row.userId,
        telegramId: row.user?.telegramId ?? '—',
        label: label(row.user),
      },
      replySentAt: row.replySentAt,
      replyFailedAt: row.replyFailedAt,
    };
  }
}

const userSelect = {
  id: true,
  telegramId: true,
  firstName: true,
  username: true,
} as const;

interface TicketRow {
  id: string;
  number: number;
  createdAt: Date;
  source: string;
  status: string;
  text: string;
  scenario: string | null;
  uiLocale: string;
  envKey: string | null;
  env: unknown;
  envCapturedAt: Date | null;
  attachments: unknown;
  userId: string;
  user: {
    id: string;
    telegramId: string;
    firstName: string | null;
    username: string | null;
  } | null;
  replySentAt: Date | null;
  replyFailedAt: Date | null;
}

/**
 * Пять минут — запас на путь «снял окружение → написал боту». Меньше
 * означало бы, что почти каждый тикет помечен подозрительным, и
 * пометка перестанет что-либо значить.
 */
const STALE_AFTER_MS = 5 * 60 * 1000;

function isStale(capturedAt: Date | null, createdAt: Date): boolean {
  if (!capturedAt) return true;
  return createdAt.getTime() - capturedAt.getTime() > STALE_AFTER_MS;
}

function sum(values: number[]): number {
  return values.reduce((a, b) => a + b, 0);
}

function preview(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > PREVIEW_CHARS
    ? `${flat.slice(0, PREVIEW_CHARS)}…`
    : flat;
}

function label(
  user: { firstName?: string | null; username?: string | null } | null,
): string {
  if (!user) return 'неизвестный';
  return user.firstName || (user.username ? `@${user.username}` : 'без имени');
}

export type { TicketStatus };
