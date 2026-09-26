/**
 * Находка из мини-аппа (этап 160,
 * `docs-tz/TZ-Rabota-s-Testirovshchikom.md` §3.8).
 *
 * ## Чем отличается от входа из бота
 *
 * Одним — и в этом весь смысл второго входа: окружение снимается В
 * МОМЕНТ находки, а сессия, шаг и сценарий подставляются сами.
 * Тикет из бота получает последнее известное окружение и не знает, где
 * человек был; здесь знает всё.
 *
 * ## Чему здесь не верят
 *
 * Клиент присылает текст, шаг и окружение — их и берём. Но НЕ сценарий
 * и НЕ локаль ролика: и то и другое читается с сессии на сервере.
 * Причина не в недоверии к человеку, а в том, что по этим полям
 * фильтруют и группируют: значение, которое клиент может прислать
 * любым, в фильтре бесполезно.
 *
 * Сессия при этом обязана принадлежать ему. Чужой `sessionId` в теле —
 * это не диверсия, а обычная опечатка при отладке, но тикет с чужим
 * проектом в карточке уведёт разбор не туда.
 */

import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { BlobService } from '../storage/blob.service';
import { envKeyOf, normalizeEnvironment } from '../../common/environment';
import {
  MAX_ATTACHMENTS,
  APP_ATTACHMENT_LIMIT,
  attachmentPath,
  isAllowedAttachmentType,
  isOwnAttachmentPath,
} from '../../common/test-ticket';
import {
  scenarioOfProjectType,
  testAccessActive,
} from '../../common/test-user-scenarios';

export interface IntakeInput {
  text: string;
  sessionId?: string | null;
  stepId?: string | null;
  environment?: unknown;
  attachments?: Array<{
    pathname: string;
    mimeType?: string;
    fileName?: string;
  }>;
}

@Injectable()
export class TestTicketIntakeService {
  private readonly logger = new Logger(TestTicketIntakeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly blob: BlobService,
  ) {}

  /** Куда браузеру класть файл. Ссылка одноразовая и короткоживущая. */
  async uploadUrl(
    telegramUserId: string,
    input: { mimeType: string; sizeBytes: number },
  ): Promise<{ pathname: string; uploadUrl: string }> {
    const user = await this.tester(telegramUserId);
    if (!isAllowedAttachmentType(input.mimeType)) {
      throw new BadRequestException(
        'К находке прикладывают снимок экрана, запись или текстовый файл — ' +
          'остальное разбору не помогает.',
      );
    }
    if (!Number.isFinite(input.sizeBytes) || input.sizeBytes <= 0) {
      throw new BadRequestException('Не вижу размера файла.');
    }
    if (input.sizeBytes > APP_ATTACHMENT_LIMIT) {
      throw new BadRequestException(
        `Файл больше ${Math.round(APP_ATTACHMENT_LIMIT / 1024 / 1024)} МБ. ` +
          'Пришлите фрагмент или снимок экрана.',
      );
    }
    const pathname = attachmentPath(user.id, Date.now());
    const { uploadUrl } = await this.blob.createUploadUrl(
      pathname,
      input.mimeType,
      APP_ATTACHMENT_LIMIT,
    );
    return { pathname, uploadUrl };
  }

  async create(
    telegramUserId: string,
    input: IntakeInput,
    now: Date = new Date(),
  ): Promise<{ id: string; number: number }> {
    const user = await this.tester(telegramUserId);

    const text = input.text?.trim() ?? '';
    const claimed = (input.attachments ?? []).slice(0, MAX_ATTACHMENTS);
    if (!text && !claimed.length) {
      throw new BadRequestException(
        'Опишите, что сломалось, — или приложите снимок экрана.',
      );
    }

    const environment = normalizeEnvironment(input.environment);
    const session = await this.sessionOf(user.id, input.sessionId);

    // Вложения подтверждаются по факту, а не по слову клиента: ссылку
    // выдали — файл ещё не загружен, и сорвавшийся PUT оставил бы в
    // тикете путь, по которому ничего нет. Тот же урок, что у фото
    // товара (В-1.8, этап 123), — только подтверждением здесь работает
    // само создание тикета, третий запрос ради этого не нужен.
    const attachments = (
      await Promise.all(claimed.map((a) => this.confirm(a, user.id)))
    ).filter((a): a is StoredAttachment => a !== null);

    const ticket = await this.prisma.testTicket.create({
      data: {
        userId: user.id,
        inviteId: user.inviteId,
        source: 'APP',
        text,
        attachments: attachments as unknown as object,
        lastMessageAt: now,
        sessionId: session?.id ?? null,
        // Сценарий и локаль ролика — с СЕРВЕРА: по ним фильтруют и
        // группируют, а присланное клиентом в фильтре бесполезно.
        scenario: session?.scenario ?? null,
        sessionLocale: session?.locale ?? null,
        stepId: input.stepId?.trim().slice(0, 64) || null,
        uiLocale: environment?.uiLocale || 'unknown',
        env: (environment as unknown as object) ?? undefined,
        envKey: environment
          ? envKeyOf(environment, {
              scenario: session?.scenario ?? null,
              stepId: input.stepId ?? null,
            })
          : null,
        // Снято здесь и сейчас — в этом и смысл второго входа.
        envCapturedAt: environment ? now : null,
        appBuild: environment?.appBuild ?? null,
      },
      select: { id: true, number: true },
    });
    this.logger.log(
      `находка #${ticket.number} из мини-аппа: сессия ${session?.id ?? '—'}, ` +
        `шаг ${input.stepId ?? '—'}, вложений ${attachments.length}`,
    );
    return ticket;
  }

