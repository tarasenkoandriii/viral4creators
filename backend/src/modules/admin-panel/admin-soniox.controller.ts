import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import {
  AdminSessionGuard,
  AdminAuthenticatedRequest,
} from '../admin-auth/admin-session.guard';
import { AdminPanelService } from './admin-panel.service';
import { AdminAssistClient } from './admin-assist.client';
import { SonioxObservability } from '../soniox-observability/soniox-observability.service';
@Controller('admin/soniox')
@UseGuards(AdminSessionGuard)
export class AdminSonioxController {
  constructor(
    private readonly admin: AdminPanelService,
    private readonly telemetry: SonioxObservability,
    private readonly assist: AdminAssistClient,
  ) {}
  @Get()
  async report(@Req() req: AdminAuthenticatedRequest) {
    await this.admin.assertOperator(req.userId);
    const [generator, sites] = await Promise.all([
      this.telemetry.report(),
      this.assist.call('GET', '/soniox', req.userId).catch(() => ({
        available: false,
        error: 'Sites-backend недоступен или ещё не обновлён.',
      })),
    ]);
    return { generatedAt: new Date().toISOString(), generator, sites };
  }
}
