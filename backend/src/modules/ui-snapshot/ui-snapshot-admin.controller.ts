/**
 * UiSnapshotAdminController — разовый прогон снимков по требованию
 * оператора (этап H ТЗ `docs-tz/TZ-Enterprise-Tutorial-Landing.md`).
 *
 * Тот же приём, что у `FixtureSeedAdminController`: собственный
 * контроллер внутри фиче-модуля, `AdminSessionGuard` плюс
 * `assertOperator`, работа делается уже подключённым сервисом
 * работающего процесса — оператору не нужен доступ к серверу.
 *
 * ## Зачем он, если крон и так ходит каждые две минуты
 *
 * Крон ходит по ОДНОЙ комбинации (пять маршрутов, `ru`, светлая тема, с
 * масками) — это его работа, и менять её под разовую задачу нельзя.
 * Здесь нужна другая: снять мастер обучалки в тёмной теме, в нужной
 * локали и БЕЗ масок, чтобы кадр сайта был виден. До этого этапа такая
 * комбинация требовала правки констант в коде и деплоя.
 *
 * ## Чего эндпоинт НЕ делает
 *
 * Не пишет строк `UiSnapshot` при `unmasked` и не шлёт тревогу
 * «изменилось» — иначе снимок «на показ» подменил бы базовый отпечаток
 * и следующий тик крона закричал бы на собственную же картинку (см.
 * `UiSnapshotRunOptions.unmasked`). Адреса файлов возвращаются в
 * `outcomes[].blobUrl`.
 *
 * Тревог в служебный канал не шлёт (`alerts: false`): вызывающий
 * получает и сбои, и адреса файлов синхронно, в ответе. Если прогон не
 * успел обойти все маршруты за бюджет времени, в ответе будет
 * `deferred` — сколько осталось.
 *
 * Джоб-лок крона он тоже не берёт: это разовое действие человека, а не
 * вторая копия расписания. Два одновременных прогона по одним маршрутам
 * друг другу не мешают — каждый пишет свой файл со своей меткой
 * времени.
 */
import {
  BadRequestException,
  Body,
  Controller,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  AdminAuthenticatedRequest,
  AdminSessionGuard,
} from '../admin-auth/admin-session.guard';
import { AdminPanelService } from '../admin-panel/admin-panel.service';
import { SUPPORTED_LOCALES } from '../../common/locale';
import {
  UiSnapshotRunnerService,
  type SnapshotTheme,
  type UiSnapshotRunResult,
} from './ui-snapshot-runner.service';

interface RunSnapshotBody {
  locale?: unknown;
  theme?: unknown;
  routeKeys?: unknown;
  unmasked?: unknown;
}

@Controller('admin/ui-snapshot')
@UseGuards(AdminSessionGuard)
export class UiSnapshotAdminController {
  constructor(
    private readonly adminPanel: AdminPanelService,
    private readonly runner: UiSnapshotRunnerService,
  ) {}

  @Post('run')
  async run(
    @Req() req: AdminAuthenticatedRequest,
    @Body() body: RunSnapshotBody,
  ): Promise<UiSnapshotRunResult> {
    await this.adminPanel.assertOperator(req.userId);

    // Локаль проверяется по списку продукта, а не принимается любой
    // строкой: `UiSnapshot.locale` — свободное поле, и опечатка «rи»
    // завела бы отдельную ветку истории сравнений, которую никто
    // никогда не увидит, потому что крон в неё не ходит.
    let locale: string | undefined;
    if (body.locale !== undefined) {
      if (
        typeof body.locale !== 'string' ||
        !(SUPPORTED_LOCALES as readonly string[]).includes(body.locale)
      ) {
        throw new BadRequestException(
          `locale должен быть одним из: ${SUPPORTED_LOCALES.join(', ')}`,
        );
      }
      locale = body.locale;
    }

    let theme: SnapshotTheme | undefined;
    if (body.theme !== undefined) {
      if (body.theme !== 'light' && body.theme !== 'dark') {
        throw new BadRequestException('theme должен быть light или dark');
      }
      theme = body.theme;
    }

    let routeKeys: string[] | undefined;
    if (body.routeKeys !== undefined) {
      if (
        !Array.isArray(body.routeKeys) ||
        body.routeKeys.length === 0 ||
        body.routeKeys.some((k) => typeof k !== 'string' || k.trim() === '')
      ) {
        throw new BadRequestException(
          'routeKeys — непустой массив имён маршрутов (см. ROUTE_DESCRIPTIONS в route-templates.ts)',
        );
      }
      routeKeys = (body.routeKeys as string[]).map((k) => k.trim());
    }

    // Неизвестное имя маршрута сюда не проверяем специально: резолвер
    // ответит на него понятной причиной в `outcomes[].error`, и это
    // лучше, чем 400 без указания, какой именно из пяти переданных
    // ключей плох.
    // `alerts: false` — правка аудита. Первая редакция слала тревоги в
    // служебный канал и при ручном вызове, рассуждая, что «молчание —
    // худший ответ». Молчания здесь нет: весь результат уходит
    // вызывающему синхронно, ответом на этот запрос. А канал засорялся
    // сообщениями о сбоях, которые человек уже видит перед собой.
    return this.runner.run({
      locale,
      theme,
      routeKeys,
      unmasked: body.unmasked === true,
      alerts: false,
    });
  }
}
