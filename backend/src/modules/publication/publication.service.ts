/**
 * PublicationService — moderation queue for publishing generated videos
 * (spec §8 Todo / §11 «Опубликовать»; Stage 18, the half that needs no
 * OAuth). The rule from §8 is the whole point: pressing «Опубликовать»
 * never publishes — it creates a PENDING request an operator approves or
 * rejects in the admin panel. The actual upload to a YouTube/TikTok
 * channel is a separate ТЗ; APPROVED is where that integration will pick
 * requests up (→ PUBLISHED / FAILED).
 *
 * A request is a SNAPSHOT (video URL/pathname, title, description, tags
 * incl. the product category) and keeps no FK to Session — sessions are
 * TTL-cleaned, the queue must outlive them.
 */

import { BlobService } from '../storage/blob.service';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { PlanService } from '../plan/plan.service';
import { SessionService } from '../../common/session.service';
import { Session } from '../../common/types/session.types';
import { GenerationStatus } from '../../common/types/generation.types';
import { aspectRatioFamily } from '../../common/aspect-ratio';
import {
  PublicationListResult,
  PublicationPlatform,
  PublicationPrivacy,
  PublicationRequestView,
  PublicationStatus,
} from '../../common/types/publication.types';
import {
  ApprovePublicationRequestDto,
  CreatePublicationRequestDto,
  RejectPublicationRequestDto,
} from './dto/publication.dto';

/** Structural row type — see project.service.ts for why not Prisma's. */
interface PublicationRow {
  id: string;
  userId: string;
  sessionId: string;
  generatedVideoId: string;
  projectId: string | null;
  productItemId: string | null;
  platform: PublicationPlatform;
  status: PublicationStatus;
  videoUrl: string;
  videoPathname: string;
  title: string;
  description: string;
  tags: string[];
  category: string | null;
  moderatorId: string | null;
  moderatedAt: Date | null;
  rejectReason: string | null;
  externalUrl: string | null;
  externalId: string | null;
  publishError: string | null;
  publishedAt: Date | null;
  /** Этап 61 (ТЗ §14) — куда и с какой видимостью выгружать. */
  channelId: string | null;
  privacy: PublicationPrivacy;
  attempts: number;
  createdAt: Date;
  updatedAt: Date;
}

const STATUSES: ReadonlySet<string> = new Set([
  'PENDING',
  'APPROVED',
  'REJECTED',
  'PUBLISHED',
  'FAILED',
]);

/** Pure: what gets copied into the request. Exported for tests. */
export function snapshotFromSession(
  session: Session,
  dto: CreatePublicationRequestDto,
): {
  videoUrl: string;
  videoPathname: string;
  generatedVideoId: string;
  title: string;
  description: string;
  tags: string[];
  category: string | null;
} {
  const video = session.generatedVideo;
  if (
    !video ||
    video.status !== GenerationStatus.COMPLETE ||
    !video.downloadUrl
  ) {
    throw new BadRequestException(
      'No completed video in this session — generate the video first',
    );
  }
  const product = session.productInformation;
  const title = (dto.title ?? product?.productName ?? '').trim().slice(0, 100);
  if (!title) {
    throw new BadRequestException(
      'title is required (no product name to fall back to)',
    );
  }
  const category = product?.category?.trim() || null;
  const tags = uniqueTags([
    ...(dto.tags ?? []),
    ...(category ? [category] : []),
    ...(product?.productName ? [product.productName] : []),
  ]);

  // Этап 75 (автоэкспорт, `doc/MULTI-FORMAT-EXPORT-SPEC.md` §6): заявка
  // на YouTube и TikTok от одной сессии раньше получала ОДИН И ТОТ ЖЕ
  // файл, каким бы форматом он ни был обрезан — если ролик снят в 9:16
  // (TikTok), заявка на YouTube тоже уходила с портретным файлом. Теперь,
  // если готовый вариант автоэкспорта нужного семейства уже есть,
  // публикация берёт ЕГО; нет — прежнее поведение (что лежит, то и
  // уходит), а не отказ: не при каждой публикации есть готовый экспорт.
  const targetFamily = aspectRatioFamily(
    dto.platform === 'TIKTOK' ? '9:16' : '16:9',
  );
  const currentFamily = aspectRatioFamily(
    video.renderedAspectRatio ?? video.aspectRatio ?? '9:16',
  );
  let videoUrl = video.downloadUrl;
  let videoPathname = video.postPathname ?? video.pathname;
  if (currentFamily !== targetFamily) {
    const variant = (video.exportVariants ?? []).find(
      (v) =>
        v.status === 'complete' &&
        v.url &&
        v.pathname &&
        aspectRatioFamily(v.format) === targetFamily,
    );
    if (variant?.url && variant.pathname) {
      videoUrl = variant.url;
      videoPathname = variant.pathname;
    }
  }

  return {
    // Обе половины — про ОДИН файл, тот самый, что видит пользователь
    // (этап 39, А-2.6). До этого `videoPathname` всегда указывал на
    // исходник Veo, а `videoUrl` мог указывать на обработанный: пара
    // противоречила сама себе, и оператор не мог знать, что смотрит.
    videoUrl,
    videoPathname,
    generatedVideoId: video.generatedVideoId,
    title,
    description: (dto.description ?? product?.productDescription ?? '')
      .trim()
      .slice(0, 5000),
    tags,
    category,
  };
}

