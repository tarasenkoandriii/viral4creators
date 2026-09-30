import { Module } from '@nestjs/common';
import { StorageModule } from '../storage/storage.module';
import { VoiceUploadService } from './voice-upload.service';

/**
 * Учёт выданных ссылок на загрузку голосовых записей и их уборка по
 * возрасту (финальный аудит ветки K, 30.09.2026). Отдельным листом графа
 * модулей, а не частью `VoiceModule`: его зовёт и крон (`CronModule`), а
 * модуль голоса тянет за собой карточки мастера, советника и синтез.
 */
@Module({
  imports: [StorageModule],
  providers: [VoiceUploadService],
  exports: [VoiceUploadService],
})
export class VoiceUploadModule {}
