/**
 * AdminAttentionController — `GET /api/admin/attention`, очередь
 * внимания для первой страницы админки (doc/TUTORIAL-DEMO-QUALITY-SPEC.md,
 * раздел «Дашборд внимания»).
 *
 * Защита — та же, что у остальных `/api/admin/*`: `AdminSessionGuard`
 * (нет admin-cookie — 401) и `assertOperator` (вошёл, но не оператор —
 * 403) ДО обращения к источникам. Ответ про «сейчас» и под cookie —
 * `no-store`.
 */
import { Controller, Get, Header, Req, UseGuards } from '@nestjs/common';
import {
  AdminAuthenticatedRequest,
  AdminSessionGuard,
} from '../admin-auth/admin-session.guard';
import { AdminPanelService } from '../admin-panel/admin-panel.service';
import { AdminAttentionService } from './admin-attention.service';
import { AttentionView } from './attention-rules';

@Controller('admin/attention')
@UseGuards(AdminSessionGuard)
export class AdminAttentionController {
  constructor(
    private readonly adminPanel: AdminPanelService,
    private readonly attention: AdminAttentionService,
  ) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  async get(@Req() req: AdminAuthenticatedRequest): Promise<AttentionView> {
    await this.adminPanel.assertOperator(req.userId);
    return this.attention.get();
  }
}
