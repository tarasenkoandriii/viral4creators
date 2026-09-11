/**
 * App shell + hash router.
 *
 * Entry is the Projects list (spec §7.8 — Project is the long-lived
 * catalog; §7.9 — only the ORDER of screens changes: товар before видео).
 * The original Session wizard lives on at #/generate, untouched in logic
 * (features/generation/GenerationWizard.tsx), as the anonymous quick path
 * and — from Stage 10 — the continuation of a project item.
 *
 * Brand Manifests (spec §12) get their own section (#/manifests) — a
 * manifest is надпроектная, so it is managed here and merely attached
 * from the project side (ProjectCreateScreen / ProjectScreen).
 *
 * Visual system ported from SilverFinance: silver palette, sky accent,
 * Sora/JetBrains Mono, backdrop grid, sheen wordmark — see
 * tailwind.config.js, index.css and components/ui.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { FolderKanban, Palette, Zap } from 'lucide-react';
import { TelegramLoginButton } from './components/TelegramLoginButton';
import { useRoute, navigate, routes } from './lib/router';
import { PlanContext } from './lib/plan-context';
import { getPlanState } from './services/projects-api';
import { PlanScreen } from './features/plan/PlanScreen';
import { AccountNotice } from './components/AccountNotice';
import type { PlanState } from './types';
import { GenerationWizard } from './features/generation/GenerationWizard';
import { LegalScreen } from './features/legal/LegalScreen';
import { ProjectsListScreen } from './features/projects/ProjectsListScreen';
import { ProjectCreateScreen } from './features/projects/ProjectCreateScreen';
import { ProjectScreen } from './features/projects/ProjectScreen';
import { ItemScreen } from './features/projects/ItemScreen';
import { CatalogBatchStartScreen } from './features/projects/CatalogBatchStartScreen';
import { CatalogBatchProgressScreen } from './features/projects/CatalogBatchProgressScreen';
import { AbTestProgressScreen } from './features/projects/AbTestProgressScreen';
import { FeedImportStartScreen } from './features/projects/FeedImportStartScreen';
import { FeedImportProgressScreen } from './features/projects/FeedImportProgressScreen';
import { ManifestsListScreen } from './features/brand/ManifestsListScreen';
import { ManifestScreen } from './features/brand/ManifestScreen';
import { ChannelsScreen } from './features/channels/ChannelsScreen';
import { CreditsScreen } from './features/credits/CreditsScreen';
import { pollPlanState } from './services/billing-api';
import { Alert, Button, EmptyState } from './components/ui';
import { LanguageSwitcher } from './components/LanguageSwitcher';
import { useI18n } from './lib/i18n-context';

/**
 * Г-1.1 (аудит round4, этап 64): «Сделать такой же» с публичной страницы
 * ролика (`landing/…/video/[id]/page.tsx`) ведёт на `${TMA_URL}
 * ?fromShared=<id>` БЕЗ хеша — пустой хеш рендерит «Проекты»
 * (`ProjectsListScreen`), а форк (`useWorkflow.ts`) живёт только внутри
 * `GenerationWizard`, который монтируется исключительно на `#/generate`.
 * Анонимный посетитель по чужой ссылке видел «Проекты» с 401 «нужен
 * вход» и ни разу не доходил до форка — та самая петля шеринга, ради
 * которой делался этап 60, не доводила до результата НИ ОДНОГО нового
 * посетителя.
 *
 * Правится здесь, а не на лендинге (см. альтернативу в самом аудите):
 * менять ссылку лендинга на `#/generate?fromShared=` нельзя без правки
 * `router.ts:parseRoute`, который не умеет отделять query-часть ВНУТРИ
 * хеша (`parts[0]` стало бы `'generate?fromShared=xyz'` целиком и ушло
 * бы в not-found) — а App.tsx уже читает `fromShared` из НАСТОЯЩЕГО
 * query (`window.location.search`, независимого от хеша), значит
 * достаточно проставить хеш до первого рендера.
 *
 * Модульный уровень (выполняется один раз при загрузке скрипта, ДО
 * первого рендера `App()`) — иначе `ProjectsListScreen` успел бы
 * мигнуть и запустить собственные запросы, прежде чем useEffect внутри
 * компонента успел бы среагировать.
 */
