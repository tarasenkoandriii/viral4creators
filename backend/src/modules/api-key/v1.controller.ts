/**
 * `/v1` — внешнее API (этап 144, docs-tz/TZ-Vneshnee-API.md).
 *
 * Версия стоит в пути с самого первого маршрута, а не появится потом:
 * чужой код опирается на форматы, и добавить `/v1` задним числом — это
 * сломать всех, кто уже интегрировался, ровно тем действием, которое
 * задумывалось как забота о них.
 *
 * ## Форма ответа задаётся не здесь (аудит этапа 144)
 *
 * Успех заворачивается глобальным `ResponseInterceptor` в
 * `{success, data, meta}`, отказ — глобальным `HttpExceptionFilter` в
 * `{error: {code, message}, meta}`. То есть наружу уходит не то, что
 * возвращает метод, а `data` внутри конверта, и `meta.requestId` — тот
 * самый номер, по которому интегратор придёт в поддержку.
 *
 * Для внутренних маршрутов это деталь; для `/v1` — часть публичного
 * контракта, которую держат две строки в `main.ts`. Поэтому конверт
 * описан в `doc/API.md` и сторожится швом в `check-docs`: снять
 * интерцептор «для порядка» — значит молча сломать чужие интеграции.
 *
 * Сегодня здесь один читающий маршрут. Он не заглушка: интегратор
 * первым делом проверяет, что ключ работает, и делать эту проверку
 * платным вызовом было бы дорого и ему, и нам. Генерация (`202` +
 * `jobId`, идемпотентность) — этап 145.
 */

import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { ApiKeyGuard, ApiKeyRequest } from './api-key.guard';
import { PlanService } from '../plan/plan.service';
import { PlanId } from '../../common/plans';
import { ApiVideoJobService, SubmitInput } from './api-video-job.service';
import { ApiVideoJobView } from '../../common/api-video-job';

export interface V1Me {
  /** Режим — от него зависит, что вообще можно вызывать. */
  plan: PlanId;
  /**
   * Суточный потолок расхода — в микродолларах, тот же масштаб, что у
   * `AiUsage.costMicroUsd` и у экрана расходов.
   *
   * Отдаётся здесь, потому что это ВТОРОЙ вопрос интегратора после
   * «работает ли ключ» и единственное, что остановит его скрипт.
   * Молчать о нём — значит дать узнать о потолке по 403 посреди боя
   * (аудит этапа 144).
   */
  budget: {
    limitMicroUsd: number;
    spentMicroUsd: number;
    remainingMicroUsd: number;
  };
  /** Ключ, которым вошли, — чтобы в CI было видно, какой именно сработал. */
  apiKeyId: string;
}

@Controller('v1')
@UseGuards(ApiKeyGuard)
export class V1Controller {
  constructor(
    private readonly plans: PlanService,
    private readonly jobs: ApiVideoJobService,
  ) {}

  /**
   * Кто я. Бесплатно и без побочных действий — на этот маршрут
   * интегратор будет ходить в каждом healthcheck.
   *
   * Поля «заблокирован» здесь нет намеренно: до обработчика
   * заблокированный аккаунт не доходит, гвард отказывает раньше.
   * Поле, которое не может быть `true`, — это ветка в чужом коде,
   * которая не выполнится ни разу (аудит этапа 144).
   */
  @Get('me')
  async me(@Req() req: ApiKeyRequest): Promise<V1Me> {
    const budget = await this.plans.budgetOf(req.telegramUserId);
    return {
      plan: budget.plan,
      budget: {
        limitMicroUsd: budget.limitMicroUsd,
        spentMicroUsd: budget.spentMicroUsd,
        remainingMicroUsd: budget.remainingMicroUsd,
      },
      apiKeyId: req.apiKeyId,
    };
  }

  /**
   * Заказать ролик. Отвечает `202` и номером заявки: генерация длится
   * минуты, а фона у serverless нет — доводит её крон.
   *
   * Повтор с тем же `Idempotency-Key` отвечает `200` и той же заявкой.
   * Разные коды не украшение: чужой код по ним отличает «приняли» от
   * «уже принимали», и без этой разницы повтор после таймаута выглядит
   * как вторая генерация, за которую сейчас спишут.
   *
   * `@Res({passthrough: true})`, а не `@HttpCode`: код зависит от
   * результата, а не от маршрута, и общий конверт ответа при этом
   * остаётся на месте (см. шапку файла).
   */
  @Post('videos')
  @HttpCode(202)
  async createVideo(
    @Req() req: ApiKeyRequest,
    @Body() body: SubmitInput,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ApiVideoJobView> {
    const { job, repeated } = await this.jobs.submit(
      req.telegramUserId,
      req.apiKeyId,
      body ?? ({} as SubmitInput),
      idempotencyKey?.trim() || null,
    );
    if (repeated) res.status(200);
    return job;
  }

  /**
   * Состояние заявки. Опрос — единственный способ узнать результат до
   * вебхуков (этап 146), и он останется после них: вебхук без опроса —
   * обещание, которое некому проверить.
   */
  @Get('videos/:jobId')
  video(
    @Req() req: ApiKeyRequest,
    @Param('jobId') jobId: string,
  ): Promise<ApiVideoJobView> {
    return this.jobs.get(req.telegramUserId, jobId);
  }
}
