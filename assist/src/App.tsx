import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  ArrowLeft,
  BookOpen,
  Globe,
  LayoutTemplate,
  LogOut,
  MessagesSquare,
  Users,
} from 'lucide-react';
import {
  ApiError,
  KitContext,
  PRODUCT_NAMES,
  buildRequestAuth,
  createApiClient,
  createSitesApi,
  createWebAuthApi,
  detectAuthMode,
  errorText,
  getDictionary,
  getTelegramWebApp,
  inviteTokenFromLaunch,
  readStoredAccountId,
  readStoredLocale,
  resolveLocale,
  storeAccountId,
  storeLocale,
  stripInviteParam,
  telegramLanguageCode,
  useAsync,
  useKit,
  type AccountInfo,
  type AuthMode,
  type KitValue,
  type Locale,
  type TelegramLoginPayload,
} from './kit';
import { Alert, Button, Spinner } from './kit/ui';
import { AccountSwitcher } from './kit/ui/AccountSwitcher';
import { LanguageSwitcher } from './kit/ui/LanguageSwitcher';
import { AddSiteScreen } from './kit/screens/AddSiteScreen';
import { AuthorizationsScreen } from './kit/screens/AuthorizationsScreen';
import { HostVerifyScreen } from './kit/screens/HostVerifyScreen';
import { InviteScreen } from './kit/screens/InviteScreen';
import { MembersScreen } from './kit/screens/MembersScreen';
import { SiteScreen } from './kit/screens/SiteScreen';
import { SitesListScreen } from './kit/screens/SitesListScreen';
import { WebLoginScreen } from './kit/screens/WebLoginScreen';
import { getAppDictionary, type AppDictionary } from './i18n';
import {
  APP_ID,
  ASSIST_BOT_USERNAME,
  DEV_AUTH,
  SITES_API_URL,
} from './lib/config';
import { navigate, useRoute, type Route } from './lib/router';
import { SectionPlaceholder } from './screens/SectionPlaceholder';
import { WelcomeScreen } from './screens/WelcomeScreen';

/**
 * Где мы: `checking` — веб, спрашиваем `/sites/auth/me`; `login` — веб без
 * сессии; `ready` — личность есть (initData, дев-вход или cookie).
 */
type Phase = 'checking' | 'login' | 'ready';

type Notice = { tone: 'success' | 'danger'; text: string };

function initialLanguage(mode: AuthMode): string | undefined {
  // В браузере Telegram язык не сообщает — берём язык браузера (явная
  // настройка человека), иначе кабинет открылся бы по-украински всем.
  if (mode === 'tma') return telegramLanguageCode();
  return typeof navigator !== 'undefined' ? navigator.language : undefined;
}

function clearInviteFromUrl() {
  try {
    window.history.replaceState(
      null,
      '',
      stripInviteParam(window.location.href)
    );
  } catch {
    /* адрес не меняется — повтор приглашения даст INVITE_INVALID, не вред */
  }
}

