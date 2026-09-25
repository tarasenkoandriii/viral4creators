/**
 * ApiVideoJobService — приём заявки внешнего API на ролик (этап 145,
 * docs-tz/TZ-Vneshnee-API.md).
 *
 * ## Почему `202`, а не готовый ролик
 *
 * Генерация длится минуты. HTTP-запрос столько не живёт, а фона у
 * serverless нет — обещанная «потом» работа умирает вместе с ответом
 * (записано в `wizard-guide/translation.service.ts`). Значит ответ —
 * номер заявки, а доводит её крон.
 *
 * ## Почему потолок проверяется ЗДЕСЬ, хотя он проверяется и внутри
 *
 * `generateVideo` всё равно упрётся в суточный потолок и откажет. Но
 * это случится через минуту, в кроне, и чужой код узнает об отказе не
 * из ответа на свой запрос, а из состояния заявки — если вообще пойдёт
 * за ним. Интегратор, у которого «всё принято, а роликов нет», ищет
 * ошибку у себя. Поэтому выбранный потолок — отказ на подаче, сразу и с
 * числами.
 *
 * Обратное неверно: пройденная проверка на подаче ничего не гарантирует
 * — потолок могут выбрать соседние вызовы, пока заявка ждёт очереди.
 * Она здесь не вместо проверки в `generateVideo`, а до неё.
 */

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { PlanService } from '../plan/plan.service';
import { SUPPORTED_LOCALES } from '../../common/locale';
import { canView } from '../library/library.service';
import {
  ApiVideoJobView,
  ApiVideoRequest,
  requestFingerprint,
  toJobView,
} from '../../common/api-video-job';

export interface SubmitInput {
  productItemId: string;
  libraryEntryId: string;
  quality?: string;
  aspectRatio?: string;
  locale?: string;
}

/** Нормализованное тело запроса. Отпечаток считается уже по нему. */
export function normalizeRequest(
  input: SubmitInput,
): ApiVideoRequest & { productItemId: string; libraryEntryId: string } {
  const text = (value: unknown): string =>
    typeof value === 'string' ? value.trim() : '';
  const productItemId = text(input.productItemId);
  const libraryEntryId = text(input.libraryEntryId);
  if (!productItemId || !libraryEntryId) {
    throw new BadRequestException(
      'Нужны productItemId и libraryEntryId: что снимаем и по какому референсу',
    );
  }
  // Неизвестное качество — отказ, а не тихий откат к дешёвому. Чужой код
  // просил «standard» и получил бы «fast», не узнав об этом.
  const quality = text(input.quality) || 'fast';
  if (quality !== 'fast' && quality !== 'standard') {
    throw new BadRequestException('quality: fast или standard');
  }
  // Ровно тот же довод и для языка (аудит этапа 147). Описание
  // объявляет перечисление, а первая редакция принимала любую строку:
  // опечатка в локали молча давала ролик не на том языке, и узнать об
  // этом можно было только посмотрев готовое.
  const locale = text(input.locale);
  if (locale && !(SUPPORTED_LOCALES as readonly string[]).includes(locale)) {
    throw new BadRequestException(`locale: ${SUPPORTED_LOCALES.join(', ')}`);
  }
  return {
    productItemId,
    libraryEntryId,
    quality,
    aspectRatio: text(input.aspectRatio) || null,
    locale: locale || null,
  };
}