  /** Тестировщик с действующим доступом — иначе форму показывать было незачем. */
  private async tester(
    telegramUserId: string,
  ): Promise<{ id: string; inviteId: string | null }> {
    const user = await this.prisma.user.findUnique({
      where: { telegramId: telegramUserId },
      select: {
        id: true,
        isTestUser: true,
        testAccessUntil: true,
        testerInvites: {
          where: { revokedAt: null },
          orderBy: { activatedAt: 'desc' },
          take: 1,
          select: { id: true },
        },
      },
    });
    if (!user || !testAccessActive(user)) {
      // 403, а не тихий отказ: сюда приходят только по кнопке, которой
      // у нетестировщика нет. Раз пришли — что-то разошлось, и об этом
      // лучше узнать.
      throw new ForbiddenException(
        'Тестовый доступ не действует — находки принимаются только по нему.',
      );
    }
    return { id: user.id, inviteId: user.testerInvites[0]?.id ?? null };
  }

  /** Сессия, её сценарий и локаль ролика — если она принадлежит ему. */
  private async sessionOf(
    userId: string,
    sessionId: string | null | undefined,
  ): Promise<{
    id: string;
    scenario: string | null;
    locale: string | null;
  } | null> {
    const id = sessionId?.trim();
    if (!id) return null;
    const row = await this.prisma.session.findUnique({
      where: { id },
      select: {
        id: true,
        userId: true,
        data: true,
        project: { select: { type: true } },
      },
    });
    // Чужая или неизвестная сессия просто не прикладывается: терять
    // из-за неё текст находки было бы куда хуже, чем потерять ссылку.
    if (!row || row.userId !== userId) return null;
    const data = row.data as { locale?: unknown } | null;
    return {
      id: row.id,
      scenario: scenarioOfProjectType(row.project?.type) ?? null,
      locale: typeof data?.locale === 'string' ? data.locale : null,
    };
  }

  private async confirm(
    claim: {
      pathname: string;
      mimeType?: string;
      fileName?: string;
    },
    userId: string,
  ): Promise<StoredAttachment | null> {
    const pathname = claim.pathname?.trim();
    // Путь обязан быть тем, что выдали ЕМУ (аудит этапа 160). Проверка
    // на `users/` и `/tickets/` по отдельности пропускала папку
    // другого тестировщика — то есть ровно тот случай, который она и
    // должна была закрыть.
    if (!pathname || !isOwnAttachmentPath(pathname, userId)) return null;
    try {
      const head = await this.blob.head(pathname);
      if (!head) return null;
      return {
        url: head.url,
        kind: kindOf(claim.mimeType),
        size: head.size,
        fileName: claim.fileName?.slice(0, 120) ?? null,
        mimeType: claim.mimeType ?? null,
      };
    } catch (error) {
      this.logger.warn(
        `вложение не подтвердилось (${pathname}): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return null;
    }
  }
}

interface StoredAttachment {
  url: string;
  kind: string;
  size: number;
  fileName: string | null;
  mimeType: string | null;
}

function kindOf(mimeType: string | undefined): string {
  if (!mimeType) return 'DOCUMENT';
  if (mimeType.startsWith('image/')) return 'PHOTO';
  if (mimeType.startsWith('video/')) return 'VIDEO';
  if (mimeType.startsWith('audio/')) return 'AUDIO';
  return 'DOCUMENT';
}
