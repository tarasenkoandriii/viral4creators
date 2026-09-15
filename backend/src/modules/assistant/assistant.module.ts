/**
 * AssistantModule — ИИ-консультант на лендинге
 * (doc/LANDING-TUTORIAL-AI-CONSULTANT-SPEC.md).
 *
 * AdminPanelModule/AdminAuthModule импортированы здесь (а не наоборот) —
 * тот же однонаправленный приём, что у `CronModule`/`GenerationModule`
 * (см. `admin-generation-retry.controller.ts`, `cron.module.ts`):
 * фиче-модуль тянет админ-инфраструктуру, а не наоборот, иначе граф
 * модулей замкнулся бы циклом. AiUsageModule/NotifyModule/PrismaModule —
 * `@Global()`, поэтому в `imports` не перечислены.
 */
import { Module } from '@nestjs/common';
import { AssistantController } from './assistant.controller';
import { AssistantAdminController } from './assistant-admin.controller';
import { AssistantService } from './assistant.service';
import { AssistantSettingsService } from './assistant-settings.service';
import { AssistantAdminService } from './assistant-admin.service';
import { AdminPanelModule } from '../admin-panel/admin-panel.module';
import { AdminAuthModule } from '../admin-auth/admin-auth.module';

@Module({
  imports: [AdminPanelModule, AdminAuthModule],
  controllers: [AssistantController, AssistantAdminController],
  providers: [
    AssistantService,
    AssistantSettingsService,
    AssistantAdminService,
  ],
})
export class AssistantModule {}