@Injectable()
export class ApiVideoJobService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly plans: PlanService,
  ) {}

  /**
   * Принять заявку. Возвращает её вид и признак «это повтор» — чтобы
   * маршрут ответил `200` вместо `202`: чужой код по коду ответа должен
   * отличать «принято» от «уже принимали».
   */
  async submit(
    userId: string,
    apiKeyId: string,
    input: SubmitInput,
    idempotencyKey: string | null,
  ): Promise<{ job: ApiVideoJobView; repeated: boolean }> {
    const request = normalizeRequest(input);
    const fingerprint = requestFingerprint(request);

    if (idempotencyKey) {
      const existing = await this.prisma.apiVideoJob.findUnique({
        where: { userId_idempotencyKey: { userId, idempotencyKey } },
      });
      if (existing) {
        // Тот же ключ с ДРУГИМ телом — не повтор, а переиспользованный
        // ключ. Отдать в ответ чужую заявку значит спрятать ошибку до
        // момента, когда она будет стоить дорого.
        if (existing.fingerprint !== fingerprint) {
          throw new ConflictException(
            'Idempotency-Key уже использован с другим телом запроса',
          );
        }
        return { job: toJobView(existing), repeated: true };
      }
    }

    const projectId = await this.projectOf(userId, request.productItemId);
    await this.assertLibraryEntry(userId, request.libraryEntryId);
    await this.assertBudget(userId);

    const created = await this.prisma.apiVideoJob.create({
      data: {
        userId,
        apiKeyId,
        idempotencyKey,
        fingerprint,
        projectId,
        productItemId: request.productItemId,
        libraryEntryId: request.libraryEntryId,
        quality: request.quality,
        aspectRatio: request.aspectRatio,
        locale: request.locale,
      },
    });
    return { job: toJobView(created), repeated: false };
  }

  /** Состояние заявки. Чужая по `jobId` не отдаётся — её просто нет. */
  async get(userId: string, jobId: string): Promise<ApiVideoJobView> {
    const row = await this.prisma.apiVideoJob.findFirst({
      where: { id: jobId, userId },
    });
    if (!row) throw new NotFoundException('Заявка не найдена');
    return toJobView(row);
  }

  /**
   * Товар должен существовать, быть живым и принадлежать хозяину ключа.
   * Проверяется НА ПОДАЧЕ: чужой id в теле — ошибка интегратора, и
   * узнать о ней он должен из ответа, а не из заявки, упавшей через
   * минуту.
   */
  private async projectOf(
    userId: string,
    productItemId: string,
  ): Promise<string> {
    const item = (await this.prisma.productItem.findFirst({
      where: {
        id: productItemId,
        deletedAt: null,
        project: { userId, deletedAt: null },
      },
      select: { projectId: true },
    })) as { projectId: string } | null;
    if (!item) throw new NotFoundException('Товар не найден');
    return item.projectId;
  }

  /**
   * Разбор референса должен существовать и быть видимым этому
   * человеку (аудит этапа 147).
   *
   * Первая редакция проверяла только товар, а описание обещало `404` и
   * за разбор: опечатка в `libraryEntryId` принималась с `202` и
   * падала через минуту, в кроне. Это ровно тот довод, по которому
   * проверяется товар, — просто про второй идентификатор про него
   * забыли.
   *
   * Правило видимости то же, что при просмотре: взять нельзя то, чего
   * не видно (§21.3). Не «чужое», а «нет» — чужой приватный разбор не
   * должен подтверждать сам факт своего существования.
   */
  private async assertLibraryEntry(
    userId: string,
    entryId: string,
  ): Promise<void> {
    const row = (await this.prisma.analysisLibraryEntry.findUnique({
      where: { id: entryId },
      select: { visibility: true, userId: true },
    })) as { visibility: string; userId: string | null } | null;
    if (!row || !canView(row as never, userId)) {
      throw new NotFoundException('Разбор референса не найден');
    }
  }

  /** Выбранный на сегодня потолок — отказ сразу и с числами. */
  private async assertBudget(userId: string): Promise<void> {
    const budget = await this.plans.budgetOf(userId);
    if (budget.remainingMicroUsd > 0) return;
    const usd = (micro: number) => `$${(micro / 1_000_000).toFixed(2)}`;
    throw new ForbiddenException(
      `Суточный потолок расхода выбран: ${usd(budget.spentMicroUsd)} из ${usd(budget.limitMicroUsd)}. ` +
        'Заявка не принята — она всё равно не дошла бы до генерации.',
    );
  }
}
