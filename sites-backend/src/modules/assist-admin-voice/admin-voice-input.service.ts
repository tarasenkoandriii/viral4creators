/**
 * Голосовой ввод команды сотрудника «Админки» (Э6-бис (б), §4.10, §5-бис.7;
 * Р-Э6б-2): `POST /assist-admin/v1/voice` — запись → Soniox → текст + билет
 * голоса «Админки» (команда засчитывается источником `voice` только с ним).
 *
 * Допуск — сессия сотрудника и голосовое управление «Админкой» в `on`/
 * `degraded` (или тестовая сессия мастера); деньги — суточный потолок
 * «Админки» сайта ДО вызова провайдера; запись — только в памяти запроса,
 * затирается в `finally` (Условия п.3.4), у провайдера удаляется в
 * `finally` клиента (admin-stt.ts).
 */
import { Injectable, Logger } from '@nestjs/common';
import { voiceTicketKey } from '../../config/voice-env';
import { SitesDb } from '../../prisma/sites-db.service';
import { AdminChatService } from '../assist-admin-chat/admin-chat.service';
import { AiUsageRecorder } from '../site-ai/usage-recorder';
import {
  ADMIN_STT,
  AdminSonioxStt,
  adminAudioHeaderOk,
  issueAdminVoiceTicket,
  sniffAdminAudio,
} from './admin-stt';
import { adminVoiceError } from './admin-voice-errors';
import { AdminVoiceSettingsService } from './admin-voice-settings.service';
import { AdminUiPlanService, type AdminVcCtx } from './admin-ui-plan.service';

export const ADMIN_STT_PRICING_MODEL = 'soniox-stt-async';

@Injectable()
export class AdminVoiceInputService {
  private readonly logger = new Logger(AdminVoiceInputService.name);
  env: NodeJS.ProcessEnv = process.env;
  now: () => Date = () => new Date();

  constructor(
    private readonly sitesDb: SitesDb,
    private readonly stt: AdminSonioxStt,
    private readonly plans: AdminUiPlanService,
    private readonly settings: AdminVoiceSettingsService,
    private readonly chat: AdminChatService,
    private readonly usage: AiUsageRecorder,
  ) {}

  async transcribe(
    ctx: AdminVcCtx,
    audio: Buffer,
    contentType: unknown,
  ): Promise<{
    text: string;
    lang: string | null;
    voiceTicket: string | null;
  }> {
    const s = ctx.session;
    const now = this.now();
    try {
      const mime = adminAudioHeaderOk(contentType)
        ? sniffAdminAudio(audio)
        : null;
      if (
        !mime ||
        audio.length < ADMIN_STT.minAudioBytes ||
        audio.length > ADMIN_STT.maxAudioBytes
      ) {
        throw adminVoiceError(
          400,
          'ADMIN_VC_AUDIO_INVALID',
          'Запись не подходит — повторите или напишите текстом',
        );
      }
      const a = await this.plans.access(s, !!ctx.test, now);
      if (!a.mode || !this.settings.voiceAvailable()) {
        throw adminVoiceError(
          409,
          'ADMIN_VC_OFF',
          'Голосовое управление админкой на этом сайте не включено',
        );
      }
      // Деньги — до провайдера (суточный потолок «Админки» сайта).
      await this.chat.assertDailyBudget(this.plans.employee(s), now);
      const r = await this.stt.transcribe({
        audio,
        mimeType: mime,
        languageHints: ['uk', 'ru', 'en'],
      });
      if (r.billable) {
        await this.usage
          .record(
            this.sitesDb.system(
              'учёт расходов «Админки»: строка site_ai_usage с accountId сайта',
            ),
            {
              accountId: s.accountId,
              siteId: s.siteId,
              operation: 'assist-admin-stt',
              model: ADMIN_STT_PRICING_MODEL,
              units: { seconds: r.seconds },
            },
          )
          .catch(() => undefined);
      }
      this.logger.log(
        `admin voice site=${s.siteId} bytes=${audio.length} s=${r.seconds} ok=${!!r.text} reason=${r.reason ?? '-'}`,
      );
      if (!r.text) {
        throw r.reason === 'no_speech' || r.reason === 'empty'
          ? adminVoiceError(
              422,
              'ADMIN_VC_NOT_HEARD',
              'Не расслышал — повторите',
            )
          : adminVoiceError(
              502,
              'ADMIN_VC_UPSTREAM',
              'Распознавание недоступно — напишите текстом',
            );
      }
      const text = r.text.slice(0, 600).trim();
      const key = voiceTicketKey(this.env);
      return {
        text,
        lang: r.language,
        voiceTicket: key
          ? issueAdminVoiceTicket(key, {
              siteId: s.siteId,
              actor: s.employeeRef,
              text,
              now,
            })
          : null,
      };
    } finally {
      // Звук команды не живёт дольше запроса (Условия п.3.4, §6.3).
      audio.fill(0);
    }
  }
}
