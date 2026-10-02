/**
 * Кабинет передачи человеку — H (ТЗ §3.7, §4.16, §5-тер.13):
 *   GET   /assist/sites/:id/conversations?view=&cursor=&from=&to=&outcome=&flagged=&lang=&limit=
 *   GET   /assist/sites/:id/conversations/:cid
 *   POST  /assist/sites/:id/conversations/:cid/take
 *   POST  /assist/sites/:id/conversations/:cid/reply     { text, noTranslate? }
 *   POST  /assist/sites/:id/conversations/:cid/draft
 *   POST  /assist/sites/:id/conversations/:cid/close
 *   GET   /assist/sites/:id/handoff-settings             (assist: manager)
 *   PATCH /assist/sites/:id/handoff-settings  { config } (assist: manager)
 *   GET   /assist/account/operators                      (assist: manager)
 * Права: диалоги — REQUIRE_ASSIST_ANY (оператор — ограниченно, см.
 * ConversationsService); настройки — REQUIRE_ASSIST_MANAGER. Маршруты
 * `?mode=admin` здесь нет вовсе (К-9).
 * Действия (take/reply/draft/close) — по последней передаче диалога своего
 * сайта; кто вправе — решает HandoffOperatorActions (одна логика с ботом):
 * оператор, у которого передачу взял другой, получает HANDOFF_NOT_ASSIGNED,
 * а не 404 — экран TMA говорит «диалог взял другой оператор».
 */
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  REQUIRE_ASSIST_ANY,
  REQUIRE_ASSIST_MANAGER,
  type AccountMembership,
} from '../../site-core/account/roles';
import {
  Membership,
  RequireProductRoles,
  SiteAccountGuard,
} from '../../site-core/account/site-account.guard';
import { AllowApps } from '../../telegram-auth/allow-apps.decorator';
import type {
  ConversationListView,
  ConversationView,
  HandoffDraft,
  HandoffSettingsView,
  OperatorReplyResult,
  OperatorView,
  TakeResult,
} from '../api-types';
import { handoffError } from '../system/handoff-common';
import { HandoffOperatorActions } from '../system/handoff-operator.service';
import {
  ConversationsService,
  HandoffSettingsService,
  parseListQuery,
} from './conversations.service';

/** Тело — не DTO: форма строгая и маленькая, разбор здесь (лишнее поле — 400). */
function replyBody(body: unknown): { text: string; noTranslate?: boolean } {
  const bad = () =>
    handoffError(
      'REPLY_INVALID',
      'Ответ: { text, noTranslate? }',
      HttpStatus.BAD_REQUEST,
    );
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw bad();
  const o = body as Record<string, unknown>;
  for (const k of Object.keys(o))
    if (k !== 'text' && k !== 'noTranslate') throw bad();
  if (typeof o.text !== 'string') throw bad();
  if (o.noTranslate !== undefined && typeof o.noTranslate !== 'boolean')
    throw bad();
  return { text: o.text, noTranslate: o.noTranslate as boolean | undefined };
}

function configBody(body: unknown): unknown {
  if (
    !body ||
    typeof body !== 'object' ||
    Array.isArray(body) ||
    Object.keys(body).some((k) => k !== 'config')
  ) {
    throw handoffError(
      'HANDOFF_CONFIG_INVALID',
      'Тело запроса: { config }',
      HttpStatus.BAD_REQUEST,
    );
  }
  return (body as { config?: unknown }).config;
}

@Controller('assist')
@AllowApps('assist')
@UseGuards(SiteAccountGuard)
export class HandoffCabinetController {
  constructor(
    readonly conversations: ConversationsService,
    readonly settings: HandoffSettingsService,
    readonly actions: HandoffOperatorActions,
  ) {}

  @Get('sites/:id/conversations')
  @RequireProductRoles(REQUIRE_ASSIST_ANY)
  list(
    @Membership() m: AccountMembership,
    @Param('id') siteId: string,
    @Query() query: Record<string, unknown>,
  ): Promise<ConversationListView> {
    return this.conversations.list(m, siteId, parseListQuery(query, m));
  }

  @Get('sites/:id/conversations/:cid')
  @RequireProductRoles(REQUIRE_ASSIST_ANY)
  get(
    @Membership() m: AccountMembership,
    @Param('id') siteId: string,
    @Param('cid') cid: string,
  ): Promise<ConversationView> {
    return this.conversations.get(m, siteId, cid);
  }

  @Post('sites/:id/conversations/:cid/take')
  @HttpCode(200)
  @RequireProductRoles(REQUIRE_ASSIST_ANY)
  async take(
    @Membership() m: AccountMembership,
    @Param('id') siteId: string,
    @Param('cid') cid: string,
  ): Promise<TakeResult> {
    const id = await this.conversations.handoffIdFor(m, siteId, cid);
    return this.actions.take({ via: 'tma', membership: m }, id);
  }

  @Post('sites/:id/conversations/:cid/reply')
  @HttpCode(200)
  @RequireProductRoles(REQUIRE_ASSIST_ANY)
  async reply(
    @Membership() m: AccountMembership,
    @Param('id') siteId: string,
    @Param('cid') cid: string,
    @Body() body: unknown,
  ): Promise<OperatorReplyResult> {
    const req = replyBody(body);
    const id = await this.conversations.handoffIdFor(m, siteId, cid);
    return this.actions.reply({ via: 'tma', membership: m }, id, req);
  }

  @Post('sites/:id/conversations/:cid/draft')
  @HttpCode(200)
  @RequireProductRoles(REQUIRE_ASSIST_ANY)
  async draft(
    @Membership() m: AccountMembership,
    @Param('id') siteId: string,
    @Param('cid') cid: string,
  ): Promise<HandoffDraft | null> {
    const id = await this.conversations.handoffIdFor(m, siteId, cid);
    return this.actions.regenerateDraft({ via: 'tma', membership: m }, id);
  }

  @Post('sites/:id/conversations/:cid/close')
  @HttpCode(200)
  @RequireProductRoles(REQUIRE_ASSIST_ANY)
  async close(
    @Membership() m: AccountMembership,
    @Param('id') siteId: string,
    @Param('cid') cid: string,
  ): Promise<{ ok: true }> {
    const id = await this.conversations.handoffIdFor(m, siteId, cid);
    await this.actions.close({ via: 'tma', membership: m }, id);
    return { ok: true };
  }

  @Get('sites/:id/handoff-settings')
  @RequireProductRoles(REQUIRE_ASSIST_MANAGER)
  getSettings(
    @Membership() m: AccountMembership,
    @Param('id') siteId: string,
  ): Promise<HandoffSettingsView> {
    return this.settings.get(m, siteId);
  }

  @Patch('sites/:id/handoff-settings')
  @RequireProductRoles(REQUIRE_ASSIST_MANAGER)
  patchSettings(
    @Membership() m: AccountMembership,
    @Param('id') siteId: string,
    @Body() body: unknown,
  ): Promise<HandoffSettingsView> {
    return this.settings.patch(m, siteId, configBody(body));
  }

  @Get('account/operators')
  @RequireProductRoles(REQUIRE_ASSIST_MANAGER)
  operators(@Membership() m: AccountMembership): Promise<OperatorView[]> {
    return this.settings.operators(m);
  }
}
