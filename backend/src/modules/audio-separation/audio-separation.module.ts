/**
 * Модуль разделения звуковой дорожки (ТЗ
 * `docs-tz/TZ-Voice-Replace-Keep-Background.md`, этап B).
 *
 * Отдельный модуль, а не сервис внутри `PostprodModule`, по той же
 * причине, по которой отдельно живёт TTS: провайдер сменный, у него
 * свой контракт (`AudioSeparationProvider`), и границу лучше провести
 * заранее.
 *
 * Уточнение по сквозному аудиту A–F, чтобы комментарий не обещал
 * больше кода: постпрод инжектит КОНКРЕТНЫЙ `ReplicateSeparationService`,
 * а не интерфейс. Сделать иначе значит завести токен внедрения —
 * оправданно, когда провайдеров станет два, и лишняя церемония, пока
 * он один. Смена провайдера сегодня — это правка одной строки здесь
 * (и типа в конструкторе постпрода), а не переписывание вызывающего
 * кода: интерфейс задаёт форму, которой новый провайдер обязан
 * соответствовать.
 */
import { Module } from '@nestjs/common';
import { PlatformSettingsService } from '../../common/platform-settings.service';
import { AudioSeparationSettingsService } from './audio-separation-settings';
import { ReplicateSeparationService } from './replicate-separation.service';

@Module({
  providers: [
    ReplicateSeparationService,
    AudioSeparationSettingsService,
    PlatformSettingsService,
  ],
  exports: [ReplicateSeparationService, AudioSeparationSettingsService],
})
export class AudioSeparationModule {}
