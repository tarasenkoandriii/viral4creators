/**
 * OpsStatusController — служебные сводки для оператора, только чтение.
 *
 * `GET /api/ops/demo-status` — готово ли демо (кроны обучалки, матрица
 * одобренных роликов, свежесть снимков интерфейса), см.
 * `DemoStatusService`.
 *
 * Защита — та же, что у `/api/admin/*`: `AdminSessionGuard` (cookie
 * admin-сессии; без неё — 401) и `assertOperator` (вошёл, но не
 * оператор — 403). Отдельного секрета нет сознательно: второй способ
 * входа — это второе место, где его можно забыть отозвать, а оператор
 * и так ходит в админку с этой cookie. Префикс `ops/`, а не `admin/`:
 * это не страница админки, а сводка, которую админка (дашборд внимания)
 * и оператор читают одинаково.
 *
 * Кешировать ответ нельзя (`no-store`): он про «сейчас», и под cookie.
 */
import { Controller, Get, Header, Req, UseGuards } from '@nestjs/common';
import {
  AdminAuthenticatedRequest,
  AdminSessionGuard,
} from '../admin-auth/admin-session.guard';
import { AdminPanelService } from '../admin-panel/admin-panel.service';
import { DemoStatusService, DemoStatusView } from './demo-status.service';

@Controller('ops')
@UseGuards(AdminSessionGuard)
export class OpsStatusController {
  constructor(
    private readonly adminPanel: AdminPanelService,
    private readonly demoStatus: DemoStatusService,
  ) {}

  @Get('demo-status')
  @Header('Cache-Control', 'no-store')
  async getDemoStatus(
    @Req() req: AdminAuthenticatedRequest,
  ): Promise<DemoStatusView> {
    await this.adminPanel.assertOperator(req.userId);
    return this.demoStatus.get();
  }
}
