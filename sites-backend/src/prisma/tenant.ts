/**
 * Prisma-extension тенанта (ТЗ помощника §4.4, QA-ТЗ §4.7, приёмка Э0).
 *
 * Тенант — кабинет `SiteAccount`. Каждая таблица кабинета несёт его id, и
 * запрос к ней БЕЗ кабинета обязан бросать, а не возвращать «всё»: одна
 * забытая строка `where: { accountId }` в сервисе — и кабинет A видит
 * хосты кабинета B (Klientskiy-Audit… §5.3).
 *
 * Два режима одной проверки (`scopeArgs`):
 *  - `accountId` задан (`SitesDb.forAccount`) — кабинет ПОДСТАВЛЯЕТСЯ в
 *    where/data; если вызывающий указал ДРУГОЙ кабинет — отказ, а не тихая
 *    перезапись (это ошибка в коде, её надо увидеть);
 *  - `accountId = null` (`SitesDb.guarded`) — ничего не подставляется,
 *    но запрос без явного кабинета в where/data бросает.
 *
 * Чего extension НЕ покрывает (и не может — это граница Prisma):
 *  - `$queryRaw`/`$executeRaw` — сырой SQL к таблицам кабинета обязан
 *    принимать accountId параметром (проверка — ревью и тест сервиса);
 *  - вложенные записи (`include`, nested `create`) — их держит база:
 *    составные внешние ключи (siteId, accountId) у хоста и (hostId,
 *    accountId) у challenge не дают связать строки разных кабинетов.
 *
 * Записи в таблицы кабинета — только скалярным `accountId` (unchecked
 * input), не `account: { connect }`: иначе подставлять нечего.
 */

import { Prisma } from '@prisma/client';

export class TenantScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TenantScopeError';
  }
}

/**
 * Модели кабинета → колонка тенанта. У самого кабинета это `id`.
 * Новая модель обязана попасть либо сюда, либо в `NON_TENANT_MODELS` —
 * это сторожит тест (tenant.spec.ts), иначе её забыли бы в обоих.
 */