export function App({ startParam }: { startParam: string | null }) {
  // Режим решает initData (см. detectAuthMode); за сессию не меняется.
  const [mode] = useState<AuthMode>(() =>
    detectAuthMode(getTelegramWebApp()?.initData, DEV_AUTH)
  );
  const [locale, setLocaleState] = useState<Locale>(() =>
    resolveLocale(readStoredLocale(), initialLanguage(mode))
  );
  const dict = getDictionary(locale);
  const appDict = getAppDictionary(locale);
  // Клиент живёт дольше одного рендера — язык, словарь и кабинет читает
  // через ref, чтобы их смена не пересоздавала клиента.
  const localeRef = useRef(locale);
  localeRef.current = locale;
  const dictRef = useRef(dict);
  dictRef.current = dict;
  const accountIdRef = useRef<string | null>(readStoredAccountId());

  const [phase, setPhase] = useState<Phase>(
    mode === 'web' ? 'checking' : 'ready'
  );
  const [checkError, setCheckError] = useState<string | null>(null);
  const [checkTick, setCheckTick] = useState(0);
  const [notice, setNotice] = useState<Notice | null>(null);

  // Приглашение из запуска: startapp=inv_… (TMA) или ?invite= (веб).
  const inviteRef = useRef<string | null>(
    inviteTokenFromLaunch(
      startParam,
      typeof window !== 'undefined' ? window.location.search : ''
    )
  );
  // Принятие — один раз за запуск, даже если загрузка кабинета
  // перезапустится (StrictMode, смена фазы): иначе второй параллельный
  // GET /sites/account успел бы создать новичку пустой «свой» кабинет.
  const inviteJob = useRef<Promise<void> | null>(null);

  const client = useMemo(
    () =>
      createApiClient({
        baseUrl: SITES_API_URL,
        auth: () =>
          buildRequestAuth(
            APP_ID,
            mode,
            getTelegramWebApp()?.initData,
            DEV_AUTH
          ),
        accountId: () => accountIdRef.current,
        locale: () => localeRef.current,
        // Веб: 401 — сессия истекла или её нет → экран входа.
        onUnauthorized: () => {
          if (mode === 'web') setPhase('login');
        },
      }),
    [mode]
  );
  const api = useMemo(() => createSitesApi(client), [client]);
  const webAuth = useMemo(() => createWebAuthApi(client), [client]);

  useEffect(() => {
    document.documentElement.lang = locale;
    document.title = PRODUCT_NAMES[APP_ID][locale];
  }, [locale]);

  // Веб: есть ли сессия (cookie HttpOnly — спросить можно только сервер).
  useEffect(() => {
    if (mode !== 'web' || phase !== 'checking') return;
    let cancelled = false;
    setCheckError(null);
    webAuth.me().then(
      (user) => {
        if (!cancelled) setPhase(user ? 'ready' : 'login');
      },
      (e: unknown) => {
        if (!cancelled) setCheckError(errorText(e, dictRef.current));
      }
    );
    return () => {
      cancelled = true;
    };
  }, [mode, phase, webAuth, checkTick]);

  const acceptInvite = useCallback(
    async (token: string) => {
      try {
        const joined = await api.acceptInvite(token);
        accountIdRef.current = joined.account.id;
        storeAccountId(joined.account.id);
        setNotice({ tone: 'success', text: dictRef.current.invite.accepted });
        inviteRef.current = null;
        clearInviteFromUrl();
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) {
          // Сессия кончилась — приглашение ждёт следующего входа.
          inviteJob.current = null;
          throw e;
        }
        inviteRef.current = null;
        clearInviteFromUrl();
        setNotice({ tone: 'danger', text: errorText(e, dictRef.current) });
      }
    },
    [api]
  );

  // Кабинет: сначала приглашение (новичок должен попасть в кабинет
  // пригласившего, а не получить автосозданный пустой), затем
  // GET /sites/account — кабинет создаётся при первом входе (ТЗ §4.16).
  const account = useAsync<AccountInfo | null>(async () => {
    if (phase !== 'ready') return null;
    const token = inviteRef.current;
    if (token) {
      inviteJob.current ??= acceptInvite(token);
      await inviteJob.current;
    }
    try {
      return await api.account();
    } catch (e) {
      // Запомненный кабинет больше недоступен (исключили) — забываем
      // выбор и открываем тот, что выберет сервер.
      if (
        e instanceof ApiError &&
        e.code === 'ACCOUNT_REQUIRED' &&
        accountIdRef.current
      ) {
        accountIdRef.current = null;
        storeAccountId(null);
        return await api.account();
      }
      throw e;
    }
  }, [api, phase, acceptInvite]);

  const setLocale = (l: Locale) => {
    setLocaleState(l);
    storeLocale(l);
  };

  const switchAccount = (id: string) => {
    accountIdRef.current = id;
    storeAccountId(id);
    setNotice(null);
    navigate({ name: 'home' }, true);
    account.reload();
  };

  const onLogin = async (payload: TelegramLoginPayload) => {
    await webAuth.login(payload);
    setPhase('ready');
  };

  const logout = async () => {
    try {
      await webAuth.logout();
    } catch {
      /* cookie могла остаться — сервер всё равно спросит вход заново */
    }
    accountIdRef.current = null;
    storeAccountId(null);
    setNotice(null);
    setPhase('login');
  };

  const product = PRODUCT_NAMES[APP_ID][locale];
  const header = (
    <header className="flex items-center gap-2 mb-4">
      <div className="flex-1 font-bold">{product}</div>
    </header>
  );

  if (mode === 'web' && phase === 'checking') {
    return (
      <Frame>
        {header}
        {checkError ? (
          <Alert tone="danger" title={dict.common.error}>
            {checkError}
            <div className="mt-2">
              <Button
                variant="outline"
                onClick={() => setCheckTick((n) => n + 1)}
              >
                {dict.common.retry}
              </Button>
            </div>
          </Alert>
        ) : (
          <Spinner label={dict.auth.checking} />
        )}
      </Frame>
    );
  }
  if (mode === 'web' && phase === 'login') {
    return (
      <WebLoginScreen
        dict={dict}
        botUsername={ASSIST_BOT_USERNAME}
        onAuth={onLogin}
        hint={inviteRef.current ? dict.auth.inviteWaiting : undefined}
      />
    );
  }
  if (account.loading && !account.data) {
    return (
      <Frame>
        <Spinner label={dict.common.loading} />
      </Frame>
    );
  }
  if (account.error || !account.data) {
    return (
      <Frame>
        {header}
        <Alert tone="danger" title={dict.common.error}>
          {account.error
            ? errorText(account.error, dict)
            : dict.errors.client.noIdentity}
          <div className="mt-2">
            <Button variant="outline" onClick={account.reload}>
              {dict.common.retry}
            </Button>
          </div>
        </Alert>
      </Frame>
    );
  }

  const kit: KitValue = {
    app: APP_ID,
    locale,
    dict,
    setLocale,
    api,
    account: account.data,
    mode,
    links: {
      botUsername: ASSIST_BOT_USERNAME,
      webUrl: window.location.origin + window.location.pathname,
    },
    reloadAccount: account.reload,
  };

  return (
    <KitContext.Provider value={kit}>
      <Shell
        // Другой кабинет — другие данные: экраны монтируются заново.
        key={account.data.account.id}
        appDict={appDict}
        created={account.data.created}
        notice={notice}
        onSwitchAccount={switchAccount}
        onLogout={mode === 'web' ? logout : undefined}
      />
    </KitContext.Provider>
  );
}

