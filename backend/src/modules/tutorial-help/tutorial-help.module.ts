import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { PlatformSettingsService } from '../../common/platform-settings.service';
import { TutorialHelpController } from './tutorial-help.controller';
import { TutorialHelpService } from './tutorial-help.service';

/**
 * Справка по теме мастера — текст всегда, вычитанный ролик если есть.
 *
 * `PlatformSettingsService` — тем же приёмом, что у остальных модулей
 * (свой экземпляр поверх общего Prisma): из него читается отметка
 * оператора для семейства демо обучающего лендинга
 * (`site-tutorial-demo.ts`).
 */
@Module({
  imports: [PrismaModule],
  controllers: [TutorialHelpController],
  providers: [TutorialHelpService, PlatformSettingsService],
})
export class TutorialHelpModule {}