export const TENANT_COLUMNS: Readonly<Record<string, string>> = {
  SiteAccount: 'id',
  SiteAccountMember: 'accountId',
  SiteAccountInvite: 'accountId',
  Site: 'accountId',
  SiteHost: 'accountId',
  SiteOwnershipChallenge: 'accountId',
  SiteAiUsage: 'accountId',
  // Э1: обход (site-crawl, общий с QA) — строки кабинета.
  SitePage: 'accountId',
  SiteCrawlRun: 'accountId',
  SiteCrawlQueueItem: 'accountId',
  // Э1: помощник — всё, что принадлежит сайту кабинета, несёт accountId
  // (составной FK (siteId, accountId) → site_sites держит то же в базе).
  AssistSite: 'accountId',
  AssistLearningSpend: 'accountId',
  AssistSiteSource: 'accountId',
  AssistSiteDocument: 'accountId',
  AssistSiteChunk: 'accountId',
  AssistSiteKnowledgeVersion: 'accountId',
  AssistSiteFaq: 'accountId',
  AssistSiteExclusion: 'accountId',
  AssistSiteEvalCase: 'accountId',
  AssistSiteEvalRun: 'accountId',
  AssistAdminSettings: 'accountId',
  AssistAdminSource: 'accountId',
  AssistAdminDocument: 'accountId',
  AssistAdminChunk: 'accountId',
  AssistAdminKnowledgeVersion: 'accountId',
  AssistAdminFaq: 'accountId',
  AssistAdminExclusion: 'accountId',
  // Э7 «Админка»: чтение — строки кабинета (составные FK (siteId, accountId)
  // держат то же в базе; у журнала вызовов FK нет — он переживает удаление
  // коннектора, но accountId несёт). Сессию встраивания маршрут находит по
  // хешу токена системным чтением (кабинета в запросе сотрудника ещё нет) —
  // дальше всё идёт с кабинетом сессии.
  AssistAdminConnector: 'accountId',
  AssistAdminOperation: 'accountId',
  AssistAdminActionLog: 'accountId',
  AssistAdminConversation: 'accountId',
  AssistAdminMessage: 'accountId',
  AssistAdminSession: 'accountId',
  AssistAdminLearningItem: 'accountId',
  AssistAdminCrawlJob: 'accountId',
  AssistAdminPage: 'accountId',
  // Э8 «Админка»: действия — предложения «Да», мемо АМ-N (составные FK
  // (siteId, accountId); «Да» ищет предложение по id И сотруднику сессии).
  AssistAdminActionProposal: 'accountId',
  AssistAdminMemo: 'accountId',
  AssistAdminMemoVersion: 'accountId',
  AssistAdminPhrase: 'accountId',
  AssistAdminMemoRun: 'accountId',
  // Э6-бис (б): голосовое управление «Админкой» — планы сотрудников и
  // мастер проверки (составные FK (siteId, accountId)); сессию сотрудника
  // маршрут находит по хешу токена, дальше — кабинет сессии.
  AssistAdminUiPlan: 'accountId',
  AssistAdminVoiceTest: 'accountId',
  // Заход 11 (№117): голосовая карта «Админки» — черновик, версии, сессии
  // редактора (составные FK (siteId, accountId)); сессию редактора маршрут
  // находит системным чтением по хешу токена, дальше — кабинет сессии.
  AssistAdminVoiceMap: 'accountId',
  AssistAdminVoiceMapVersion: 'accountId',
  AssistAdminVoiceMapEditorSession: 'accountId',
  // Заход 10, №57: аналитика «Админки» — разметка, суточная свёртка, выводы
  // недели, выгрузки (составные FK (conversationId|siteId, accountId)).
  // Пишет крон assist-admin-embed-run системным клиентом с причиной и
  // кабинет `assistAdmin: owner` — с тенантом.
  AssistAdminConversationLabel: 'accountId',
  AssistAdminDailyStat: 'accountId',
  AssistAdminInsight: 'accountId',
  AssistAdminExport: 'accountId',
  // Э2: виджет «Сайта». Публичные маршруты ходят в эти таблицы клиентом
  // AssistPublicDb (без extension, по siteId/visitorId/хешам) — тенант
  // держит кабинетный код (экраны, Э3-лента диалогов) и составной FK.
  AssistSiteConfigVersion: 'accountId',
  AssistSiteConversation: 'accountId',
  AssistSiteMessage: 'accountId',
  AssistSiteLead: 'accountId',
  AssistSitePreviewToken: 'accountId',
  AssistSiteWizard: 'accountId',
  AssistSiteAsset: 'accountId',
  AssistAcquisition: 'accountId',
  // Э3 (контракт /tmp/k/CONTRACT-E3.md): передача человеку, обучение,
  // цели и статистика. Передачу, сигнал очереди и событие цели создаёт
  // публичный маршрут клиентом AssistPublicDb (без extension, с accountId
  // из контекста сайта) — тенант держит кабинетный и системный код.
  AssistSiteHandoff: 'accountId',
  AssistBotMessage: 'accountId',
  AssistSiteLearningItem: 'accountId',
  AssistSiteLearningCluster: 'accountId',
  AssistSiteGoal: 'accountId',
  AssistSiteGoalEvent: 'accountId',
  AssistSiteIntegration: 'accountId',
  AssistSiteDailyTotal: 'accountId',
  AssistSiteExport: 'accountId',
  AssistSiteReportSubscription: 'accountId',
  // Э4: тариф и оплата — строки кабинета. Счётчик единиц пишет конвейер
  // ответа сырым SQL под assist_public (accountId — из контекста сайта).
  AssistSubscription: 'accountId',
  AssistAccountUsage: 'accountId',
  AssistPayment: 'accountId',
  AssistLegalAcceptance: 'accountId',
  // Э6: ролики обучалки генератора на сайте помощника (пишет внутренний API
  // по siteId сайта кабинета, читает кабинет и — по siteId — виджет под
  // assist_public) и карта интерфейса страниц (обход кабинета, Ш4 — общая).
  AssistSiteVideo: 'accountId',
  SiteUiMap: 'accountId',
  // Э-С Ш4: история карт, слитые элементы и журнал промахов — строки
  // кабинета (составные FK держат то же в базе). Промахи пишет публичный
  // код сырым SQL под assist_public (accountId — из контекста сайта).
  SiteUiMapVersion: 'accountId',
  SiteUiElement: 'accountId',
  SiteUiElementMiss: 'accountId',
  // Э-С Ш2: тестовые учётные записи сайта, их секреты и аренды — строки
  // кабинета (составной FK держит то же в базе).
  SiteTestAccount: 'accountId',
  SiteCredential: 'accountId',
  SiteCredentialLease: 'accountId',
  // Э6-бис (а): планы голосового управления и журнал действий — строки
  // кабинета (составные FK (conversationId|planId, accountId)). Пишет
  // публичный маршрут сырым SQL под assist_public (accountId — из контекста
  // сайта); кабинетный код (журнал, (б)/(г)) ходит с тенантом.
  AssistSiteUiPlan: 'accountId',
  AssistSiteUiActionLog: 'accountId',
  // Э6-бис (г): отчёты мастера Т-2, контрольные команды, журнал точечного
  // переобхода — строки кабинета (составной FK (siteId, accountId)). Отчёт
  // пишет виджет сырым SQL под assist_public; кабинет читает с тенантом.
  AssistSiteVoiceTest: 'accountId',
  AssistSiteVoiceControlCommand: 'accountId',
  AssistSiteUiRecrawl: 'accountId',
  // Журнал монитора: у событий платформы (откат канарейки, рубильник)
  // accountId = NULL — кабинету не видны; события сайта — строки кабинета.
  AssistSiteVoiceIncident: 'accountId',
  // Э6-бис (е): мемо «Сайта», версии, история и индекс фраз — строки
  // кабинета (составные FK (siteId|memoId, accountId)). Публичный код их не
  // трогает (только представления миграции _assist_chains_memo).
  AssistSiteMemo: 'accountId',
  AssistSiteMemoVersion: 'accountId',
  AssistSiteMemoChange: 'accountId',
  AssistSitePhrase: 'accountId',
  // Э6-тер: голосовая карта «Сайта» — черновик, версии, журнал, ссылки и
  // сессии редактора — строки кабинета (составной FK (siteId, accountId)).
  // Публичный код их не трогает (только представление миграции
  // _assist_visual_editor); сессию редактора по хешу токена находит
  // системное чтение, дальше — клиент тенанта.
  AssistSiteVoiceMap: 'accountId',
  AssistSiteVoiceMapVersion: 'accountId',
  AssistSiteVoiceMapChange: 'accountId',
  // №113 (заход 11): кандидаты в термины из неуверенного распознавания.
  AssistSiteSttLowTerm: 'accountId',
  AssistSiteVoiceMapEditorSession: 'accountId',
  // Заход 9: отчёт для разработчика — ссылку по хешу токена находит
  // системное чтение (кабинета в запросе нет), дальше — клиент тенанта.
  AssistSiteVoiceMapDevReport: 'accountId',
  // Э3-бис: аналитика с ИИ — разметка диалогов, расход бюджета аналитики,
  // калибровка score, выводы недели, эксперименты, свёртка поведения —
  // строки кабинета (составные FK (siteId|conversationId, accountId)).
  // Пишет системный код (крон) и кабинет; публичный код читает только
  // идущий эксперимент (колонки) — сырым SQL под assist_public.
  AssistSiteConversationLabel: 'accountId',
  AssistAnalyticsSpend: 'accountId',
  AssistSiteLeadCalibration: 'accountId',
  AssistSiteInsight: 'accountId',
  AssistSiteExperiment: 'accountId',
  AssistSiteDailyPage: 'accountId',
  // Э-С Ш3: задания браузерного воркера и их артефакты — строки кабинета
  // (составной FK (siteId, accountId)). Воркер забирает задания ВСЕХ
  // кабинетов — только системным клиентом с причиной (browser-jobs.service:
  // claim, аренда, ретенция); продукты ставят и читают — с тенантом.
  SiteBrowserJob: 'accountId',
  SiteBrowserArtifact: 'accountId',
};