function Frame({ children }: { children: ReactNode }) {
  return <div className="mx-auto max-w-xl px-4 py-4">{children}</div>;
}

const NAV: Array<{
  key: keyof AppDictionary['nav'];
  route: Route;
  icon: typeof Globe;
}> = [
  { key: 'sites', route: { name: 'sites' }, icon: Globe },
  {
    key: 'knowledge',
    route: { name: 'section', section: 'knowledge' },
    icon: BookOpen,
  },
  {
    key: 'widget',
    route: { name: 'section', section: 'widget' },
    icon: LayoutTemplate,
  },
  {
    key: 'dialogs',
    route: { name: 'section', section: 'dialogs' },
    icon: MessagesSquare,
  },
  { key: 'members', route: { name: 'members' }, icon: Users },
];

function navActive(key: string, route: Route): boolean {
  if (key === 'sites') {
    return [
      'home',
      'welcome',
      'sites',
      'site-new',
      'site',
      'host',
      'host-access',
    ].includes(route.name);
  }
  if (key === 'members') {
    return route.name === 'members' || route.name === 'invite';
  }
  if (route.name === 'section') return route.section === key;
  return route.name === key;
}

const isRoot = (route: Route) =>
  route.name === 'home' ||
  route.name === 'sites' ||
  route.name === 'section' ||
  route.name === 'members';

function useTelegramBackButton(route: Route) {
  useEffect(() => {
    const bb = getTelegramWebApp()?.BackButton;
    if (!bb) return;
    const back = () => window.history.back();
    if (isRoot(route)) {
      bb.hide();
      return;
    }
    bb.show();
    bb.onClick(back);
    return () => bb.offClick(back);
  }, [route]);
}

