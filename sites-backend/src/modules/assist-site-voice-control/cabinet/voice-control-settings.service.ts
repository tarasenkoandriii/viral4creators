/**
 * Кабинет: голосовое управление «Сайтом» (Э6-бис (а), ТЗ §5-бис.2,
 * §5-бис.8, §5-бис.11). Экран — раздел «Голосове керування» рядом с
 * разделом «Голос» (assist/src/screens/widget/VoiceControlSection.tsx).
 *
 *  - GET  — переключатель, правила, можно ли включать (голос сайта есть и
 *    тариф позволяет), почему режим сейчас не работает, версия текста рисков;
 *  - PATCH — `off` можно всегда и сразу (выключение безопасно); `on` — только
 *    если у сайта включён голос (тариф Business+, ключ, микрофон владельцем:
 *    §5-бис.2 «чекбокс доступен, только если для режима включён голос») и
 *    владелец/менеджер видел экран рисков ТЕКУЩЕЙ версии. Точка расширения
 *    части (г): `test` и правило «`on` — только при годном отчёте мастера
 *    Т-2, иначе 409» (§5-бис.11) встают в `assertCanTurnOn`.
 *
 * Основная роль (SitesDb.forAccount — кабинет владельца); права —
 * контроллер (владелец или менеджер помощника, как голос).
 */
import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  voicePlatformEnabled,
  voiceProviderConfigured,
} from '../../../config/voice-env';
import { PrismaService } from '../../../prisma/prisma.service';
import { SitesDb } from '../../../prisma/sites-db.service';
import { assistPlanAllows } from '../../assist-billing/plans';
import { readState } from '../../assist-billing/public/entitlements';
import { loadAssistSite } from '../../assist-site-setup/widget-settings.service';
import { voiceAccess } from '../../assist-site-voice/public/voice-access';
import {
  defaultVoiceControlRules,
  parseVoiceControlRules,
  rulesOf,
} from '../../assist-ui-core/rules';
import type { AccountMembership } from '../../site-core/account/roles';
import {
  VOICE_CONTROL_RISKS_VERSION,
  type VoiceControlSettingsPatch,
  type VoiceControlSettingsView,
} from '../api-types';
import {
  stateOf,
  voiceControlAccess,
  voiceControlPlatformEnabled,
} from '../voice-control-config';
import { voiceControlError } from './voice-control-errors';

@Injectable()
export class VoiceControlSettingsService {
  private readonly logger = new Logger(VoiceControlSettingsService.name);
  env: NodeJS.ProcessEnv = process.env;
  now: () => Date = () => new Date();

  constructor(
    private readonly sitesDb: SitesDb,
    private readonly prisma: PrismaService,
  ) {}

  private db(m: AccountMembership) {
    return this.sitesDb.forAccount(m.accountId);
  }

  private async voiceOf(
    m: AccountMembership,
    row: {
      enabled: boolean;
      chatPaused: boolean;
      operatorBlockedAt: Date | null;
      voiceConfig: unknown;
      voiceDailyCapMicroUsd: number | null;
    },
  ) {
    const state = await readState(this.prisma, m.accountId, this.now());
    return {
      plan: state.planId,
      voice: voiceAccess({
        platformEnabled: voicePlatformEnabled(this.env),
        providerConfigured: voiceProviderConfigured(this.env),
        planId: state.planId,
        siteActive:
          row.enabled && !row.chatPaused && row.operatorBlockedAt === null,
        voiceConfig: row.voiceConfig,
        capOverrideMicroUsd: row.voiceDailyCapMicroUsd,
      }),
    };
  }

  async get(
    m: AccountMembership,
    siteId: string,
  ): Promise<VoiceControlSettingsView> {
    const { row } = await loadAssistSite(this.db(m), m.accountId, siteId);
    const { plan, voice } = await this.voiceOf(m, row);
    const access = voiceControlAccess({
      platformEnabled: voiceControlPlatformEnabled(this.env),
      voice,
      state: row.voiceControlSiteState,
      rules: row.voiceControlSiteRules,
    });
    return {
      siteId,
      state: stateOf(row.voiceControlSiteState),
      rules: rulesOf(row.voiceControlSiteRules) ?? defaultVoiceControlRules(),
      available:
        voiceControlPlatformEnabled(this.env) &&
        assistPlanAllows(plan, 'voice') &&
        voice.input,
      reason: access.reason,
      risksVersion: VOICE_CONTROL_RISKS_VERSION,
    };
  }

  async save(
    m: AccountMembership,
    siteId: string,
    body: VoiceControlSettingsPatch | null | undefined,
  ): Promise<VoiceControlSettingsView> {
    const db = this.db(m);
    const { row } = await loadAssistSite(db, m.accountId, siteId);
    const state = body?.state;
    if (state !== 'off' && state !== 'on') {
      throw voiceControlError(
        HttpStatus.BAD_REQUEST,
        'VOICE_CONTROL_INVALID',
        'Состояние голосового управления — off или on',
        { errors: [{ path: 'state', code: 'enum' }] },
      );
    }
    let rules =
      rulesOf(row.voiceControlSiteRules) ?? defaultVoiceControlRules();
    if (body && body.rules !== undefined) {
      const p = parseVoiceControlRules(body.rules);
      if (!p.ok) {
        throw voiceControlError(
          HttpStatus.BAD_REQUEST,
          'VOICE_CONTROL_INVALID',
          'Правила голосового управления не прошли проверку',
          { errors: p.errors },
        );
      }
      rules = p.rules;
    }
    if (state === 'on' && stateOf(row.voiceControlSiteState) !== 'on')
      await this.assertCanTurnOn(m, row, body?.risksVersion);
    await db.assistSite.update({
      where: { id: row.id },
      data: {
        voiceControlSiteState: state,
        voiceControlSiteRules: rules as unknown as Prisma.InputJsonValue,
      },
    });
    // Журнал кабинета — кто и какую версию рисков принял (без ПД, §6.6).
    this.logger.log(
      `voice-control site=${siteId} state=${state} member=${m.memberId} risks=${state === 'on' ? VOICE_CONTROL_RISKS_VERSION : '-'}`,
    );
    return this.get(m, siteId);
  }

  /**
   * Включить можно только с голосом сайта и после экрана рисков. Часть (г):
   * сюда же — «годный отчёт мастера Т-2 не старше 30 дней, иначе 409».
   */
  private async assertCanTurnOn(
    m: AccountMembership,
    row: Parameters<VoiceControlSettingsService['voiceOf']>[1],
    risksVersion: unknown,
  ): Promise<void> {
    const { plan, voice } = await this.voiceOf(m, row);
    if (!assistPlanAllows(plan, 'voice')) {
      throw voiceControlError(
        HttpStatus.PAYMENT_REQUIRED,
        'VOICE_CONTROL_PLAN_REQUIRED',
        'Голосовое управление доступно на тарифе с голосом (Business и выше)',
      );
    }
    if (!voiceControlPlatformEnabled(this.env) || !voice.input) {
      throw voiceControlError(
        HttpStatus.CONFLICT,
        'VOICE_CONTROL_VOICE_REQUIRED',
        'Сначала включите микрофон в разделе «Голос»',
      );
    }
    if (risksVersion !== VOICE_CONTROL_RISKS_VERSION) {
      throw voiceControlError(
        HttpStatus.BAD_REQUEST,
        'VOICE_CONTROL_RISKS_REQUIRED',
        'Перед включением прочитайте и примите риски',
      );
    }
  }
}