/**
 * Модели вне тенанта — с причиной, почему.
 */
export const NON_TENANT_MODELS: Readonly<Record<string, string>> = {
  SonioxEvent:
    'глобальный operational-журнал провайдера; чтение только оператором через внутренний API',
  SiteOptOutDomain: 'глобальный справочник отказов, общий для всех кабинетов',
  // Сессия — личность Telegram (кто вошёл), а не членство: один человек в
  // нескольких кабинетах — одна сессия; кабинет и роль проверяются на
  // каждом запросе по site_account_members.
  SiteWebSession: 'сессия веб-кабинета: личность Telegram, не кабинет',
  // Э1. Фрагменты знаний (AssistSiteChunk/AssistAdminChunk) с Э1 — в
  // тенанте (выше): у них появился accountId. Поиск по ним — сырым SQL
  // через репозитории с обязательным siteId (§4.4) — extension его не видит.
  SiteCronLock: 'замок крона: кроны идут по всем кабинетам',
  // Э-С Ш1 (П-С3): id подписанных запросов генератора — защита от повтора.
  SiteInternalRequest:
    'использованные id внутреннего API генератора: вызывающий — сервис, не кабинет',
  SiteCrawlRobots:
    'robots.txt/sitemap по origin — публичная информация, общий кэш всех кабинетов и песочниц',
  AssistDailyCounter:
    'суточные лимиты платформы (публичная песочница: IP, домен, деньги) — вне кабинета',
  // Анонимная песочница лендинга не имеет кабинета (accountId NULL до
  // переноса по sb_<id>); доступ — по неугадываемому id (+ cookie браузера
  // у публичной); кабинетная песочница проверяется по siteId сайта,
  // найденного через SitesDb.forAccount.
  AssistSandbox: 'песочница: анонимная (без кабинета) или онбординг по siteId',
  AssistSandboxPage: 'страницы песочницы — по sandboxId',
  AssistSandboxChunk: 'фрагменты песочницы — по sandboxId',
  AssistSandboxMessage: 'вопросы и ответы песочницы — по sandboxId',
  // Э2. Таблицы, которые пишет публичный маршрут виджета по siteId (кабинета
  // в запросе посетителя нет и быть не может — он знает только pk).
  AssistSiteVisitorResume:
    'указатель посетителя (resumeKey) — по хешу ключа и siteId, пишет виджет',
  AssistSiteSemanticCache: 'семантический кэш ответов по siteId — пишет виджет',
  AssistSiteInstallPing: 'пинги загрузчика по (siteId, origin) — пишет виджет',
  AssistBudgetDay:
    'деньги дня сайта и платформы (scope, key, day) — пишет виджет; платформа вне кабинетов',
  AssistBudgetReservation: 'резервы бюджета с TTL — по siteId, снимает крон',
  AssistRateBucket: 'окна лимитов частоты (IP, посетитель) — вне кабинета',
  AssistWidgetDraft: 'анонимный черновик вида с лендинга — кабинета ещё нет',
  AssistLandingEvent: 'события лендинга — без кабинета и без идентификатора',
  // Э3.
  AssistBotUser:
    'человек в боте Помощника (нажал Start/заблокировал) — личность Telegram, не кабинет',
  AssistSiteForgetJob:
    'хвост forget посетителя по siteId — пишет виджет, доделывает системный код',
  AssistSiteEventCount:
    'суточные счётчики событий виджета по siteId — пишет виджет одним UPSERT',
  // Э4: вкладка «Помощник» админки платформы — по всем кабинетам сразу.
  AssistPlatformSetting:
    'настройки платформы (рубильник, потолок) — вне кабинетов',
  AssistPlatformAccessLog:
    'журнал доступа операторов платформы — по всем кабинетам',
  AssistPlatformEvalCandidate:
    'кандидаты eval платформы из ревью — набор платформы, не кабинета',
  // Э5: кэш озвучки ответов «Сайта» — пишет публичный маршрут по siteId.
  AssistSiteTtsCache: 'кэш озвучки ответов по siteId — пишет виджет',
  // Э-С Ш2, режим B: владелец — пользователь генератора, не кабинет.
  UserSiteSession:
    'личная запись режима B: владелец — пользователь генератора (ownerRef), кабинета нет',
  UserSiteSecret: 'секрет личной записи режима B — по sessionId',
  SiteCredentialAudit:
    'журнал доступа к учётным данным: обе зоны (кабинет и личные записи), без FK',
  // Э3-бис: пишет публичный маршрут виджета (кабинета в запросе посетителя
  // нет): единица эксперимента — по experimentId, итог просмотра — по siteId.
  AssistSiteExperimentUnit:
    'единица эксперимента (хеш визита) — по experimentId, пишет виджет',
  AssistSitePageView:
    'сырой итог просмотра страницы (7 дней) — по siteId, пишет виджет',
};

