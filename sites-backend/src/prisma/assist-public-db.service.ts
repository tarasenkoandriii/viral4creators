import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { describeDbFailure, describeTarget } from '../shared/db-error';
import { SITES_DB_SCHEMA } from './prisma.service';

/**
 * AssistPublicDb — второй клиент Prisma, под логин-ролью, входящей в
 * `assist_public` (ТЗ помощника §4.3-бис, слой 3).
 *
 * ТОЛЬКО для публичных маршрутов виджета (`/widget/v1/*`, Э2) и того, что
 * они вызывают. У роли нет прав на `assist_admin_*`, кабинеты, участников
 * и challenge (GRANT-ы — миграция `…_sites_core_init`), поэтому даже
 * ошибочный запрос виджета к таблице «Админки» получит от Postgres отказ.
 * Кабинетные маршруты этим клиентом не пользуются — у них `SitesDb`.
 *
 * Адаптер и схема — те же, что у PrismaService (`PrismaPg(…, { schema:
 * 'sites' })`): квалификация имён таблиц, а не search_path, который пулер
 * Supabase в transaction-режиме не держит.
 *
 * Строка — `ASSIST_PUBLIC_DATABASE_URL` (doc/DEPLOYMENT.md, раздел 6.4).
 * Нужна с маршрутами виджета; до них её отсутствие — предупреждение.
 */
/**
 * Э2: колонки, которых у роли `assist_public` НЕТ (колоночные GRANT
 * миграции `…_assist_widget`). Prisma без `select` выбирает всю строку (и
 * `create`/`update` возвращают её через RETURNING) — запрос к закрытой
 * колонке Postgres отвергает целиком (42501). Глобальный `omit` убирает их
 * из каждого запроса публичного клиента.
 *
 * Типы Prisma об этом `omit` не знают (класс наследует PrismaClient без
 * параметров): поле в типе есть, в значении — `undefined`. Публичный код
 * эти поля не читает; новый код публичных маршрутов пишет явный `select`.
 * Список сверяет assist-public-role.spec.ts с правами в базе.
 */
export const ASSIST_PUBLIC_OMIT = {
  assistSite: {
    recrawlEvery: true,
    nextCrawlAt: true,
    lastCrawlRunId: true,
    lastIndexedCrawlRunId: true,
    hotPages: true,
    hotCheckedAt: true,
    learningShareBp: true,
    versionSeq: true,
    currency: true,
    widgetDraft: true,
    personaDraft: true,
    leadRetentionDays: true,
    // Э4: createdAt открыт роли — начало пробного периода (min по кабинету).
    updatedAt: true,
    // Э6-бис (г): состояние голосового управления — кабинету и монитору
    // (роли — только потолок планов `voiceControlPlansPerDay`).
    voiceControlSiteTestId: true,
    voiceControlSiteStateAt: true,
    voiceControlSiteStateBy: true,
    voiceControlSiteStateReason: true,
    voiceControlCheckDeadline: true,
    // Э6-бис (д)+(е): счётчик номеров мемо и версия рисков — только кабинет.
    memoCounter: true,
    voiceControlRisksVersion: true,
  },
  assistSiteFaq: {
    approvedByTelegramId: true,
    approvedAt: true,
    reviewAt: true,
    conflictNote: true,
    fromConversationId: true,
    variantRefs: true,
    createdByTelegramId: true,
    createdAt: true,
  },
  assistSandbox: { createdByTelegramId: true },
  assistSiteConfigVersion: {
    id: true,
    accountId: true,
    gateReport: true,
    rolledBackFrom: true,
    publishedByTelegramId: true,
    createdAt: true,
  },
  assistSitePreviewToken: {
    createdByTelegramId: true,
    createdAt: true,
    result: true,
  },
  assistSiteAsset: { accountId: true, createdAt: true },
  // Э3 (миграция …_assist_handoff).
  assistSiteMessage: { authorMemberId: true },
  assistSiteLead: {
    id: true,
    accountId: true,
    conversationId: true,
    fieldsEnc: true,
    fieldNames: true,
    identityEnc: true,
    identityVerified: true,
    consentText: true,
    consentAt: true,
    pageUrl: true,
    deliveryState: true,
    deliveredTo: true,
    attempts: true,
    lockedUntil: true,
    lastError: true,
    deliveredAt: true,
    createdAt: true,
  },
  assistSiteHandoff: {
    accountId: true,
    reason: true,
    escalation: true,
    visitorLang: true,
    operatorLang: true,
    pageUrl: true,
    summary: true,
    draft: true,
    identityEnc: true,
    identityVerified: true,
    assignedMemberId: true,
    assignedTelegramId: true,
    deliveredAt: true,
    firstReplyAt: true,
    lastOperatorAt: true,
    lastVisitorAt: true,
    remindedAt: true,
    reminders: true,
    closedBy: true,
    cards: true,
    attempts: true,
    lockedUntil: true,
    costMicroUsd: true,
    createdAt: true,
    updatedAt: true,
  },
  assistSiteGoal: {
    accountId: true,
    name: true,
    lastFiredAt: true,
    createdByTelegramId: true,
    createdAt: true,
    updatedAt: true,
  },
  // Э5 (миграция …_assist_voice): кэш озвучки — роль читает звук по ключу.
  assistSiteTtsCache: {
    id: true,
    voice: true,
    lang: true,
    characters: true,
    createdAt: true,
  },
  // Э6 (миграция …_assist_video_highlight): ролики — без хозяина, черновика
  // и id генератора; карта интерфейса — элементы по странице и счётчик промахов.
  assistSiteVideo: {
    accountId: true,
    externalId: true,
    draftId: true,
    ownerTelegramId: true,
    syncedAt: true,
    createdAt: true,
    updatedAt: true,
  },
  siteUiMap: {
    accountId: true,
    hostId: true,
    elementsHash: true,
    capturedAt: true,
    lastStaleAt: true,
    createdAt: true,
    updatedAt: true,
    // Э-С Ш4: вид и версия снимка — роли не нужны (она читает элементы).
    viewport: true,
    version: true,
  },
  // Э-С Ш4 (миграция …_site_ui_maps_shared): слитые элементы — публичный
  // код ходит сырым SQL; без кандидатов, источников, уверенности и кабинета.
  siteUiElement: {
    accountId: true,
    hostId: true,
    role: true,
    candidates: true,
    stability: true,
    confidence: true,
    sources: true,
    firstSeenAt: true,
    lastSeenAt: true,
    lastMissAt: true,
    createdAt: true,
    updatedAt: true,
  },
} as const satisfies Prisma.GlobalOmitConfig;

