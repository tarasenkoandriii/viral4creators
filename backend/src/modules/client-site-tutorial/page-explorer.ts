/**
 * Граница между оркестрацией визарда и работой с реальным браузером —
 * §5.1 ТЗ (doc/CLIENT-SITE-TUTORIAL-SPEC.md), этап 111.
 *
 * ## Почему интерфейс, а не прямой вызов puppeteer из сервиса
 *
 * Всё, что делает сервис визарда — проверки владения, лимиты, версии,
 * арифметика раундов, шифрование кук — не требует браузера и обязано
 * быть покрыто тестами без него (в CI этого проекта Chromium не
 * запускается, см. `doc/CI.md`). Ровно тот же приём уже применён в
 * `live-login-relay` (`RelayBrowser`/`RelayPage`) и в
 * `tutorial-runner/scenario-runner.ts`.
 *
 * ## Что делает реализация (этап 112)
 *
 * Один вызов = один полный раунд по модели §5.1: свежий
 * `launchHeadlessBrowser()` → восстановить `cookies` (`common/cookie-jar.ts`)
 * → `page.goto(url)` → выполнить переданные действия → снять
 * `PageExploration` → вернуть новый cookie jar → ЗАКРЫТЬ браузер. Держать
 * его открытым между HTTP-запросами на serverless-функции нельзя
 * архитектурно — отсюда и «каждый раунд начинается с нуля».
 */

import { CdpCookie } from '../../common/cookie-jar';
import { ScenarioStep } from '../tutorial-scenario/scenario-steps.types';
import type { LoginFieldPick, LoginFieldsFound } from './login-form-detect';
import { PageExploration } from './page-exploration.types';

/** Действие внутри раунда — подмножество `ScenarioStep`, которое реально
 * выполняется в браузере (`goto` задаётся отдельным полем запроса, а
 * `assertVisible`/`waitFor` визард не выполняет — они дописываются в
 * сценарий как маркеры для будущей пересборки). */
export type RoundAction =
  | { kind: 'fill'; selector: string; value: string }
  | { kind: 'click'; selector: string };

export interface ExploreRoundRequest {
  /** Куда идти перед выполнением действий. */
  url: string;
  /** Куки предыдущего раунда — укладываются ДО `goto` (§5.1). */
  cookies: CdpCookie[];
  /** Ноль или больше `fill` и не более одного `click` (§5.2). */
  actions: RoundAction[];
  /** Origin черновика — реализация обязана перепроверить домен ПОСЛЕ
   * каждого перехода (§8.1/§8.2: редирект мог увести куда угодно). */
  allowedOrigin: string;
  /**
   * Ш2-хвост (3): вход учёткой из реестра сайта. Поля формы реализация
   * находит САМА на открытой странице (`findLoginFields`), пароль вводит
   * ТОЛЬКО в настоящее поле пароля (иначе — отказ «не нашли поля входа»),
   * затем нажимает кнопку. `actions` при этом пусты.
   */
  autoLogin?: AutoLoginRequest;
  /**
   * Ш3-хвост (3): кто ведёт черновик. Нужен браузерному воркеру — лимиты
   * «на человека» и кадры режима A (`/internal/sites/tutorial/frames/*`
   * проверяет кабинет по telegramId). Нет — воркер считает лимиты по сайту
   * черновика, кадры режима A снимает функция, как раньше.
   */
  requester?: ExploreRequester;
}

export interface ExploreRequester {
  /** Telegram-id пользователя генератора (числом в строке). */
  telegramId: string;
}

export interface AutoLoginRequest {
  /** Логин учётки (метаданные реестра); `null` — у учётки его нет. */
  username: string | null;
  /** Пароль из аренды — только в память раунда. */
  password: string;
  /** Поля, указанные человеком (запасной путь), — проверяются, не угадываются. */
  pick?: LoginFieldPick;
  /**
   * Ш3-хвост (3): учётка реестра, из которой взят пароль. Есть — раунд входа
   * может уйти на браузерный воркер: пароль туда НЕ передаётся (воркер берёт
   * его своей арендой Ш2 `tutorial-login`), `password` здесь — для раунда в
   * функции. Нет — вход идёт в функции, как раньше.
   */
  registry?: { telegramId: string; testAccountId: string };
}