const WHERE_OPERATIONS = new Set([
  'findUnique',
  'findUniqueOrThrow',
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'count',
  'aggregate',
  'groupBy',
  'update',
  'updateMany',
  'updateManyAndReturn',
  'delete',
  'deleteMany',
]);

const CREATE_OPERATIONS = new Set([
  'create',
  'createMany',
  'createManyAndReturn',
]);

const UPDATE_OPERATIONS = new Set([
  'update',
  'updateMany',
  'updateManyAndReturn',
]);

type Args = Record<string, unknown>;

function isRecord(v: unknown): v is Args {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function missing(model: string, operation: string, where: string): never {
  throw new TenantScopeError(
    `${model}.${operation}: запрос к таблице кабинета без кабинета (${where}) — ` +
      'используйте SitesDb.forAccount(accountId) или SitesDb.system(причина)',
  );
}

function conflict(model: string, operation: string, column: string): never {
  throw new TenantScopeError(
    `${model}.${operation}: ${column} в запросе не совпадает с кабинетом контекста`,
  );
}

/** where: подставить кабинет (accountId задан) или потребовать его. */
function scopeWhere(
  model: string,
  operation: string,
  column: string,
  where: unknown,
  accountId: string | null,
): Args {
  const w: Args = isRecord(where) ? { ...where } : {};
  if (accountId === null) {
    const v = w[column];
    if (typeof v !== 'string' || v === '') {
      missing(model, operation, `where.${column}`);
    }
    return w;
  }
  if (w[column] !== undefined && w[column] !== accountId) {
    conflict(model, operation, `where.${column}`);
  }
  w[column] = accountId;
  return w;
}

/** data одной записи на создание. */
function scopeCreateData(
  model: string,
  operation: string,
  column: string,
  data: unknown,
  accountId: string | null,
): Args {
  const d: Args = isRecord(data) ? { ...data } : {};
  if (accountId === null) {
    const v = d[column];
    if (typeof v !== 'string' || v === '') {
      missing(model, operation, `data.${column}`);
    }
    return d;
  }
  if (d[column] !== undefined && d[column] !== accountId) {
    conflict(model, operation, `data.${column}`);
  }
  d[column] = accountId;
  return d;
}

/** Перенос строки в другой кабинет обновлением запрещён в обоих режимах. */
function assertUpdateKeepsTenant(
  model: string,
  operation: string,
  column: string,
  data: unknown,
  tenant: unknown,
): void {
  if (!isRecord(data) || data[column] === undefined) return;
  if (data[column] !== tenant) conflict(model, operation, `data.${column}`);
}

/**
 * Аргументы запроса → аргументы с кабинетом (или отказ). Исходный объект
 * не меняется: вызывающий мог переиспользовать его для другого кабинета.
 */
export function scopeArgs(
  model: string | undefined,
  operation: string,
  args: unknown,
  accountId: string | null,
): unknown {
  if (accountId !== null && (typeof accountId !== 'string' || !accountId)) {
    throw new TenantScopeError('Пустой кабинет в контексте тенанта');
  }
  if (!model) return args;
  const column = TENANT_COLUMNS[model];
  if (!column) return args;

  const a: Args = isRecord(args) ? { ...args } : {};

  if (WHERE_OPERATIONS.has(operation)) {
    a.where = scopeWhere(model, operation, column, a.where, accountId);
    if (UPDATE_OPERATIONS.has(operation)) {
      assertUpdateKeepsTenant(
        model,
        operation,
        column,
        a.data,
        (a.where as Args)[column],
      );
    }
    return a;
  }

  if (CREATE_OPERATIONS.has(operation)) {
    if (Array.isArray(a.data)) {
      if (a.data.length === 0) return a;
      a.data = a.data.map((d) =>
        scopeCreateData(model, operation, column, d, accountId),
      );
    } else {
      a.data = scopeCreateData(model, operation, column, a.data, accountId);
    }
    return a;
  }

  if (operation === 'upsert') {
    a.where = scopeWhere(model, operation, column, a.where, accountId);
    const tenant = (a.where as Args)[column];
    a.create = scopeCreateData(model, operation, column, a.create, accountId);
    if ((a.create as Args)[column] !== tenant) {
      conflict(model, operation, `create.${column}`);
    }
    assertUpdateKeepsTenant(model, operation, column, a.update, tenant);
    return a;
  }

  // Неизвестная операция (новая версия Prisma) — закрытый отказ: лучше
  // упасть в тесте, чем молча пропустить запрос без кабинета.
  throw new TenantScopeError(
    `${model}.${operation}: операция не известна extension'у тенанта — добавьте её в prisma/tenant.ts`,
  );
}

/**
 * Extension для `$extends`. `accountId = null` — режим «только проверка».
 */
export function tenantExtension(accountId: string | null) {
  return Prisma.defineExtension({
    name: accountId === null ? 'sites-tenant-guard' : 'sites-tenant-scope',
    query: {
      $allModels: {
        $allOperations({ model, operation, args, query }) {
          return query(
            scopeArgs(model, operation, args, accountId) as typeof args,
          );
        },
      },
    },
  });
}