/** Опции клиента под ролью assist_public — одни и те же в проде и в тестах. */
export function assistPublicClientOptions(
  url: string,
): Prisma.PrismaClientOptions {
  return {
    adapter: new PrismaPg(url, { schema: SITES_DB_SCHEMA }),
    omit: ASSIST_PUBLIC_OMIT,
  };
}

@Injectable()
export class AssistPublicDb
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(AssistPublicDb.name);

  constructor() {
    super(
      assistPublicClientOptions(process.env.ASSIST_PUBLIC_DATABASE_URL ?? ''),
    );
    // Адаптер ещё не подключался (это делает $connect), так что проверка
    // после super ничего не открывает — просто раньше места нет.
    assertDistinctLogin(
      process.env.ASSIST_PUBLIC_DATABASE_URL,
      process.env.SITES_DATABASE_URL,
    );
  }

  async onModuleInit(): Promise<void> {
    const url = process.env.ASSIST_PUBLIC_DATABASE_URL;
    if (!url) {
      this.logger.warn(
        'ASSIST_PUBLIC_DATABASE_URL не задана — публичным маршрутам виджета базы не будет',
      );
      return;
    }
    try {
      await this.$connect();
    } catch (error) {
      // Не роняем весь сервис: кабинет и вебхуки от этой строки не
      // зависят, а виджетных маршрутов на Э0 ещё нет.
      const info = describeDbFailure(error, url);
      this.logger.error(`assist_public: ${info.message}`);
      this.logger.error(`Что делать: ${info.hint}`);
      return;
    }
    const target = describeTarget(url);
    this.logger.log(
      `Подключено под ролью виджета, схема ${SITES_DB_SCHEMA}${target ? ` (${target})` : ''}`,
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}

/** Имя пользователя из строки подключения (без пароля). */
export function loginOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return decodeURIComponent(new URL(url).username) || null;
  } catch {
    return null;
  }
}

/**
 * Публичный клиент под тем же логином, что и основной, — это слой 3
 * изоляции, выключенный молча: владелец схемы читает всё. Лучше упасть на
 * старте с понятной фразой (без пароля в тексте).
 */
export function assertDistinctLogin(
  publicUrl: string | undefined,
  mainUrl: string | undefined,
): void {
  const pub = loginOf(publicUrl);
  if (pub !== null && pub === loginOf(mainUrl)) {
    throw new Error(
      'ASSIST_PUBLIC_DATABASE_URL использует того же пользователя БД, что SITES_DATABASE_URL, — ' +
        'нужна отдельная логин-роль в assist_public (doc/DEPLOYMENT.md, раздел 6.4)',
    );
  }
}