export interface ExploreRoundResult {
  exploration: PageExploration;
  /** Cookie jar на момент конца раунда — вызывающий шифрует и кладёт в
   * `draft.cookiesEnc`. */
  cookies: CdpCookie[];
  /**
   * Раунд вводил в поле пароля или кода (`type=password`, `autocomplete`
   * пароля/одноразового кода) — это вход: вызывающий ставит черновику
   * липкий `loginUsedAt` (аудит Э6, Д1). `undefined` — реализация без
   * проверки (тесты оркестрации), читается как «нет».
   */
  sensitiveFill?: boolean;
  /** Ш2-хвост (3): какие поля нашлись и заполнены при `autoLogin`. */
  autoLogin?: LoginFieldsFound;
}

/**
 * Полная переигровка сценария с нуля — то, чем устроен `/undo` (§5.2,
 * §14 п.6 ТЗ), и в будущем пересборка ролика (§7.3).
 *
 * Это АРХИТЕКТУРНО ДРУГОЙ путь, чем `runRound`, а не его частный
 * случай: куки версионируются только как «последний снятый слепок», по
 * шагам их истории нет — значит восстановить состояние «на раунд
 * раньше» нечем, только пройти оставшиеся шаги заново от первого
 * `goto`. ТЗ принимает эту цену явно: `/undo` редкий и не обязан быть
 * таким же дешёвым, как обычный раунд.
 */
export interface ReplayRequest {
  /** Оставшийся сценарий целиком, начиная с `goto` на исходную
   * страницу. Cookie jar НЕ восстанавливается: сессия заново
   * зарабатывается самими шагами входа. */
  steps: ScenarioStep[];
  /**
   * Значения секретных полей по селектору (§7.3): в `steps` они пустые
   * — пароль не хранится в сценарии, который видит оператор, — и
   * подставляются только здесь, в момент реального проигрывания.
   */
  secrets: Record<string, string>;
  /**
   * Ш2-хвост (3): селекторы, чьё значение — пароль учётки реестра. Перед
   * вводом реализация проверяет, что это настоящее поле пароля (страница
   * могла поменяться за недели): иначе — отказ, а не пароль в кадре.
   */
  passwordOnly?: string[];
  allowedOrigin: string;
  /** Ш3-хвост (3): кто ведёт черновик (режим сайта для воркера). */
  requester?: ExploreRequester;
}

/**
 * Токен внедрения. Строка, а не класс — реализация появится в другом
 * модуле (браузерном) и не должна быть импортирована сюда, иначе
 * оркестрация снова потянет за собой puppeteer в тесты.
 */
export const PAGE_EXPLORER = 'CLIENT_SITE_TUTORIAL_PAGE_EXPLORER';

export interface PageExplorer {
  runRound(request: ExploreRoundRequest): Promise<ExploreRoundResult>;
  replay(request: ReplayRequest): Promise<ExploreRoundResult>;
}

/**
 * Ш3-хвост (3), выключатели генератора (умолчание — выкл.: Chromium в
 * функции, как до воркера):
 *  - `TUTORIAL_EXPLORER_VIA_WORKER` — раунды исследователя без ввода руками
 *    (переход, клик, вход учёткой реестра) — на браузерном воркере;
 *  - `TUTORIAL_FRAMES_VIA_WORKER` — съёмочный кадр раунда «открыть
 *    страницу» в режиме A — заданием кадров воркера.
 * Любой отказ ДО исполнения (409 `BROWSER_WORKER_DISABLED`, режим, лимит,
 * сеть) — откат на функцию.
 */
export function flagOn(env: NodeJS.ProcessEnv, name: string): boolean {
  const v = (env[name] ?? '').trim().toLowerCase();
  return v === 'true' || v === '1' || v === 'on';
}

export const EXPLORER_VIA_WORKER_ENV = 'TUTORIAL_EXPLORER_VIA_WORKER';
export const FRAMES_VIA_WORKER_ENV = 'TUTORIAL_FRAMES_VIA_WORKER';
