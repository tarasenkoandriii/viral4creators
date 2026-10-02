/**
 * Вкладка «Помощник» админки платформы (ТЗ помощника §8, пункты 1–5 и 8;
 * Э4): прокси к внутреннему API sites-backend (AdminAssistClient). Здесь —
 * только вход оператора (AdminSessionGuard + assertOperator) и форма
 * запроса; данные и правила (журнал доступа, согласие DPA для eval,
 * env как верхняя граница рубильника) — на стороне sites-backend.
 */
import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  AdminAuthenticatedRequest,
  AdminSessionGuard,
} from '../admin-auth/admin-session.guard';
import { AdminPanelService } from './admin-panel.service';
import { AdminAssistClient } from './admin-assist.client';

const ID = /^[A-Za-z0-9_-]{1,64}$/;

function qs(params: Record<string, string | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) p.set(k, v);
  const s = p.toString();
  return s ? `?${s}` : '';
}

function safeId(v: string): string {
  return ID.test(v) ? v : 'invalid';
}

@Controller('admin/assist')
@UseGuards(AdminSessionGuard)
export class AdminAssistController {
  constructor(
    private readonly adminPanel: AdminPanelService,
    private readonly client: AdminAssistClient,
  ) {}

  private async op(req: AdminAuthenticatedRequest): Promise<string> {
    await this.adminPanel.assertOperator(req.userId);
    return req.userId;
  }

  @Get('summary')
  async summary(
    @Req() req: AdminAuthenticatedRequest,
    @Query('days') days?: string,
  ) {
    return this.client.call(
      'GET',
      `/summary${qs({ days })}`,
      await this.op(req),
    );
  }

  @Get('accounts')
  async accounts(
    @Req() req: AdminAuthenticatedRequest,
    @Query('q') q?: string,
    @Query('limit') limit?: string,
  ) {
    return this.client.call(
      'GET',
      `/accounts${qs({ q, limit })}`,
      await this.op(req),
    );
  }

  @Get('accounts/:id')
  async account(
    @Req() req: AdminAuthenticatedRequest,
    @Param('id') id: string,
  ) {
    return this.client.call(
      'GET',
      `/accounts/${safeId(id)}`,
      await this.op(req),
    );
  }

  @Post('accounts/:id/plan')
  async setPlan(
    @Req() req: AdminAuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.client.call(
      'POST',
      `/accounts/${safeId(id)}/plan`,
      await this.op(req),
      body,
    );
  }

  @Post('accounts/:id/extend')
  async extend(
    @Req() req: AdminAuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.client.call(
      'POST',
      `/accounts/${safeId(id)}/extend`,
      await this.op(req),
      body,
    );
  }

  @Post('accounts/:id/message')
  async message(
    @Req() req: AdminAuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.client.call(
      'POST',
      `/accounts/${safeId(id)}/message`,
      await this.op(req),
      body,
    );
  }

  @Patch('sites/:siteId')
  async site(
    @Req() req: AdminAuthenticatedRequest,
    @Param('siteId') siteId: string,
    @Body() body: unknown,
  ) {
    return this.client.call(
      'PATCH',
      `/sites/${safeId(siteId)}`,
      await this.op(req),
      body,
    );
  }

  @Get('review')
  async review(
    @Req() req: AdminAuthenticatedRequest,
    @Query('days') days?: string,
    @Query('limit') limit?: string,
  ) {
    return this.client.call(
      'GET',
      `/review${qs({ days, limit })}`,
      await this.op(req),
    );
  }

  @Post('review/:messageId/eval')
  async addToEval(
    @Req() req: AdminAuthenticatedRequest,
    @Param('messageId') id: string,
  ) {
    return this.client.call(
      'POST',
      `/review/${safeId(id)}/eval`,
      await this.op(req),
      {},
    );
  }

  @Get('abuse')
  async abuse(
    @Req() req: AdminAuthenticatedRequest,
    @Query('days') days?: string,
  ) {
    return this.client.call('GET', `/abuse${qs({ days })}`, await this.op(req));
  }

  @Post('opt-out')
  async addOptOut(
    @Req() req: AdminAuthenticatedRequest,
    @Body() body: unknown,
  ) {
    return this.client.call('POST', '/opt-out', await this.op(req), body);
  }

  @Delete('opt-out/:domain')
  async removeOptOut(
    @Req() req: AdminAuthenticatedRequest,
    @Param('domain') domain: string,
  ) {
    return this.client.call(
      'DELETE',
      `/opt-out/${encodeURIComponent(domain.slice(0, 253))}`,
      await this.op(req),
    );
  }

  @Get('settings')
  async settings(@Req() req: AdminAuthenticatedRequest) {
    return this.client.call('GET', '/settings', await this.op(req));
  }

  @Patch('settings')
  async setSettings(
    @Req() req: AdminAuthenticatedRequest,
    @Body() body: unknown,
  ) {
    return this.client.call('PATCH', '/settings', await this.op(req), body);
  }

  @Get('costs')
  async costs(
    @Req() req: AdminAuthenticatedRequest,
    @Query('days') days?: string,
  ) {
    return this.client.call('GET', `/costs${qs({ days })}`, await this.op(req));
  }
}
