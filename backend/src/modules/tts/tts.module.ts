import { Global, Module } from '@nestjs/common';
import { ElevenLabsService } from './elevenlabs.service';
import { ResembleService } from './resemble.service';
import { VeoPassthroughService } from './veo-passthrough.service';
import { TtsProviderResolverService } from './tts-provider-resolver.service';
import { TtsController } from './tts.controller';
import { PlatformSettingsService } from '../../common/platform-settings.service';

/**
 * Переключаемый провайдер синтеза — doc/TTS-PROVIDER-ALTERNATIVES-SPEC.md
 * §4.1 (решение принято §5.2 ТЗ: Resemble рядом с ElevenLabs, не вместо).
 *
 * До ручного селектора в админке (доп. запрос владельца продукта:
 * «не всегда есть деньги на балансе аккаунтов ElevenLabs/Resemble —
 * нужно уметь быстро откатиться на бесплатный голос Veo») здесь стоял
 * DI-токен `TTS_PROVIDER` со СТАТИЧЕСКОЙ фабрикой: читал
 * `process.env.TTS_PROVIDER` один раз при холодном старте функции и
 * не менялся до следующего передеплоя. Теперь выбор — «Озвучка по
 * умолчанию» — живёт в `PlatformSetting` (табличка, редактируется
 * оператором из /settings без передеплоя) и перечитывается на каждый
 * вызов через `TtsProviderResolverService.resolve()` — см. её
 * доккомментарий за тем, почему это отдельный сервис с методом
 * `resolve()`, а не сам DI-токен: `TtsProvider.providerKey` — обычное
 * синхронное поле, а выбор активного провайдера теперь асинхронный
 * (БД + короткий кеш).
 *
 * `TTS_PROVIDER`/`tts-provider.token.ts` больше никем не используется
 * (обновлено во всех потребителях — tts.controller.ts,
 * project-session.service.ts, brand-manifest.service.ts,
 * postprod.service.ts) и намеренно не удалён из репозитория: файл
 * держит подробный доккомментарий о цикле импортов, который он когда-то
 * чинил — тот же урок пригодится, если сюда вернётся DI-токен под
 * что-нибудь ещё.
 *
 * `VeoPassthroughService` — третий пункт селектора («voiceMode: veo» в
 * терминах бренда, но здесь — «не пытаться синтезировать вовсе»): не
 * настоящий провайдер, всегда мягко пропускает синтез, поэтому ролик
 * остаётся со звуком, который написала сама Veo — тот же путь, что и
 * «ключ не задан» до этой фичи (см. её собственный доккомментарий).
 */
@Global()
@Module({
  controllers: [TtsController],
  providers: [
    ElevenLabsService,
    ResembleService,
    VeoPassthroughService,
    PlatformSettingsService,
    TtsProviderResolverService,
  ],
  // `ElevenLabsService`/`ResembleService` экспортируются по отдельности
  // (не только через `TtsProviderResolverService`): `ResembleService` —
  // пилот говорящего аватара (этап 72, doc/AVATAR-LIPSYNC-PIPELINE-SPEC.md
  // §3.2, шаг 2) использует именно Resemble напрямую, а не активный на
  // стенде выбор; `ElevenLabsService` — `AdminVoiceoverSettingsService`
  // (admin-panel, вне этого модуля) читает `configured()` у ОБОИХ
  // провайдеров напрямую, чтобы показать в /settings, какие из них вообще
  // на этом стенде настроены — @Global() делает провайдер доступным
  // снаружи, только если он в этом списке, а не просто зарегистрирован.
  exports: [
    TtsProviderResolverService,
    PlatformSettingsService,
    ElevenLabsService,
    ResembleService,
  ],
})
export class TtsModule {}