export function uniqueTags(raw: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of raw) {
    const v = t.trim().replace(/^#/, '').slice(0, 60);
    const key = v.toLowerCase();
    if (!v || seen.has(key)) continue;
    seen.add(key);
    out.push(v);
    if (out.length >= 30) break;
  }
  return out;
}

export function toView(row: PublicationRow): PublicationRequestView {
  return {
    id: row.id,
    userId: row.userId,
    sessionId: row.sessionId,
    generatedVideoId: row.generatedVideoId,
    projectId: row.projectId,
    productItemId: row.productItemId,
    platform: row.platform,
    status: row.status,
    videoUrl: row.videoUrl,
    title: row.title,
    description: row.description,
    tags: row.tags,
    category: row.category,
    moderatorId: row.moderatorId,
    moderatedAt: row.moderatedAt?.toISOString() ?? null,
    rejectReason: row.rejectReason,
    externalUrl: row.externalUrl,
    publishedAt: row.publishedAt?.toISOString() ?? null,
    publishError: row.publishError,
    channelId: row.channelId,
    privacy: row.privacy,
    attempts: row.attempts,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

@Injectable()
export class PublicationService {
  private readonly logger = new Logger(PublicationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionService,
    private readonly plans: PlanService,
    private readonly blob: BlobService,
  ) {}

  // ── User side ─────────────────────────────────────────────────────────

  /**
   * POST /sessions/:id/publications. The session must belong to the caller
   * (anonymous sessions have no userId → cannot publish: a channel needs
   * an owner). One open (PENDING/APPROVED) request per session+platform.
   */
  async create(
    userId: string,
    sessionId: string,
    dto: CreatePublicationRequestDto,
  ): Promise<PublicationRequestView> {
    // §23: очередь публикации — от Standard и выше.
    await this.plans.assertUser(userId, 'publication');
    const session = await this.ownSession(userId, sessionId);
    const snap = snapshotFromSession(session, dto);

    // Проверка «нет открытой заявки» и создание — две операции, и между
    // ними успевает вклиниться второй запрос: двойной клик по
    // «Опубликовать» давал две карточки в очереди оператора, а с §14 дал
    // бы две выгрузки на площадку (этап 38, А-1.4).
    //
    // ## Почему консультативная блокировка, а не уникальный индекс
    //
    // Правильная форма инварианта — частичный уникальный индекс
    // (`WHERE status IN ('PENDING','APPROVED')`), потому что база держала
    // бы его при любом пути записи, включая будущие. Но частичные
    // индексы не выражаются в `schema.prisma`, а CI сверяет базу со
    // схемой (`migrate diff`): индекс, которого в схеме нет, читался бы
    // как расхождение. Городить исключение в проверке ради одного
    // индекса — плохой размен, поэтому инвариант держится здесь.
    //
    // `pg_advisory_xact_lock`, а не `SELECT … FOR UPDATE`: блокировать
    // нечего — строки-родителя у пары «сессия + площадка» не существует.
    // Именно `xact`-вариант, а не сессионный: он снимается при коммите, и
    // это принципиально за пулером (PgBouncer в режиме транзакций), где
    // соединение возвращается в пул сразу после транзакции и сессионная
    // блокировка утекла бы на чужой запрос.
    const row = await this.prisma.$transaction(
      async (tx: typeof this.prisma) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`publication:${sessionId}:${dto.platform}`}))`;

        const open = await tx.publicationRequest.findFirst({
          where: {
            sessionId,
            platform: dto.platform,
            status: { in: ['PENDING', 'APPROVED'] },
          },
          select: { id: true, status: true },
        });
        if (open) {
          throw new ConflictException(
            `This video is already in the ${dto.platform} queue (${open.status})`,
          );
        }

        return (await tx.publicationRequest.create({
          data: {
            userId,
            sessionId,
            projectId: session.projectId ?? null,
            productItemId: session.productItemId ?? null,
            platform: dto.platform,
            ...snap,
          },
        })) as PublicationRow;
      },
    );
    // §22 (этап 39, А-2.6): заявка намеренно переживает сессию, но
    // ссылалась на файл, ВЛАДЕЛЕЦ которого — сессия. TTL в сутки уносил
    // его вместе с ней, и оператор в понедельник открывал пятничную
    // заявку с битой ссылкой. Своя копия под собственным префиксом
    // делает заявку самодостаточной.
    //
    // Копия делается ПОСЛЕ создания строки: до неё нет `id`, а без него
    // нет и пути. Сбой копирования не отменяет заявку — она останется со
    // ссылкой на файл сессии, то есть ровно с прежним поведением.
    return toView(await this.keepOwnCopy(row));
  }

  /** Собственная копия ролика заявки — см. комментарий в `create`. */
  private async keepOwnCopy(row: PublicationRow): Promise<PublicationRow> {
    const pathname = `publications/${row.id}/video.mp4`;
    const url = await this.blob.copyBlob(
      row.videoPathname,
      pathname,
      'video/mp4',
    );
    if (!url) return row;
    return (await this.prisma.publicationRequest.update({
      where: { id: row.id },
      data: { videoUrl: url, videoPathname: pathname },
    })) as PublicationRow;
  }

  /** GET /sessions/:id/publications — the session's requests, newest first. */
  async listForSession(
    userId: string,
    sessionId: string,
  ): Promise<PublicationRequestView[]> {
    await this.ownSession(userId, sessionId);
    const rows: PublicationRow[] =
      await this.prisma.publicationRequest.findMany({
        where: { sessionId },
        orderBy: { createdAt: 'desc' },
      });
    return rows.map(toView);
  }

  /** DELETE /sessions/:id/publications/:requestId — withdraw while PENDING. */
  async withdraw(
    userId: string,
    sessionId: string,
    requestId: string,
  ): Promise<void> {
    const row: PublicationRow | null =
      await this.prisma.publicationRequest.findFirst({
        where: { id: requestId, sessionId, userId },
      });
    if (!row)
      throw new NotFoundException(`Publication request ${requestId} not found`);
    if (row.status !== 'PENDING') {
      throw new BadRequestException(
        `Only PENDING requests can be withdrawn (this one is ${row.status})`,
      );
    }
    await this.prisma.publicationRequest.delete({ where: { id: requestId } });
    // Копия ролика принадлежала заявке — вместе с ней и уходит (§22).
    await this.blob.deleteMany([`publications/${requestId}/video.mp4`]);
  }

  // ── Operator side (/admin, behind AdminSessionGuard + isOperator) ──────

  async list(opts: {
    status?: string;
    page: number;
    pageSize: number;
  }): Promise<PublicationListResult> {
    const where =
      opts.status && STATUSES.has(opts.status)
        ? { status: opts.status as PublicationStatus }
        : {};
    const [rows, total, pending] = await Promise.all([
      this.prisma.publicationRequest.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (opts.page - 1) * opts.pageSize,
        take: opts.pageSize,
      }) as Promise<PublicationRow[]>,
      this.prisma.publicationRequest.count({ where }),
      this.prisma.publicationRequest.count({ where: { status: 'PENDING' } }),
    ]);
    return {
      items: rows.map(toView),
      total,
      page: opts.page,
      pageSize: opts.pageSize,
      pending,
    };
  }

  async get(id: string): Promise<PublicationRequestView> {
    return toView(await this.find(id));
  }

  /**
   * PENDING → APPROVED. Сама выгрузка — работа `PublishWorkerService`
   * (этап 61, ТЗ §14.5); здесь только назначается канал и приватность,
   * с которыми воркер её подхватит на следующем тике крона.
   */
  async approve(
    id: string,
    moderatorId: string,
    dto: ApprovePublicationRequestDto = {},
  ): Promise<PublicationRequestView> {
    const row = await this.find(id);
    if (row.status !== 'PENDING') {
      throw new BadRequestException(
        `Request is ${row.status}, only PENDING can be approved`,
      );
    }
    const channelId = await this.resolveChannelId(row, dto.channelId);
    const updated: PublicationRow = await this.prisma.publicationRequest.update(
      {
        where: { id },
        data: {
          status: 'APPROVED',
          moderatorId,
          moderatedAt: new Date(),
          rejectReason: null,
          channelId,
          privacy: dto.privacy ?? row.privacy,
        },
      },
    );
    return toView(updated);
  }

  /**
   * Разрешение канала при одобрении (§14.2, план этапа 61, решение 5).
   * Порядок: явный `channelId` (проверяется — должен принадлежать
   * автору заявки и совпадать по платформе) → канал проекта по
   * умолчанию → канал бренд-манифеста проекта по умолчанию → если у
   * автора ровно один активный канал этой платформы, использовать его
   * (наш собственный fallback сверх исходного ТЗ — в этом этапе нет
   * экрана «назначить канал по умолчанию», без него у автора с одним
   * каналом функция иначе была бы бесполезна). Ничего не найдено —
   * `null`: заявка остаётся APPROVED с пометкой «канал не подключён» в
   * UI, воркер такие строки не берёт (`WHERE channelId IS NOT NULL`).
   */
  private async resolveChannelId(
    row: PublicationRow,
    explicitChannelId?: string,
  ): Promise<string | null> {
    if (explicitChannelId) {
      const channel = await this.prisma.publishingChannel.findUnique({
        where: { id: explicitChannelId },
      });
      if (
        !channel ||
        channel.userId !== row.userId ||
        channel.platform !== row.platform
      ) {
        throw new BadRequestException(
          `channelId ${explicitChannelId} is not a valid ${row.platform} channel owned by this request's author`,
        );
      }
      return explicitChannelId;
    }

    const field =
      row.platform === 'YOUTUBE' ? 'youtubeChannelId' : 'tiktokChannelId';

    if (row.projectId) {
      const project = await this.prisma.project.findUnique({
        where: { id: row.projectId },
        select: {
          youtubeChannelId: true,
          tiktokChannelId: true,
          brandManifestId: true,
        },
      });
      const fromProject = project?.[field];
      if (fromProject) return fromProject;
      if (project?.brandManifestId) {
        const manifest = await this.prisma.brandManifest.findUnique({
          where: { id: project.brandManifestId },
          select: { youtubeChannelId: true, tiktokChannelId: true },
        });
        const fromManifest = manifest?.[field];
        if (fromManifest) return fromManifest;
      }
    }

    const candidates = await this.prisma.publishingChannel.findMany({
      where: { userId: row.userId, platform: row.platform, status: 'ACTIVE' },
      select: { id: true },
    });
    return candidates.length === 1 ? candidates[0].id : null;
  }

  /** PENDING → REJECTED with a reason the author will see. */
  async reject(
    id: string,
    moderatorId: string,
    dto: RejectPublicationRequestDto,
  ): Promise<PublicationRequestView> {
    const row = await this.find(id);
    if (row.status !== 'PENDING') {
      throw new BadRequestException(
        `Request is ${row.status}, only PENDING can be rejected`,
      );
    }
    const updated: PublicationRow = await this.prisma.publicationRequest.update(
      {
        where: { id },
        data: {
          status: 'REJECTED',
          moderatorId,
          moderatedAt: new Date(),
          rejectReason: dto.reason.trim(),
        },
      },
    );
    // Копия ролика больше не нужна никому (Б-1.2).
    //
    // Она заводилась ради одной вещи: чтобы заявка пережила TTL сессии и
    // оператору было что смотреть. Оператор посмотрел и отказал — дальше
    // это самый тяжёлый файл сервиса, за который платит владелец, а
    // удалить его было нечем: `withdraw` работает только на PENDING, и
    // после отказа маршрута не оставалось вовсе. Сама строка заявки
    // остаётся: автор должен видеть причину отказа.
    //
    // Сбой хранилища не отменяет решение оператора — оно уже записано, а
    // недобитый файл подберёт метла (с этапа 41 она ходит и по
    // префиксу `publications/`).
    // Путь берём из строки ДО обновления: `update` его не меняет, а
    // читать «после» значило бы зависеть от того, что вернул драйвер.
    await this.deleteVideoCopy(id, row.videoPathname);
    return toView(updated);
  }

  /**
   * FAILED → APPROVED, сброс backoff'а (§14.5). Оператор нажимает
   * «Повторить», когда причина ошибки устранена (например, канал
   * переподключили после REVOKED) — воркер подхватит заявку на
   * следующем тике, как и любую другую APPROVED с назначенным каналом.
   * `uploadJobId` тоже сбрасывается: старая resumable-сессия/publish_id
   * от неудачной попытки не должна путать новую.
   */
  async retry(id: string): Promise<PublicationRequestView> {
    const row = await this.find(id);
    if (row.status !== 'FAILED') {
      throw new BadRequestException(
        `Request is ${row.status}, only FAILED can be retried`,
      );
    }
    const updated: PublicationRow = await this.prisma.publicationRequest.update(
      {
        where: { id },
        data: {
          status: 'APPROVED',
          attempts: 0,
          nextAttemptAt: null,
          publishError: null,
          uploadJobId: null,
        },
      },
    );
    return toView(updated);
  }

  /**
   * Удалить собственную копию ролика заявки, не роняя вызывающего.
   *
   * У заявок, созданных до этапа 39, `videoPathname` указывает на файл
   * СЕССИИ — его трогать нельзя, он принадлежит ей. Поэтому удаляется
   * строго собственный префикс заявки.
   */
  private async deleteVideoCopy(
    requestId: string,
    videoPathname?: string | null,
  ): Promise<void> {
    const own = `publications/${requestId}/`;
    if (videoPathname && !videoPathname.startsWith(own)) return;
    try {
      await this.blob.deleteMany([`${own}video.mp4`]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `Не удалось удалить копию ролика отклонённой заявки ${requestId}: ${message} — файл подберёт метла`,
      );
    }
  }

  // ── Internals ─────────────────────────────────────────────────────────

  private async ownSession(
    userId: string,
    sessionId: string,
  ): Promise<Session> {
    const session = await this.sessions.getSession(sessionId);
    if (!session) throw new NotFoundException(`Session ${sessionId} not found`);
    const owner = await this.prisma.session.findUnique({
      where: { id: sessionId },
      select: { userId: true },
    });
    if (!owner?.userId) {
      throw new ForbiddenException(
        'Publishing needs a signed-in owner — this session was created anonymously',
      );
    }
    if (owner.userId !== userId) {
      throw new ForbiddenException('This session belongs to another user');
    }
    return session;
  }

  private async find(id: string): Promise<PublicationRow> {
    const row: PublicationRow | null =
      await this.prisma.publicationRequest.findUnique({
        where: { id },
      });
    if (!row)
      throw new NotFoundException(`Publication request ${id} not found`);
    return row;
  }
}
