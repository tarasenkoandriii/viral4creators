import { Module } from '@nestjs/common';
import { AUDIO_PROVIDERS } from './audio.constants';
import { AudioService } from './audio.service';
import { JamendoProvider } from './providers/jamendo.provider';
import { FreesoundProvider } from './providers/freesound.provider';
import { MubertProvider } from './providers/mubert.provider';

/**
 * Адаптеры конструирует сам контейнер, фабрика собирает их в массив —
 * никакого ручного реестра. Добавить провайдера: дописать класс сюда и
 * в фабрику; `AudioService` и вызывающие не меняются.
 */
@Module({
  providers: [
    JamendoProvider,
    FreesoundProvider,
    MubertProvider,
    {
      provide: AUDIO_PROVIDERS,
      useFactory: (
        jamendo: JamendoProvider,
        freesound: FreesoundProvider,
        mubert: MubertProvider,
      ) => [jamendo, freesound, mubert],
      inject: [JamendoProvider, FreesoundProvider, MubertProvider],
    },
    AudioService,
  ],
  exports: [AudioService, AUDIO_PROVIDERS],
})
export class AudioModule {}
