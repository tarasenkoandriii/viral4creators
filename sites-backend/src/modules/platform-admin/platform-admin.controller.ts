import { SonioxObservability } from '../soniox-observability/soniox-observability.service';
/**
 * Внутренний API вкладки «Помощник» админки платформы (ТЗ §8 п.1–5, 8).
 * Зовёт ТОЛЬКО backend/ (admin-panel, AdminAssistController) с секретом —
 * internal-secret.guard.ts; оператор (assertOperator) проверяется там.
 *
 *   GET    /internal/admin/assist/summary?days=7
 *   GET    /internal/admin/assist/accounts?q=&limit=
 *   GET    /internal/admin/assist/accounts/:id
 *   POST   /internal/admin/assist/accounts/:id/plan      { planId, days, note? }
 *   POST   /internal/admin/assist/accounts/:id/extend    { days }
 *   POST   /internal/admin/assist/accounts/:id/message   { text }
 *   PATCH  /internal/admin/assist/sites/:siteId          { blocked?, dailyCapUsd?, voiceControlPlansPerDay? }
 *   GET    /internal/admin/assist/review?days=&limit=
 *   POST   /internal/admin/assist/review/:messageId/eval
 *   GET    /internal/admin/assist/abuse?days=
 *   POST   /internal/admin/assist/opt-out               { domain }
 *   DELETE /internal/admin/assist/opt-out/:domain
 *   GET    /internal/admin/assist/settings
 *   PATCH  /internal/admin/assist/settings              { enabled?, dailyCapUsd? }
 *   GET    /internal/admin/assist/costs?days=
 *   (Э6-бис (г), голосовое управление: рубильник платформы, канарейка
 *   выпусков виджета, инциденты монитора Т-4, нарушение по жалобе)
 *   GET    /internal/admin/assist/voice-control
 *   PATCH  /internal/admin/assist/voice-control         { enabled?, stable?, canary?, canaryPercent? }
 *   POST   /internal/admin/assist/voice-control/sites/:siteId/incident  { reason? }
 */
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { RELEASE_RE } from '../../common/voice-control-platform';
import { PublicRoute } from '../telegram-auth/allow-apps.decorator';
import { AdminActor, InternalSecretGuard } from './internal-secret.guard';
import { PlatformAdmin, adminError } from './platform-admin.service';

type Obj = Record<string, unknown>;

function body(b: unknown, keys: string[]): Obj {
  if (!b || typeof b !== 'object' || Array.isArray(b)) {
    throw adminError(
      'BAD_REQUEST',
      'Ожидается JSON-объект',
      HttpStatus.BAD_REQUEST,
    );
  }
  for (const k of Object.keys(b)) {
    if (!keys.includes(k)) {
      throw adminError(
        'BAD_REQUEST',
        `Лишнее поле «${k}»`,
        HttpStatus.BAD_REQUEST,
      );
    }
  }
  return b as Obj;
}

function days(v: unknown, def: number, max: number): number {
  const d = Number(v ?? def);
  return Number.isInteger(d) && d >= 1 && d <= max ? d : def;
}

const ID = /^[A-Za-z0-9_-]{1,64}$/;
function id(v: string): string {
  if (!ID.test(v))
    throw adminError('BAD_REQUEST', 'id', HttpStatus.BAD_REQUEST);
  return v;
}

@Controller('internal/admin/assist')
@PublicRoute('внутренний API админки платформы: секрет X-Sites-Internal-Secret')
@UseGuards(InternalSecretGuard)
export class PlatformAdminController {
  constructor(private readonly admin: PlatformAdmin, private readonly soniox: SonioxObservability) {}

  @Get('soniox')
  sonioxReport() { return this.soniox.report(); }

  @Get('summary')
  summary(@Query('days') d?: string) {
    return this.admin.summary(days(d, 7, 90));
  }