/**
 * Каркас кабинета. В Telegram — как было: узкая колонка и нижняя
 * навигация. В вебе на десктопе (md+) — навигация слева и ограниченная
 * ширина контента, как у админки проекта; на телефоне в браузере — та же
 * нижняя навигация, что в Telegram.
 */
function Shell({
  appDict,
  created,
  notice,
  onSwitchAccount,
  onLogout,
}: {
  appDict: AppDictionary;
  created: boolean;
  notice: Notice | null;
  onSwitchAccount: (id: string) => void;
  onLogout?: () => void;
}) {
  const { mode, dict } = useKit();
  const route = useRoute();
  useTelegramBackButton(route);
  const web = mode !== 'tma';

  const tools = (
    <>
      <AccountSwitcher onSwitch={onSwitchAccount} />
      <LanguageSwitcher />
      {onLogout && (
        <Button
          variant="ghost"
          icon={<LogOut size={16} />}
          onClick={onLogout}
          aria-label={dict.auth.logout}
          className="md:hidden"
        />
      )}
    </>
  );

  const content = (
    <>
      {notice && (
        <div className="mb-4">
          <Alert tone={notice.tone}>{notice.text}</Alert>
        </div>
      )}
      {web && !isRoot(route) && (
        // В браузере нет BackButton Telegram — своя кнопка «Назад».
        <Button
          variant="ghost"
          icon={<ArrowLeft size={16} />}
          onClick={() => window.history.back()}
          className="mb-2 -ml-2"
        >
          {dict.common.back}
        </Button>
      )}
      <Screen route={route} appDict={appDict} created={created} />
    </>
  );

  const bottomNav = (
    <nav
      className={`fixed bottom-0 inset-x-0 border-t border-silver-200 dark:border-silver-800 bg-silver-50/95 dark:bg-silver-950/95 backdrop-blur pb-[env(safe-area-inset-bottom)] ${
        web ? 'md:hidden' : ''
      }`}
    >
      <div className="mx-auto max-w-xl grid grid-cols-5">
        {NAV.map(({ key, route: r, icon: Icon }) => {
          const active = navActive(key, route);
          return (
            <button
              key={key}
              type="button"
              onClick={() => navigate(r)}
              aria-current={active ? 'page' : undefined}
              className={`flex flex-col items-center gap-0.5 py-2 text-[11px] min-h-[52px] ${
                active ? 'text-accent' : 'text-silver-500'
              }`}
            >
              <Icon size={20} />
              {appDict.nav[key]}
            </button>
          );
        })}
      </div>
    </nav>
  );

  if (!web) {
    return (
      <div className="min-h-screen pb-24">
        <Frame>
          <header className="flex items-center gap-2 mb-4">
            <div className="flex-1 font-bold truncate">
              <ProductName />
            </div>
            {tools}
          </header>
          {content}
        </Frame>
        {bottomNav}
      </div>
    );
  }

  return (
    <div className="min-h-screen md:flex">
      <aside className="hidden md:flex md:flex-col w-60 shrink-0 h-screen sticky top-0 border-r border-silver-200 dark:border-silver-800 p-4 gap-1">
        <div className="font-bold text-lg mb-4 px-2">
          <ProductName />
        </div>
        {NAV.map(({ key, route: r, icon: Icon }) => {
          const active = navActive(key, route);
          return (
            <button
              key={key}
              type="button"
              onClick={() => navigate(r)}
              aria-current={active ? 'page' : undefined}
              className={`flex items-center gap-3 rounded-xl px-3 py-2 text-sm text-left ${
                active
                  ? 'bg-accent/10 text-accent font-medium'
                  : 'text-silver-600 dark:text-silver-300 hover:bg-silver-200/60 dark:hover:bg-silver-800/60'
              }`}
            >
              <Icon size={18} />
              {appDict.nav[key]}
            </button>
          );
        })}
        <div className="mt-auto space-y-2">
          {onLogout && (
            <Button
              variant="ghost"
              block
              icon={<LogOut size={16} />}
              onClick={onLogout}
            >
              {dict.auth.logout}
            </Button>
          )}
        </div>
      </aside>
      <main className="flex-1 min-w-0 pb-24 md:pb-8">
        <div className="mx-auto max-w-3xl px-4 py-4 md:py-8">
          <header className="flex flex-wrap items-center gap-2 mb-4">
            <div className="flex-1 font-bold truncate md:invisible">
              <ProductName />
            </div>
            {tools}
          </header>
          {content}
        </div>
      </main>
      {bottomNav}
    </div>
  );
}

