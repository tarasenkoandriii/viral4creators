import { Module } from '@nestjs/common';
import {
  GuideAssistController,
  GuideFactsController,
} from './guide-assist.controller';
import { GuideAssistService } from './guide-assist.service';
import { GuideConnectorGuard } from './guide-connector.guard';

/**
 * Гид мастера → режим «Админка» помощника платформы (Э-С Ш6).
 *
 * Отдельный модуль, а не часть `wizard-guide`: старый гид удаляется после
 * пилотов (аудит §Ш6 «Удаляется после переезда»), а мост к «Админке»
 * остаётся. Из `wizard-guide` берутся только чистые файлы, которые
 * переживут удаление (`hint-facts*`, карточки `hint-scenarios`) — их
 * перенос сюда — часть того удаления.
 *
 * `PrismaService` и `PlanService` — из глобальных модулей.
 */
@Module({
  controllers: [GuideAssistController, GuideFactsController],
  providers: [GuideAssistService, GuideConnectorGuard],
  exports: [GuideAssistService],
})
export class GuideAssistModule {}
