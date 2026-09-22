/**
 * Доменная арифметика черновика обучалки по сайту заказчика — чистые
 * функции, без Prisma и без браузера (doc/CLIENT-SITE-TUTORIAL-SPEC.md
 * §5.2, §6.1, §8.1, §9; этап 111).
 *
 * Вынесено отдельным файлом по той же причине, что `scenario-steps.ts`/
 * `scenario-cost.ts` в соседнем `tutorial-scenario`: всё, что здесь
 * живёт, можно прогнать тестами без БД, без сети и без Chromium — а
 * именно здесь и сосредоточена та логика, в которой реально можно
 * ошибиться.
 *
 * ## Раунд ≠ шаг — центральное различие всего модуля
 *
 * «Раунд» — это один HTTP-вызов визарда и РОВНО один новый кадр
 * предпросмотра. «Шаг» — один элемент `steps[]` (`ScenarioStep`). Один
 * раунд может дописать НЕСКОЛЬКО шагов: `/step` с формой из трёх полей и
 * кнопкой — это 4 шага за раунд, а кадр всё равно один. Отсюда
 * `stepsPerRound: Int[]`, длина которого совпадает с длиной
 * `roundScreenshots`, но НЕ со `steps` (§15 п.3 ТЗ). Путаница этих двух
 * единиц — ровно тот баг, который аудит ТЗ уже ловил: «снять последний
 * элемент массива» при отмене отрезало бы только `click`, оставив
 * осиротевшие `fill` без пары.
 */

import { getDomain } from 'tldts';
import {
  MAX_SCENARIO_STEPS,
  ScenarioStep,
} from '../tutorial-scenario/scenario-steps.types';

/** Потолок шагов в одном черновике. §9 ТЗ разрешает либо то же число,
 * что у сценариев нашего продукта, либо свою константу — берём то же и
 * ссылаемся на исходную, чтобы два потолка не разъезжались молча. Он же
 * ограничивает рост `roundScreenshots`: раундов физически не может быть
 * больше, чем шагов (каждый раунд добавляет хотя бы один шаг). */
export const MAX_DRAFT_STEPS = MAX_SCENARIO_STEPS;

export class DraftStepLimitError extends Error {}
export class DraftRoundMismatchError extends Error {}

/** Минимум полей черновика, нужный этим функциям — не вся строка Prisma:
 * так их можно звать и из сервиса, и из тестов, не собирая фиктивную
 * запись БД целиком. */
export interface DraftRoundsState {
  steps: ScenarioStep[];
  stepsPerRound: number[];
  roundScreenshots: string[];
  requiresLiveLoginReplay: boolean;
}

export interface AppendRoundInput {
  /** Шаги, которые дописал ЭТОТ раунд (может быть несколько). */
  steps: ScenarioStep[];
  /** Кадр этого раунда — ровно один, независимо от числа шагов. */
  screenshot: string;
  /** Раунд завершения live-сессии входа (§7.4.5) — помечает весь
   * черновик как непересобираемый автоматически. */
  live?: boolean;
}

/**
 * Дописывает раунд: шаги — в хвост `steps`, их ЧИСЛО — в хвост
 * `stepsPerRound`, кадр — в хвост `roundScreenshots`. Три массива после
 * этого остаются согласованными по построению, а не по дисциплине
 * вызывающего.
 *
 * Пустой раунд (ноль шагов) запрещён: он дал бы кадр без единого
 * действия, то есть `/undo` потом снял бы «ничего» и предпросмотр
 * разъехался бы с шагами. Такой вызов — это баг вызывающего, не
 * пользовательский сценарий.
 */
export function appendRound(
  state: DraftRoundsState,
  round: AppendRoundInput,
): DraftRoundsState {
  if (round.steps.length === 0) {
    throw new DraftRoundMismatchError(
      'раунд обязан добавить хотя бы один шаг — иначе кадр предпросмотра не на что отменять',
    );
  }
  const steps = [...state.steps, ...round.steps];
  if (steps.length > MAX_DRAFT_STEPS) {
    throw new DraftStepLimitError(
      `в черновике не может быть больше ${MAX_DRAFT_STEPS} шагов (получилось бы ${steps.length}) — завершите сценарий или начните новый`,
    );
  }
  return {
    steps,
    stepsPerRound: [...state.stepsPerRound, round.steps.length],
    roundScreenshots: [...state.roundScreenshots, round.screenshot],
    requiresLiveLoginReplay:
      state.requiresLiveLoginReplay || round.live === true,
  };
}

export class UndoNotPossibleError extends Error {}

