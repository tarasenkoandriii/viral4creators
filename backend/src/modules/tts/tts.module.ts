import { Global, Module } from '@nestjs/common';
import { ElevenLabsService } from './elevenlabs.service';
import { ResembleService } from './resemble.service';
import { TtsController } from './tts.controller';
import { TtsProvider } from './tts.types';

/**
 * Переключаемый провайдер синтеза — doc/TTS-PROVIDER-ALTERNATIVES-SPEC.md
 * §4.1 (решение принято §5.2 ТЗ: Resemble рядом с ElevenLabs, не вместо).
 * Токен, а не конкретный класс: `TTS_PROVIDER` в окружении выбирает
 * активного провайдера без единой правки в местах вызова.
 *
 * Реестр, а не `if/else` на два случая — так следующий провайдер
 * (Cartesia, §5.2а ТЗ — если/когда понадобится задача, где реализм не
 * главный критерий) добавляется без переделки этого модуля.
 */
export const TTS_PROVIDER = Symbol('TTS_PROVIDER');

@Global()
@Module({
  controllers: [TtsController],
  providers: [
    ElevenLabsService,
    ResembleService,
    {
      provide: TTS_PROVIDER,
      useFactory: (
        eleven: ElevenLabsService,
        resemble: ResembleService,
      ): TtsProvider => {
        const registry: Record<string, TtsProvider> = {
          elevenlabs: eleven,
          resemble,
        };
        const key =
          process.env.TTS_PROVIDER?.trim().toLowerCase() || 'elevenlabs';
        // Неизвестное значение — тихий откат на ElevenLabs, а не падение
        // приложения на старте: тот же принцип мягкого фоллбека, что и
        // внутри самих провайдеров (см. elevenlabs.service.ts, шапка).
        return registry[key] ?? eleven;
      },
      inject: [ElevenLabsService, ResembleService],
    },
  ],
  // `ResembleService` экспортируется отдельно от `TTS_PROVIDER` (этап
  // 72, doc/AVATAR-LIPSYNC-PIPELINE-SPEC.md §3.2, шаг 2): пилот
  // говорящего аватара использует именно Resemble, а не активный на
  // стенде `TTS_PROVIDER` — владелец продукта выбрал этот провайдер
  // явно для этой задачи, независимо от того, чем сейчас озвучивает
  // обычный Veo-пайплайн (`postprod.service.ts`).
  exports: [TTS_PROVIDER, ResembleService],
})
export class TtsModule {}