  @Get('accounts')
  accounts(@Query('q') q?: string, @Query('limit') limit?: string) {
    return this.admin.accounts(
      typeof q === 'string' ? q : '',
      days(limit, 50, 100),
    );
  }

  @Get('accounts/:id')
  account(@Param('id') accountId: string, @AdminActor() actor: string) {
    return this.admin.account(id(accountId), actor);
  }

  @Post('accounts/:id/plan')
  @HttpCode(200)
  setPlan(
    @Param('id') accountId: string,
    @AdminActor() actor: string,
    @Body() b: unknown,
  ) {
    const o = body(b, ['planId', 'days', 'note']);
    if (o.note !== undefined && typeof o.note !== 'string') {
      throw adminError('BAD_REQUEST', 'note — строка', HttpStatus.BAD_REQUEST);
    }
    return this.admin.setPlan(id(accountId), actor, {
      planId: String(o.planId),
      days: Number(o.days),
      note: o.note as string | undefined,
    });
  }

  @Post('accounts/:id/extend')
  @HttpCode(200)
  extend(
    @Param('id') accountId: string,
    @AdminActor() actor: string,
    @Body() b: unknown,
  ) {
    const o = body(b, ['days']);
    return this.admin.extend(id(accountId), actor, Number(o.days));
  }

  @Post('accounts/:id/message')
  @HttpCode(200)
  message(
    @Param('id') accountId: string,
    @AdminActor() actor: string,
    @Body() b: unknown,
  ) {
    const o = body(b, ['text']);
    if (typeof o.text !== 'string') {
      throw adminError('BAD_REQUEST', 'text — строка', HttpStatus.BAD_REQUEST);
    }
    return this.admin.messageOwner(id(accountId), actor, o.text);
  }

  @Patch('sites/:siteId')
  site(
    @Param('siteId') siteId: string,
    @AdminActor() actor: string,
    @Body() b: unknown,
  ) {
    const o = body(b, ['blocked', 'dailyCapUsd', 'voiceControlPlansPerDay']);
    if (
      o.voiceControlPlansPerDay !== undefined &&
      o.voiceControlPlansPerDay !== null &&
      !(
        typeof o.voiceControlPlansPerDay === 'number' &&
        Number.isInteger(o.voiceControlPlansPerDay) &&
        o.voiceControlPlansPerDay >= 0 &&
        o.voiceControlPlansPerDay <= 100_000
      )
    ) {
      throw adminError(
        'BAD_REQUEST',
        'voiceControlPlansPerDay — целое 0…100000 или null',
        HttpStatus.BAD_REQUEST,
      );
    }
    if (o.blocked !== undefined && typeof o.blocked !== 'boolean') {
      throw adminError(
        'BAD_REQUEST',
        'blocked — boolean',
        HttpStatus.BAD_REQUEST,
      );
    }
    if (
      o.dailyCapUsd !== undefined &&
      o.dailyCapUsd !== null &&
      !(
        typeof o.dailyCapUsd === 'number' &&
        o.dailyCapUsd >= 0 &&
        o.dailyCapUsd <= 1000
      )
    ) {
      throw adminError(
        'BAD_REQUEST',
        'dailyCapUsd — 0…1000 или null',
        HttpStatus.BAD_REQUEST,
      );
    }
    return this.admin.setSite(id(siteId), actor, {
      blocked: o.blocked as boolean | undefined,
      dailyCapUsd: o.dailyCapUsd as number | null | undefined,
      voiceControlPlansPerDay: o.voiceControlPlansPerDay as
        number | null | undefined,
    });
  }

  @Get('voice-control')
  voiceControl() {
    return this.admin.voiceControl();
  }