/**
 * Снимает ПОСЛЕДНИЙ РАУНД (§5.2 `/undo`), а не последний шаг: из хвоста
 * `steps` уходит `stepsPerRound.at(-1)` элементов.
 *
 * Отмена раунда живого входа запрещена (§7.4.5/§7.4.1): переиграть
 * капчу или 2FA с нуля невозможно по определению, а `/undo` устроен
 * именно как «переиграть оставшееся заново с первого шага». Формально
 * запрет нужен только когда live-раундом был ПОСЛЕДНИЙ раунд — более
 * ранний live-раунд остаётся нетронутым и переигрывать его не придётся:
 * `cookiesEnc` уже содержит добытую им сессию.
 *
 * Возвращает и новое состояние, и число снятых шагов — вызывающему оно
 * нужно, чтобы понять, сколько шагов переигрывать в браузере.
 */
export function undoLastRound(
  state: DraftRoundsState,
  opts: { lastRoundWasLive: boolean },
): { next: DraftRoundsState; removedSteps: number } {
  if (state.stepsPerRound.length === 0) {
    throw new UndoNotPossibleError('в черновике нет ни одного раунда');
  }
  if (state.stepsPerRound.length === 1) {
    throw new UndoNotPossibleError(
      'нельзя отменить первый раунд — он задаёт исходную страницу; удалите черновик и начните заново',
    );
  }
  if (opts.lastRoundWasLive) {
    throw new UndoNotPossibleError(
      'нельзя отменить шаг живого входа — удалите черновик и начните заново, либо продолжайте после него',
    );
  }
  const removedSteps = state.stepsPerRound[state.stepsPerRound.length - 1];
  if (removedSteps > state.steps.length) {
    throw new DraftRoundMismatchError(
      `черновик рассогласован: последний раунд заявляет ${removedSteps} шагов, а всего шагов ${state.steps.length}`,
    );
  }
  return {
    removedSteps,
    next: {
      steps: state.steps.slice(0, state.steps.length - removedSteps),
      stepsPerRound: state.stepsPerRound.slice(0, -1),
      roundScreenshots: state.roundScreenshots.slice(0, -1),
      // Флаг НЕ сбрасывается: если live-раунд был раньше в сценарии, он
      // там и остался (отменить можно только последний раунд, а
      // последним live-раунд быть не мог — см. проверку выше).
      requiresLiveLoginReplay: state.requiresLiveLoginReplay,
    },
  };
}

/**
 * Свежий кадр прогона ЗАМЕЩАЕТ последний, а не дополняет (§5.2 `/undo`):
 * после отмены предпросмотр обязан показывать актуальное состояние
 * страницы, а не кадр, снятый при первом проходе через неё.
 */
export function replaceLastScreenshot(
  state: DraftRoundsState,
  screenshot: string,
): DraftRoundsState {
  if (state.roundScreenshots.length === 0) {
    throw new DraftRoundMismatchError('нет ни одного кадра для замены');
  }
  return {
    ...state,
    roundScreenshots: [...state.roundScreenshots.slice(0, -1), screenshot],
  };
}

/** Три массива черновика обязаны быть согласованы. Используется как
 * защита от строки, записанной другой (в том числе будущей) версией
 * кода, — тот же принцип, что у разбора cookie jar: данные из БД не
 * считаются заведомо корректными. */
export function assertRoundsConsistent(state: DraftRoundsState): void {
  if (state.stepsPerRound.length !== state.roundScreenshots.length) {
    throw new DraftRoundMismatchError(
      `раундов ${state.stepsPerRound.length}, кадров ${state.roundScreenshots.length} — должно совпадать`,
    );
  }
  const declared = state.stepsPerRound.reduce((sum, n) => sum + n, 0);
  if (declared !== state.steps.length) {
    throw new DraftRoundMismatchError(
      `сумма stepsPerRound = ${declared}, а шагов ${state.steps.length} — должно совпадать`,
    );
  }
}

export class DomainLockError extends Error {}

/**
 * Регистрируемый домен (eTLD+1) хоста, или `null`, если такого понятия
 * у него нет — IP-адрес, `localhost`, внутреннее имя без точки.
 *
 * `allowPrivateDomains: true` — не формальность, а суть замка. С
 * умолчанием (только ICANN-часть списка) `alice.github.io` и
 * `bob.github.io` имеют ОДИН регистрируемый домен `github.io`, то есть
 * замок пускал бы запись с сайта одного человека на сайт другого. С
 * приватной частью списка каждый из них — свой домен. То же самое для
 * `*.myshopify.com`, `*.vercel.app` и остальных платформ, где у каждого
 * клиента свой поддомен: именно такие адреса и бывают «сайтом
 * заказчика».
 */