if (typeof window !== 'undefined') {
  const hasNoRoute =
    window.location.hash === '' || window.location.hash === '#';
  const fromShared = new URLSearchParams(window.location.search).get(
    'fromShared'
  );
  if (hasNoRoute && fromShared) {
    // replaceState, не присваивание hash, — не плодит лишнюю запись в
    // истории для перехода, которого пользователь сам не делал.
    window.history.replaceState(null, '', '#/generate');
  }
}

function App() {
  const { dict } = useI18n();
  const route = useRoute();
  const inBrand = route.name.startsWith('manifest');
  const inProjects =
    !inBrand &&
    route.name !== 'generate' &&
    route.name !== 'plan' &&
    route.name !== 'channels' &&
    route.name !== 'credits' &&
    route.name !== 'not-found';

  /**
   * Режим (ТЗ §23) грузится один раз на всё приложение: замков много, и
   * восемь независимых запросов дали бы восемь шансов разойтись. `GET
   * /me/plan` открыт, поэтому анонимный путь получает честный Lite, а не
   * 401 — но если сервер недоступен, состояние остаётся `null`, и замки
   * не рисуются вовсе (лучше ничего, чем ложный замок у Premium).
   */
  const [planState, setPlanState] = useState<PlanState | null>(null);
  const [planNonce, setPlanNonce] = useState(0);
  const refreshPlan = useCallback(() => setPlanNonce((n) => n + 1), []);

  useEffect(() => {
    let alive = true;
    getPlanState()
      .then((s) => alive && setPlanState(s))
      .catch(() => {
        /* сервер молчит — работаем без замков, сервер всё равно проверит */
      });
    return () => {
      alive = false;
    };
  }, [planNonce]);

  const planValue = useMemo(
    () => ({ state: planState, refresh: refreshPlan }),
    [planState, refreshPlan]
  );

  /**
   * Возврат с формы WayForPay (§41.2, решение 17) — `?billingReturn=1`
   * дописывает `returnUrl()` на бэкенде (`billing.service.ts`). Вебхук
   * WayForPay может прийти на секунду-другую позже самого редиректа
   * обратно в приложение, поэтому здесь не разовый `GET /me/plan`, а
   * короткий опрос с бэкоффом (`pollPlanState`) — тот же приём, что
   * `PlanScreen`/`CreditsScreen` используют после Stars-оплаты. Флаг
   * убирается из URL сразу, чтобы обновление страницы не повторяло опрос.
   *
   * Г-1.5 (аудит round4, этап 64): раньше условие останова опроса было
   * заведомо ложным (`() => false` — все 4 попытки впустую), а по его
   * завершении плашка «Проверяем оплату…» просто пряталась — ни
   * «оплачено», ни «не оплачено», человек оставался на «Проектах» (тот
   * же корневой URL без хеша, что и у Г-1.1/Г-1.4) и должен был сам
   * догадаться заглянуть в «Режим»/«Кредиты». Сетевой сбой внутри опроса
   * тоже нигде не ловился (`.then` без `.catch`).
   *
   * Теперь: снимок состояния ДО опроса (и `plan`, и `credits.balance` —
   * WayForPay-возврат бывает и с покупки подписки, и с покупки пакета
   * кредитов), останов опроса по РЕАЛЬНОМУ изменению любого из них,
   * явный итог alert'ом и переход на #/plan. Отказ WayForPay ведёт на
   * тот же returnUrl, что и успех (сторона провайдера, не наша), поэтому
   * при отсутствии изменения текст НЕ утверждает «не прошла» (иначе
   * ровно тот же риск двойной оплаты, что и у Г-1.3 со Stars `pending`)
   * — честная формулировка «не удалось подтвердить сразу».
   */
  const [checkingPayment, setCheckingPayment] = useState(false);
  const [billingResult, setBillingResult] = useState<
    'success' | 'unconfirmed' | null
  >(null);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('billingReturn') !== '1') return;
    const url = new URL(window.location.href);
    url.searchParams.delete('billingReturn');
    window.history.replaceState(null, '', url.toString());
    setCheckingPayment(true);
    setBillingResult(null);
    const changed = (before: PlanState, after: PlanState) =>
      after.plan !== before.plan ||
      after.credits.balance !== before.credits.balance;
    (async () => {
      try {
        const before = await getPlanState();
        const after = await pollPlanState((s) => changed(before, s), 4, 1500);
        setPlanState(after);
        setBillingResult(changed(before, after) ? 'success' : 'unconfirmed');
      } catch {
        setBillingResult('unconfirmed');
      } finally {
        setCheckingPayment(false);
        navigate(routes.plan());
      }
    })();
  }, []);

  return (
    <PlanContext.Provider value={planValue}>
      <div className="backdrop-grid min-h-full">
        <header className="sticky top-0 z-30 border-b border-silver-200/60 dark:border-silver-800 bg-silver-50/80 dark:bg-silver-950/80 backdrop-blur">
          <div className="mx-auto flex max-w-2xl flex-wrap items-center justify-between gap-x-3 gap-y-2 px-4 py-2.5 sm:py-3">
            <button
              type="button"
              onClick={() => navigate(routes.projects())}
              className="flex min-h-[44px] items-center gap-2 text-left"
            >
              <span className="sheen text-lg font-extrabold tracking-tight">
                Viral4Creators
              </span>
              <span className="hidden sm:inline text-[11px] uppercase tracking-widest text-silver-400">
                {dict.header.tagline}
              </span>
            </button>
            <div className="flex items-center gap-2">
              <LanguageSwitcher />
              {/* Режим — рядом с входом, а не четвёртой вкладкой: на 390px
                четыре вкладки не помещаются, а знать свой режим нужно
                всегда, чтобы замок ниже не выглядел поломкой. */}
              {planState && (
                <button
                  type="button"
                  onClick={() => navigate(routes.plan())}
                  aria-label={dict.header.modeAriaLabel.replace(
                    '{{mode}}',
                    planState.plans[planState.plan]?.title ?? planState.plan
                  )}
                  className={`inline-flex min-h-[44px] items-center gap-1 rounded-full px-3 py-0.5 text-[11px] font-medium uppercase tracking-wide transition-colors ${
                    route.name === 'plan'
                      ? 'bg-accent text-accent-on'
                      : 'bg-accent/20 text-sky-800 hover:bg-accent/30 dark:text-accent'
                  }`}
                >
                  {planState.plans[planState.plan]?.title ?? planState.plan}
                </button>
              )}
              <TelegramLoginButton />
            </div>
            {/* Three tabs + login don't fit one 390px row: the nav wraps to
                its own full-width line on phones, inline from `sm` up. */}
            <nav className="order-3 flex w-full rounded-xl bg-silver-200/60 dark:bg-silver-800/60 p-0.5 sm:order-none sm:w-auto">
              <NavTab
                active={inProjects}
                onClick={() => navigate(routes.projects())}
                icon={<FolderKanban size={13} />}
              >
                {dict.nav.projects}
              </NavTab>
              <NavTab
                active={inBrand}
                onClick={() => navigate(routes.manifests())}
                icon={<Palette size={13} />}
              >
                {dict.nav.brand}
              </NavTab>
              <NavTab
                active={route.name === 'generate'}
                onClick={() => navigate(routes.generate())}
                icon={<Zap size={13} />}
              >
                {dict.nav.generate}
              </NavTab>
            </nav>
          </div>
        </header>

        <main className="mx-auto max-w-2xl px-4 py-5">
          {/* §25.3 / §26.4: о блокировке и исчерпанном лимите человек
            узнаёт сразу и на любом экране, а не красной ошибкой после
            того, как выбрал референс и дождался начала разбора. */}
          <div className="mb-4 empty:hidden">
            <AccountNotice />
          </div>
          {checkingPayment && (
            <div className="mb-4">
              <Alert tone="info">{dict.planScreen.checkoutPending}</Alert>
            </div>
          )}
          {billingResult && (
            <div className="mb-4">
              <Alert
                tone={billingResult === 'success' ? 'success' : 'info'}
                onDismiss={() => setBillingResult(null)}
              >
                {billingResult === 'success'
                  ? dict.planScreen.checkoutSuccess
                  : dict.planScreen.checkoutUnconfirmed}
              </Alert>
            </div>
          )}
          {route.name === 'projects' && <ProjectsListScreen />}
          {route.name === 'project-new' && <ProjectCreateScreen />}
          {route.name === 'project' && (
            <ProjectScreen key={route.projectId} projectId={route.projectId} />
          )}
          {route.name === 'item' && (
            <ItemScreen
              key={route.itemId}
              projectId={route.projectId}
              itemId={route.itemId}
              step={route.step}
            />
          )}
          {route.name === 'catalog-batch-start' && (
            <CatalogBatchStartScreen
              key={route.sourceSessionId}
              projectId={route.projectId}
              sourceSessionId={route.sourceSessionId}
            />
          )}
          {route.name === 'catalog-batch' && (
            <CatalogBatchProgressScreen
              key={route.batchId}
              projectId={route.projectId}
              batchId={route.batchId}
            />
          )}
          {route.name === 'ab-test' && (
            <AbTestProgressScreen
              key={route.runId}
              projectId={route.projectId}
              runId={route.runId}
            />
          )}
          {route.name === 'feed-import-start' && (
            <FeedImportStartScreen
              key={route.projectId}
              projectId={route.projectId}
            />
          )}
          {route.name === 'feed-import' && (
            <FeedImportProgressScreen
              key={route.runId}
              projectId={route.projectId}
              runId={route.runId}
            />
          )}
          {route.name === 'manifests' && <ManifestsListScreen />}
          {route.name === 'manifest-new' && <ManifestScreen />}
          {route.name === 'manifest' && (
            <ManifestScreen
              key={route.manifestId}
              manifestId={route.manifestId}
            />
          )}
          {route.name === 'generate' && <GenerationWizard />}
          {route.name === 'legal' && <LegalScreen slug={route.slug} />}
          {route.name === 'plan' && <PlanScreen />}
          {route.name === 'channels' && <ChannelsScreen />}
          {route.name === 'credits' && <CreditsScreen />}
          {route.name === 'not-found' && (
            <EmptyState
              title={dict.notFound.title}
              hint={`#/${route.path}`}
              action={
                <Button
                  variant="outline"
                  onClick={() => navigate(routes.projects(), true)}
                >
                  {dict.notFound.action}
                </Button>
              }
            />
          )}
        </main>

        {/* Б-4.8: ссылки подвала — единственный вход в юридические
            документы, а были 45×16.5px. `inline-flex` + min-h даёт
            настоящую цель касания, не меняя вид строки. */}
        <footer className="mx-auto max-w-2xl px-4 py-6 text-center text-[11px] text-silver-400">
          <span>{dict.footer.brand}</span>
          <span className="mx-1.5 opacity-40">·</span>
          <button
            type="button"
            className="inline-flex min-h-[44px] items-center px-1 underline hover:text-accent"
            onClick={() => navigate(routes.legal('offer'))}
          >
            {dict.footer.offer}
          </button>
          <span className="mx-1.5 opacity-40">·</span>
          <button
            type="button"
            className="inline-flex min-h-[44px] items-center px-1 underline hover:text-accent"
            onClick={() => navigate(routes.legal('terms-of-use'))}
          >
            {dict.footer.terms}
          </button>
          <span className="mx-1.5 opacity-40">·</span>
          <button
            type="button"
            className="inline-flex min-h-[44px] items-center px-1 underline hover:text-accent"
            onClick={() => navigate(routes.plan())}
          >
            {dict.footer.plans}
          </button>
          <span className="mx-1.5 opacity-40">·</span>
          {/* Экран «Каналы» (этап 61) — ссылкой в подвале, не четвёртой
              вкладкой: три вкладки и так упираются в ширину 390px (см.
              комментарий у <nav> выше), а канал подключается редко. */}
          <button
            type="button"
            className="inline-flex min-h-[44px] items-center px-1 underline hover:text-accent"
            onClick={() => navigate(routes.channels())}
          >
            {dict.footer.channels}
          </button>
          <span className="mx-1.5 opacity-40">·</span>
          {/* Экран «Кредиты» (этап 62) — той же ссылкой в подвале, что
              «Каналы»: покупка пакетов не относится к режиму работы и не
              вписывается в три основные вкладки. */}
          <button
            type="button"
            className="inline-flex min-h-[44px] items-center px-1 underline hover:text-accent"
            onClick={() => navigate(routes.credits())}
          >
            {dict.footer.credits}
          </button>
        </footer>
      </div>
    </PlanContext.Provider>
  );
}

function NavTab({
  active,
  onClick,
  icon,
  children,
}: {
  active: boolean;
  onClick: () => void;
  icon: ReactNode;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      // min-h-[44px]: основная навигация — три самые нажимаемые цели в
      // приложении, а высота у них была 24px против рекомендованных 44
      // (аудит 2026-09-06, А-3.7). Растёт только область нажатия: сама
      // подпись и иконка остались прежнего размера.
      className={`inline-flex min-h-[44px] flex-1 items-center justify-center gap-1 rounded-[10px] px-2.5 py-1 text-xs font-medium transition-colors sm:flex-none ${
        active
          ? 'bg-accent text-accent-on'
          : 'text-silver-500 hover:text-silver-800 dark:hover:text-silver-200'
      }`}
    >
      {icon}
      {children}
    </button>
  );
}

export default App;
