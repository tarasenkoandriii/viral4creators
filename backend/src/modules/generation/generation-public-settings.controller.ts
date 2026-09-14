import { Controller, Get } from '@nestjs/common';
import { AdminVideoProviderSettingsService } from '../admin-panel/admin-video-provider-settings.service';

/**
 * Публичный (не админский) эндпоинт для чтения провайдера видео-
 * генерации по умолчанию — тот самый, что задаёт оператор на
 * `/admin/settings` (`AdminVideoProviderSettingsService`, §11.1 ТЗ
 * VEO-MODEL-VERSION-CHOICE-SPEC.md). Нужен мастеру генерации
 * (`GenerationWizard.tsx`), который вызывается обычным пользователем,
 * не оператором — админские эндпоинты (`/admin/settings/...`) требуют
 * `assertOperator` и пользователю недоступны.
 *
 * Отдельный, не вложенный в `sessions/:sessionId` контроллер — этот
 * дефолт не привязан к конкретной сессии, это глобальная настройка
 * платформы (та же логика, что уже применена к `GenerationController`
 * не подходит здесь просто потому, что там весь роутинг завязан на
 * `:sessionId`).
 */
@Controller('generation-settings')
export class GenerationPublicSettingsController {
  constructor(
    private readonly videoProviderSettings: AdminVideoProviderSettingsService,
  ) {}

  /**
   * Возвращает только `active`/`options` — не весь `source`
   * (админский/env-фоллбек), это внутренняя деталь для админ-экрана,
   * не для конечного пользователя.
   */
  @Get('default-provider')
  async getDefaultProvider(): Promise<{
    provider: 'grok' | 'veo';
    options: ('grok' | 'veo')[];
  }> {
    const { active, options } = await this.videoProviderSettings.get();
    return { provider: active, options: options.map((o) => o.key) };
  }
}