function registrableDomain(hostname: string): string | null {
  return getDomain(hostname, { allowPrivateDomains: true });
}

/**
 * Доменный замок §8.1: КАЖДЫЙ переход внутри черновика обязан остаться
 * на сайте заказчика — том, что зафиксирован первым `/explore`.
 *
 * Что считается «тем же сайтом» — и почему это изменилось. До находки
 * Т-4 аудита `docs-tz/AUDIT-Client-Site-Tutorial-Landing.md` сравнение
 * было точным по origin (схема+хост+порт). §8.1 спеки прямо называло
 * это временным решением MVP и предупреждало, чем оно обернётся:
 * реальный путь клиента почти всегда пересекает поддомены одного
 * бизнеса — `shop.` → `checkout.` → `accounts.`, — и запись обрывалась
 * посреди обычного сценария. Для SaaS это не краевой случай, а норма:
 * вход обычно и живёт на отдельном поддомене. То есть самая частая
 * обучалка — «как войти и сделать X» — упиралась в отказ на втором
 * шаге.
 *
 * Теперь сравнивается регистрируемый домен, и строго по списку
 * публичных суффиксов, а не по хвосту строки. Наивное сравнение
 * хвостом — это ровно та ошибка, от которой §8.1 предостерегало
 * отдельной фразой: `evil-example.com` заканчивается на `example.com`,
 * и «похожий домен» пустил бы запись на чужой сайт.
 *
 * Схема и порт по-прежнему обязаны совпадать. Регистрируемый домен —
 * это про «чей это сайт», а не про «как мы к нему идём»: переход
 * `https://` → `http://` на том же домене остаётся понижением
 * защищённости и в обычном клиентском пути не встречается, а другой
 * порт — это, как правило, вообще другой сервис на той же машине.
 *
 * Хост без регистрируемого домена (IP, `localhost`, имя без точки)
 * сравнивается точно, как раньше. Такие адреса до сюда доходить не
 * должны вовсе — их отсекает SSRF-проверка (§8.2), — но замок не
 * вправе на это полагаться: две проверки отвечают на разные вопросы и
 * обязаны быть верны каждая сама по себе.
 *
 * Это НЕ то же самое, что SSRF-проверка (`assertPubliclyRoutableUrl`,
 * §8.2): та отвечает на вопрос «этот адрес вообще можно открывать с
 * нашего сервера», а эта — «мы всё ещё на сайте заказчика». Обе
 * обязательны и обе вызываются после КАЖДОГО перехода, потому что
 * страница могла увести редиректом.
 */
export function assertSameSite(baseUrl: string, candidate: string): void {
  let base: URL;
  let target: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    throw new DomainLockError(`некорректный baseUrl черновика: ${baseUrl}`);
  }
  try {
    target = new URL(candidate);
  } catch {
    throw new DomainLockError(`некорректный адрес перехода: ${candidate}`);
  }

  if (base.protocol !== target.protocol || base.port !== target.port) {
    throw new DomainLockError(
      `переход за пределы сайта заказчика запрещён: ожидался ${base.origin}, получен ${target.origin}`,
    );
  }

  const baseDomain = registrableDomain(base.hostname);
  const targetDomain = registrableDomain(target.hostname);
  const same =
    baseDomain === null || targetDomain === null
      ? base.hostname === target.hostname
      : baseDomain === targetDomain;

  if (!same) {
    throw new DomainLockError(
      `переход за пределы сайта заказчика запрещён: ожидался ${
        baseDomain ?? base.hostname
      }, получен ${targetDomain ?? target.hostname}`,
    );
  }
}

/** Статусы черновика — копия enum'а Prisma, чтобы доменные функции не
 * тянули за собой сгенерированный клиент (тот же приём, что
 * `common/types/session.types.ts` для `SessionStatus`). */
export type DraftStatus =
  | 'DRAFTING'
  | 'PENDING_REVIEW'
  | 'APPROVED'
  | 'REJECTED';

export class DraftStatusError extends Error {}

/**
 * Редактировать можно только черновик в `DRAFTING` (§5.2, находка аудита
 * §14 п.2): без этой проверки правки, сделанные после `/finish`, тихо
 * расходятся с тем, что видел и одобрял оператор.
 */
export function assertEditable(status: DraftStatus): void {
  if (status !== 'DRAFTING') {
    throw new DraftStatusError(
      status === 'PENDING_REVIEW'
        ? 'черновик уже отправлен на проверку — дождитесь решения оператора'
        : status === 'APPROVED'
          ? 'черновик уже одобрен и передан в сборку — редактировать его нельзя'
          : 'черновик отклонён оператором — верните его в работу, прежде чем продолжать',
    );
  }
}
