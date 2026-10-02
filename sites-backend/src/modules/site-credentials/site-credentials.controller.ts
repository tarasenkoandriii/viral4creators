/**
 * Экран «Тестовые учётные записи» кабинета (Э-С Ш2) — общий для TMA
 * помощника и QA (`@AllowApps('any')`, как маршруты ядра):
 *
 *   GET    /sites/:siteId/test-accounts          список (без секретов)
 *   POST   /sites/:siteId/test-accounts          завести
 *   PATCH  /sites/:siteId/test-accounts/:id      изменить (пароль — только запись)
 *   DELETE /sites/:siteId/test-accounts/:id      «Забыть» — учётка и секреты
 *
 * Права — владелец и менеджер кабинета (те, кто подтверждает владение,
 * QA §1.5); оператор учёток не видит вовсе. Пароль наружу не отдаётся
 * никогда: ответ — метаданные и флаги «есть пароль / есть сессия».
 */
import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { AllowApps } from '../telegram-auth/allow-apps.decorator';
import type { AccountMembership } from '../site-core/account/roles';
import {
  Membership,
  RequireAccountRoles,
  SiteAccountGuard,
} from '../site-core/account/site-account.guard';
import { SiteCredentialsService, parseId } from './site-credentials.service';
import { parseTestAccountInput } from './test-account-input';

const actorOf = (m: AccountMembership) => `tma:${m.telegramId.toString()}`;

@Controller('sites/:siteId/test-accounts')
@AllowApps('any')
@UseGuards(SiteAccountGuard)
@RequireAccountRoles('owner', 'manager')
export class SiteTestAccountsController {
  constructor(private readonly svc: SiteCredentialsService) {}

  @Get()
  list(@Membership() m: AccountMembership, @Param('siteId') siteId: string) {
    return this.svc.list(m.accountId, parseId(siteId, 'siteId'));
  }

  @Post()
  create(
    @Membership() m: AccountMembership,
    @Param('siteId') siteId: string,
    @Body() body: unknown,
  ) {
    return this.svc.create(
      m.accountId,
      parseId(siteId, 'siteId'),
      parseTestAccountInput(body, { partial: false }),
      actorOf(m),
    );
  }

  @Patch(':id')
  update(
    @Membership() m: AccountMembership,
    @Param('siteId') siteId: string,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.svc.update(
      m.accountId,
      parseId(siteId, 'siteId'),
      parseId(id, 'id'),
      parseTestAccountInput(body, { partial: true }),
      actorOf(m),
    );
  }

  @Delete(':id')
  remove(
    @Membership() m: AccountMembership,
    @Param('siteId') siteId: string,
    @Param('id') id: string,
  ) {
    return this.svc.remove(
      m.accountId,
      parseId(siteId, 'siteId'),
      parseId(id, 'id'),
      actorOf(m),
    );
  }
}
