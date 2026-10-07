/**
 * «Тестовые учётные записи» мастера обучалки (Э-С Ш2) — свой файл
 * маршрутов рядом с `/site-tutorial`:
 *
 *   GET    /projects/:projectId/site-tutorial/test-accounts       список (без секретов)
 *   GET    /projects/:projectId/site-tutorial/test-accounts/for-login
 *          учётки для входа на шаге мастера: только id, метка, роль (Ш2-хвост (3))
 *   POST   /projects/:projectId/site-tutorial/test-accounts       завести (режим A)
 *   PATCH  /projects/:projectId/site-tutorial/test-accounts/:id   изменить
 *   DELETE /projects/:projectId/site-tutorial/test-accounts/:id   «Забыть»
 */
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  IdentifiedRequest,
  TelegramIdentityGuard,
} from '../telegram-auth/telegram-identity.guard';
import { ClientSiteTestAccountsService } from './client-site-test-accounts.service';

const ID = /^[A-Za-z0-9_-]{1,64}$/;

function idOf(raw: string): string {
  if (!ID.test(raw))
    throw new BadRequestException('неверный id учётной записи');
  return raw;
}

@Controller('projects/:projectId/site-tutorial/test-accounts')
@UseGuards(TelegramIdentityGuard)
export class ClientSiteTestAccountsController {
  constructor(private readonly svc: ClientSiteTestAccountsService) {}

  @Get()
  list(@Req() req: IdentifiedRequest, @Param('projectId') projectId: string) {
    return this.svc.view(req.telegramUserId, projectId);
  }

  @Get('for-login')
  forLogin(
    @Req() req: IdentifiedRequest,
    @Param('projectId') projectId: string,
  ) {
    return this.svc.loginOptions(req.telegramUserId, projectId);
  }

  @Post()
  create(
    @Req() req: IdentifiedRequest,
    @Param('projectId') projectId: string,
    @Body() body: unknown,
  ) {
    return this.svc.create(req.telegramUserId, projectId, body);
  }

  @Patch(':id')
  update(
    @Req() req: IdentifiedRequest,
    @Param('projectId') projectId: string,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.svc.update(req.telegramUserId, projectId, idOf(id), body);
  }

  @Delete(':id')
  remove(
    @Req() req: IdentifiedRequest,
    @Param('projectId') projectId: string,
    @Param('id') id: string,
  ) {
    return this.svc.remove(req.telegramUserId, projectId, idOf(id));
  }
}
