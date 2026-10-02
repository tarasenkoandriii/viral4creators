/**
 * «Ролик снят за логином» — с ЗАКРЫТЫМ отказом (ТЗ помощника §4.3-бис,
 * У-7, §4.11): у черновика обучалки признака `requiresLogin` нет, поэтому
 * его вычисляет генератор, и любое сомнение — «за логином». Такой ролик в
 * режиме «Сайт» посетителям не предлагается никогда (sites-backend ещё раз
 * сверяет хосты шагов со своими подтверждёнными хостами сайта: шаг на
 * неподтверждённом хосте или хостов нет вовсе — тоже «за логином»).
 *
 * Главный признак — липкий `loginUsedAt` черновика (аудит Э6, Д1): его
 * ставит ТОЛЬКО реальный вход (успешный `/login`, живой вход — старт и
 * завершение, ввод в поле пароля/кода, раунд, прочитавший из хранилища Ш2
 * поля входа или чужую/прежнюю сессию, `/undo`, переигравший вход), и не
 * снимает никто — ни крон сроков, ни «одноразово», ни перенос Ш2.
 *
 * На что НЕ опираемся (до Д1 опирались, и любой реальный ролик был «за
 * логином»): `secretsUsedAt` (ставится КАЖДЫМ раундом), `cookiesEnc` и
 * ссылки хранилища `siteTestAccountId`/`userSiteSessionId` (куки первой
 * стороны пишутся каждым раундом и на публичных страницах — аналитика,
 * корзина, язык). Куки, полученные ПОСЛЕ входа, — уже под флагом.
 *
 * Черновики до флага: миграция `20270120100000_client_site_video_link`
 * ставит `loginUsedAt` ВСЕМ существующим строкам — для них уверенности нет
 * (вход через `/step` в поле с безобидным селектором и стёртые кроном куки
 * следов не оставляют).
 *
 * Чистый модуль: строка черновика — только чтение. Поля данных входа здесь
 * лишь проверяются на пустоту — ни расшифровки, ни чтения значений.
 */

export interface DraftLoginFacts {
  baseUrl: string;
  lastUrl?: string | null;
  steps?: unknown;
  /** Липкий признак реального входа (см. шапку). */
  loginUsedAt?: Date | null;
  credentialsEnc?: string | null;
  requiresLiveLoginReplay?: boolean | null;
  storeHasCredentials?: boolean | null;
}

const PASSWORDISH = /pass|парол|pwd|otp|2fa|code|token/i;

/** Хосты всех адресов, по которым ходил сценарий (нижний регистр). */
export function draftStepHosts(d: DraftLoginFacts): string[] {
  const urls: string[] = [d.baseUrl];
  if (d.lastUrl) urls.push(d.lastUrl);
  if (Array.isArray(d.steps)) {
    for (const s of d.steps) {
      if (s && typeof s === 'object') {
        const o = s as Record<string, unknown>;
        for (const k of ['route', 'url']) {
          if (typeof o[k] === 'string') urls.push(o[k] as string);
        }
      }
    }
  }
  const hosts = new Set<string>();
  for (const u of urls) {
    try {
      const parsed = new URL(u);
      if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
        hosts.add(parsed.hostname.toLowerCase());
      }
    } catch {
      /* не адрес (маршрут продукта) — хоста нет */
    }
  }
  return [...hosts];
}

/** Селектор поля, похожего на пароль/код (эвристика по имени). */
export function isSensitiveSelector(selector: string): boolean {
  return PASSWORDISH.test(selector);
}

/**
 * Шаги сценария выдают вход: `fill` с пустым значением — секретное поле
 * `/login` (значение живёт только в данных входа; без значения вовсе —
 * сомнение), `fill` в поле, похожее
 * на пароль/код, маркер живого входа обрабатывает `requiresLiveLoginReplay`.
 */
export function stepsShowLogin(steps: unknown): boolean {
  if (!Array.isArray(steps)) return false;
  return steps.some((s) => {
    if (!s || typeof s !== 'object') return false;
    const o = s as Record<string, unknown>;
    return (
      o.kind === 'fill' &&
      (typeof o.value !== 'string' ||
        o.value === '' ||
        (typeof o.selector === 'string' && isSensitiveSelector(o.selector)))
    );
  });
}

/**
 * `true` — ролик считается снятым за логином: был реальный вход (липкий
 * `loginUsedAt`), сохранены поля входа (колонка или хранилище), живой
 * вход, шаг ввода секретного поля или поля, похожего на пароль/код, или
 * шагов нет вовсе / они непонятны (черновик старой версии — сомнение).
 */
export function draftRequiresLogin(d: DraftLoginFacts): boolean {
  if (
    d.loginUsedAt ||
    d.credentialsEnc ||
    d.requiresLiveLoginReplay ||
    d.storeHasCredentials
  ) {
    return true;
  }
  if (!Array.isArray(d.steps) || d.steps.length === 0) return true;
  for (const s of d.steps) {
    if (!s || typeof s !== 'object') return true;
    const o = s as Record<string, unknown>;
    if (typeof o.kind !== 'string') return true;
  }
  return stepsShowLogin(d.steps);
}
