/**
 * «Админка»: действия — Э8 (ТЗ §5.2–5.7, §4-бис.5, §5-бис.15 п.14,
 * §5-бис.17 п.10). Предложения write/danger и «Да», компенсации только
 * объявленные, мемо АМ-N. Только таблицы assist_admin_* и ядро; модули
 * «Сайта» не импортирует (граф admin↛site). Маршруты сотрудника (embed/TMA
 * «Да») — в AssistAdminChatModule (там сессия сотрудника); здесь — кабинет
 * владельца (мемо, журнал действий с откатом).
 */
import { Module } from '@nestjs/common';
import { AssistAdminModeModule } from '../assist-admin-mode/assist-admin-mode.module';
import { SiteAiModule } from '../site-ai/site-ai.module';
import { SiteCoreModule } from '../site-core/site-core.module';
import { AdminActionsController } from './actions.controller';
import { AdminActionsNotifier } from './action-notifier';
import { AdminMemoService } from './admin-memo.service';
import { ProposalsService } from './proposals.service';

@Module({
  imports: [SiteCoreModule, SiteAiModule, AssistAdminModeModule],
  controllers: [AdminActionsController],
  providers: [ProposalsService, AdminMemoService, AdminActionsNotifier],
  exports: [ProposalsService, AdminMemoService, AdminActionsNotifier],
})
export class AssistAdminActionsModule {}