function ProductName() {
  // Имя — из brand.ts: продукт ещё не назван (В-1/В-22).
  const { locale } = useKit();
  return <>{PRODUCT_NAMES[APP_ID][locale]}</>;
}

function Home({
  appDict,
  created,
}: {
  appDict: AppDictionary;
  created: boolean;
}) {
  const { api, dict, account } = useKit();
  const sites = useAsync(() => api.listSites(), [api]);
  if (sites.loading) return <Spinner label={dict.common.loading} />;
  // Нет сайтов (новый кабинет) — онбординг; есть (в т.ч. из QA-TMA) —
  // сразу список с отметками «подтверждён до …» (ТЗ §3.1 п.1). Оператору
  // онбординг «Подключить сайт» ни к чему — у него нет такой кнопки.
  if (
    !sites.error &&
    sites.data &&
    sites.data.length === 0 &&
    account.me.role !== 'operator'
  ) {
    return (
      <WelcomeScreen
        t={appDict.welcome}
        created={created}
        onConnect={() => navigate({ name: 'site-new' })}
      />
    );
  }
  return <SitesList />;
}

function SitesList() {
  return (
    <SitesListScreen
      onOpenSite={(siteId) => navigate({ name: 'site', siteId })}
      onAddSite={() => navigate({ name: 'site-new' })}
    />
  );
}

function Screen({
  route,
  appDict,
  created,
}: {
  route: Route;
  appDict: AppDictionary;
  created: boolean;
}) {
  switch (route.name) {
    case 'home':
      return <Home appDict={appDict} created={created} />;
    case 'welcome':
      return (
        <WelcomeScreen
          t={appDict.welcome}
          created={false}
          onConnect={() => navigate({ name: 'site-new' })}
        />
      );
    case 'sites':
      return <SitesList />;
    case 'site-new':
      return (
        <AddSiteScreen
          onCreated={(siteId) => navigate({ name: 'site', siteId }, true)}
          onCancel={() => window.history.back()}
        />
      );
    case 'site':
      return (
        <SiteScreen
          key={route.siteId}
          siteId={route.siteId}
          onOpenHost={(hostId) =>
            navigate({ name: 'host', siteId: route.siteId, hostId })
          }
        />
      );
    case 'host':
      return (
        <HostVerifyScreen
          key={route.hostId}
          siteId={route.siteId}
          hostId={route.hostId}
          onOpenAccess={() =>
            navigate({
              name: 'host-access',
              siteId: route.siteId,
              hostId: route.hostId,
            })
          }
        />
      );
    case 'host-access':
      return <AuthorizationsScreen key={route.hostId} hostId={route.hostId} />;
    case 'members':
      return <MembersScreen onInvite={() => navigate({ name: 'invite' })} />;
    case 'invite':
      return <InviteGate />;
    case 'section':
      return <SectionPlaceholder t={appDict.section} section={route.section} />;
    case 'not-found':
      return <NotFound appDict={appDict} />;
  }
}

/** «Пригласить» — только владельцу (сервер ответил бы 403). */
function InviteGate() {
  const { account, dict } = useKit();
  if (account.me.role !== 'owner') {
    return (
      <Alert tone="warning">{dict.errors.api.ACCOUNT_ROLE_REQUIRED}</Alert>
    );
  }
  return <InviteScreen />;
}

function NotFound({ appDict }: { appDict: AppDictionary }) {
  return (
    <div className="space-y-3">
      <Alert tone="warning">{appDict.notFound}</Alert>
      <Button variant="outline" onClick={() => navigate({ name: 'sites' })}>
        {appDict.toSites}
      </Button>
    </div>
  );
}
