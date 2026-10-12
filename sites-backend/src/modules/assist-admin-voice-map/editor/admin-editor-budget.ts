/**
 * Деньги панели редактора карты «Админки» (заход 13, Р-З13-А4): ИИ-синонимы
 * и микрофон «Сказать сейчас» платит СУТОЧНЫЙ ПОТОЛОК «Админки» сайта — тот
 * же резерв, что у хода сотрудника (`reserveAdminTurn`: строка `admin/<сайт>`
 * под блокировкой + общий потолок платформы), а не бюджет обучения «Сайта»
 * (`assist-learn`, контур «Сайта» — У-28/У-29: «у „Админки“ свои бюджеты»).
 *  - резерв — ДО вызова модели/провайдера (оценка сверху);
 *  - факт — строка `site_ai_usage` с операцией «Админки»
 *    (`assist-admin-map-synonyms` / `assist-admin-stt`, обе в
 *    ADMIN_DAILY_USAGE_OPERATIONS), затем снятие резерва фактом;
 *  - сбой после вызова без записи факта — оценка остаётся расходом (строже).
 */
import { Injectable } from '@nestjs/common';
import {
  effectivePlatformCapMicroUsd,
  readWidgetPlatformSettings,
} from '../../../common/platform-settings';
import { widgetPlatformDailyCapMicroUsd } from '../../../config/widget-env';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  reserveAdminTurn,
  settleAdminTurn,
  type AdminTurnReservation,
} from '../../assist-admin-mode/admin-budget';
import { readState } from '../../assist-billing/public/entitlements';
import { siteDailyCapFromPlan } from '../../assist-billing/plans';

@Injectable()
export class AdminEditorBudget {
  env: NodeJS.ProcessEnv = process.env;
  now: () => Date = () => new Date();

  constructor(private readonly prisma: PrismaService) {}

  /** Резерв до вызова; `null` — потолок сайта или платформы исчерпан. */
  async reserve(
    accountId: string,
    siteId: string,
    estMicroUsd: number,
  ): Promise<AdminTurnReservation | null> {
    const now = this.now();
    const st = await readState(this.prisma, accountId, now);
    const r = await reserveAdminTurn(this.prisma, {
      siteId,
      siteCapMicroUsd: siteDailyCapFromPlan(st.planId),
      platformCapMicroUsd: effectivePlatformCapMicroUsd(
        widgetPlatformDailyCapMicroUsd(this.env),
        await readWidgetPlatformSettings(this.prisma),
      ),
      estMicroUsd,
      now,
    });
    return r.ok ? r.reservation : null;
  }

  /** Снятие резерва: факт (записан) или `null` — оценка в расход. */
  async settle(
    r: AdminTurnReservation,
    actualMicroUsd: number | null,
  ): Promise<void> {
    await settleAdminTurn(this.prisma, r, actualMicroUsd).catch(
      () => undefined,
    );
  }
}