  @Patch('voice-control')
  setVoiceControl(@AdminActor() actor: string, @Body() b: unknown) {
    const o = body(b, ['enabled', 'stable', 'canary', 'canaryPercent']);
    if (o.enabled !== undefined && typeof o.enabled !== 'boolean') {
      throw adminError(
        'BAD_REQUEST',
        'enabled — boolean',
        HttpStatus.BAD_REQUEST,
      );
    }
    for (const k of ['stable', 'canary'] as const) {
      const v = o[k];
      if (
        v !== undefined &&
        v !== null &&
        !(typeof v === 'string' && RELEASE_RE.test(v))
      ) {
        throw adminError(
          'BAD_REQUEST',
          `${k} — имя выпуска (a-z0-9.-) или null`,
          HttpStatus.BAD_REQUEST,
        );
      }
    }
    if (
      o.canaryPercent !== undefined &&
      !(
        typeof o.canaryPercent === 'number' &&
        Number.isInteger(o.canaryPercent) &&
        o.canaryPercent >= 1 &&
        o.canaryPercent <= 50
      )
    ) {
      throw adminError(
        'BAD_REQUEST',
        'canaryPercent — целое 1…50',
        HttpStatus.BAD_REQUEST,
      );
    }
    return this.admin.setVoiceControl(actor, {
      enabled: o.enabled as boolean | undefined,
      stable: o.stable as string | null | undefined,
      canary: o.canary as string | null | undefined,
      canaryPercent: o.canaryPercent as number | undefined,
    });
  }

  @Post('voice-control/sites/:siteId/incident')
  @HttpCode(200)
  voiceIncident(
    @Param('siteId') siteId: string,
    @AdminActor() actor: string,
    @Body() b: unknown,
  ) {
    const o = body(b ?? {}, ['reason']);
    return this.admin.voiceIncident(
      id(siteId),
      actor,
      typeof o.reason === 'string' ? o.reason : 'complaint',
    );
  }

  @Get('review')
  review(
    @AdminActor() actor: string,
    @Query('days') d?: string,
    @Query('limit') limit?: string,
  ) {
    return this.admin.review(actor, days(d, 7, 90), days(limit, 50, 200));
  }

  @Post('review/:messageId/eval')
  @HttpCode(200)
  addToEval(
    @Param('messageId') messageId: string,
    @AdminActor() actor: string,
  ) {
    return this.admin.addToEval(id(messageId), actor);
  }

  @Get('abuse')
  abuse(@Query('days') d?: string) {
    return this.admin.abuse(days(d, 7, 30));
  }

  @Post('opt-out')
  @HttpCode(200)
  addOptOut(@AdminActor() actor: string, @Body() b: unknown) {
    const o = body(b, ['domain']);
    return this.admin.addOptOut(String(o.domain ?? ''), actor);
  }

  @Delete('opt-out/:domain')
  removeOptOut(@Param('domain') domain: string, @AdminActor() actor: string) {
    return this.admin.removeOptOut(domain, actor);
  }

  @Get('settings')
  settings() {
    return this.admin.settings();
  }

  @Patch('settings')
  setSettings(@AdminActor() actor: string, @Body() b: unknown) {
    const o = body(b, ['enabled', 'dailyCapUsd']);
    if (o.enabled !== undefined && typeof o.enabled !== 'boolean') {
      throw adminError(
        'BAD_REQUEST',
        'enabled — boolean',
        HttpStatus.BAD_REQUEST,
      );
    }
    if (
      o.dailyCapUsd !== undefined &&
      o.dailyCapUsd !== null &&
      !(
        typeof o.dailyCapUsd === 'number' &&
        o.dailyCapUsd >= 0 &&
        o.dailyCapUsd <= 100_000
      )
    ) {
      throw adminError(
        'BAD_REQUEST',
        'dailyCapUsd — число ≥ 0 или null',
        HttpStatus.BAD_REQUEST,
      );
    }
    return this.admin.setSettings(actor, {
      enabled: o.enabled as boolean | undefined,
      dailyCapUsd: o.dailyCapUsd as number | null | undefined,
    });
  }

  @Get('costs')
  costs(@Query('days') d?: string) {
    return this.admin.costs(days(d, 30, 90));
  }
}
