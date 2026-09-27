/**
 * Съёмка всех четырёх кадров секции «Как это выглядит» одним вызовом
 * (этап I, `doc/TUTORIAL-FRAMES-CAPTURE.md`).
 *
 * ## Что здесь автоматизировано и почему это стало возможно только сейчас
 *
 * Две карточки из четырёх — МГНОВЕННЫЕ состояния браузера: «ссылка
 * вставлена, но не отправлена» и «поле заполнено». В базе их нет, и
 * прогон, который просто открывает маршрут, снимал вместо них пустую
 * форму. Из этого в редакции документа от 26.09.2026 был сделан вывод
 * «нужны руки человека на всех четырёх», и он оказался неверен: такие
 * состояния снимаются действиями на уже открытом экране, а кадр
 * берётся МЕЖДУ действиями. Как только операторский прогон научился
 * `steps` (27.09.2026), руки перестали быть нужны.
 *
 * ## Почему это отдельный сервис, а не «оператор шлёт steps руками»
 *
 * Знание «первый кадр — карточка 1, третий — карточка 2, четвёртый —
 * карточка 3, а карточка 4 снимается вторым прогоном по другому
 * маршруту» жило в таблице внутри документа. Такое знание живёт в
 * документе ровно до первой правки сценария, после чего документ
 * начинает врать, и узнают об этом по кадру не с той карточки на
 * продающей странице. Здесь оно в коде и покрыто тестами.
 *
 * Плюс сброс черновика. Без него второй прогон подряд снимает вместо
 * пустой формы стадию `page` — то есть карточка 1 у второй локали
 * молча выйдет не той. Забыть об этом руками очень легко: первый раз
 * всё получается.
 *
 * ## Где автоматизация ЗАКАНЧИВАЕТСЯ, и это не недоделка
 *
 * Отбор по §4 остаётся человеку. Машина проверяет ровно две вещи, и
 * обе — утверждениями самого сценария, то есть роняя прогон, а не
 * пропуская кадр:
 *
 * - экран дошёл до нужной стадии, а не висит спиннером и не отдал
 *   ошибку (`assertVisible` на `#site-url` перед вводом и `waitFor`
 *   кадра страницы после клика);
 * - в поле напечатан НАШ адрес (§9 ТЗ), а не чужой — это видно по
 *   самому шагу.
 *
 * Чего машина НЕ проверяет, вопреки тому, что говорила первая
 * редакция этого доккомментария: локаль (утверждение о тексте
 * потребовало бы хранить здесь по слову на язык — список, который
 * разъедется со словарями на первой же правке), содержимое ролика
 * («чужой бренд») и общий вид. Это и есть §4, и он глазами.
 *
 * Отдельно: кадры снимаются с `unmasked: true` — иначе не видно
 * главного, кадра сайта. Значит маскирование `[data-qa-mask]` НЕ
 * работает, и зоны с именем фикстурного пользователя в кадре открыты.
 * Проверять их — тоже §4, и об этом сказано там прямо.
 *
 * И последний шаг — файлы в `landing/public/illustrations/` плюс
 * локаль в `REAL_FRAME_LOCALES` — это коммит в репозиторий. Сервер
 * коммитить не может и не должен: git здесь и есть тот самый рубеж, на
 * котором плохой кадр останавливают.
 */

import { Injectable, Logger } from '@nestjs/common';
import { ClientSiteTutorialService } from '../client-site-tutorial/client-site-tutorial.service';
import type { ScenarioStep } from '../tutorial-scenario/scenario-steps.types';
import {
  UiSnapshotRunnerService,
  type SnapshotTheme,
} from './ui-snapshot-runner.service';

/** Сайт в кадре — только наш собственный (§9 ТЗ, решение владельца). */
export const DEFAULT_CAPTURE_SITE_URL = 'https://viral4creators.app';

/** Что печатаем в первое найденное поле для карточки 3. Ничего личного
 *  и ничего чужого: адрес нашего же домена. */
export const DEFAULT_CAPTURE_FIELD_VALUE = 'demo@viral4creators.app';

/**
 * Шаги съёмки карточек 1–3. Кадр снимается после КАЖДОГО, поэтому
 * порядок здесь — это и есть порядок кадров.
 *
 * Селекторы — собственные якоря продукта (`#site-url`, `#f-0`) и
 * `data-qa` у кнопки. По тексту искать нельзя: кадры снимаются в
 * нескольких локалях, и текстовый селектор нашёл бы кнопку в одной.
 */
export function captureSteps(
  siteUrl: string,
  fieldValue: string,
): ScenarioStep[] {
  return [
    // Кадр 1 → ничей. Шаг проверочный: мастер дошёл до стадии `url`,
    // а не висит спиннером и не отдал ошибку. Без него первый же
    // `fill` падал бы с невнятным «локатор не нашёлся», а главное —
    // проверять «экран рабочий» было бы нечем, хотя §4 этого требует.
    { kind: 'assertVisible', selector: '#site-url' },
    // Кадр 2 → карточка 1: ссылка вставлена, кнопка ожила.
    { kind: 'fill', selector: '#site-url', value: siteUrl },
    // Кадр 3 → ничей: страница ещё грузится.
    { kind: 'click', selector: '[data-qa="client-site-explore"]' },
    // Кадр 4 → карточка 2: пришёл настоящий экран сайта.
    { kind: 'waitFor', selector: '[data-qa-mask="client-site-frame"]' },
    // Кадр 5 → карточка 3: поле заполнено.
    { kind: 'fill', selector: '#f-0', value: fieldValue },
  ];
}

/**
 * Кадр ПОСЛЕ КАКОГО ШАГА идёт на какую карточку. Кадр после второго
 * шага (сразу после клика, страница ещё грузится) не нужен никому — и
 * это не пропуск, а причина, по которой таблица вообще существует.
 *
 * Ключ — номер шага (0-based, как в `captureSteps` выше), а не
 * позиция в массиве кадров: правка аудита этапа A. Скриншот шага
 * может не сняться (best-effort), и поиск по позиции тогда молча
 * брал бы кадр соседнего шага — карточка лендинга выглядела бы
 * снятой, но показывала бы не тот экран.
 */
const CARD_BY_STEP_INDEX: ReadonlyMap<number, number> = new Map([
  [1, 1],
  [3, 2],
  [4, 3],
]);

export interface CapturedLocale {
  locale: string;
  /** Адреса кадров по номеру карточки (1–4). Неполный набор — смотрите
   *  `problems`: прогон не бросает, чтобы годные кадры не пропали. */
  cards: Record<number, string>;
  problems: string[];
}

export interface CaptureResult {
  skipped?: string;
  locales: CapturedLocale[];
}

@Injectable()
export class TutorialFramesCaptureService {
  private readonly logger = new Logger(TutorialFramesCaptureService.name);

  constructor(
    private readonly runner: UiSnapshotRunnerService,
    private readonly tutorial: ClientSiteTutorialService,
  ) {}

  async capture(options: {
    locales: readonly string[];
    theme?: SnapshotTheme;
    siteUrl?: string;
    fieldValue?: string;
  }): Promise<CaptureResult> {
    const theme: SnapshotTheme = options.theme ?? 'dark';
    const siteUrl = options.siteUrl?.trim() || DEFAULT_CAPTURE_SITE_URL;
    const fieldValue =
      options.fieldValue?.trim() || DEFAULT_CAPTURE_FIELD_VALUE;

    const user = await this.runner.findFixtureUser();
    if (!user) {
      return { skipped: 'фикстурный вход не настроен', locales: [] };
    }
    const ctx = await this.runner.resolveFixtureContext(user.id);
    const clientSiteProjectId = ctx.clientSiteProjectId;
    if (!clientSiteProjectId) {
      return {
        skipped: 'у фикстуры нет проекта типа «сайт заказчика»',
        locales: [],
      };
    }

    const locales: CapturedLocale[] = [];
    for (const locale of options.locales) {
      locales.push(
        await this.captureLocale({
          locale,
          theme,
          siteUrl,
          fieldValue,
          userId: user.id,
          clientSiteProjectId,
        }),
      );
    }
    return { locales };
  }

  private async captureLocale(arg: {
    locale: string;
    theme: SnapshotTheme;
    siteUrl: string;
    fieldValue: string;
    userId: string;
    clientSiteProjectId: string;
  }): Promise<CapturedLocale> {
    const cards: Record<number, string> = {};
    const problems: string[] = [];

    // Сброс ПЕРЕД каждой локалью, а не один раз на весь прогон: после
    // первой локали черновик остался, и без сброса вторая сняла бы
    // вместо пустой формы стадию `page` — карточка 1 вышла бы не той,
    // и молча.
    try {
      await this.tutorial.remove(arg.userId, arg.clientSiteProjectId);
    } catch (e) {
      // Не смогли сбросить — снимать смысла нет: кадр карточки 1
      // гарантированно будет не тот, а «почти правильный» кадр хуже
      // отсутствующего, потому что его пропустят глазами.
      const message = e instanceof Error ? e.message : String(e);
      return {
        locale: arg.locale,
        cards,
        problems: [`черновик не сброшен (${message}) — прогон не начат`],
      };
    }

    const wizard = await this.runner.run({
      routeKeys: ['site-tutorial'],
      locale: arg.locale,
      theme: arg.theme,
      unmasked: true,
      deviceScaleFactor: 2,
      steps: captureSteps(arg.siteUrl, arg.fieldValue),
      alerts: false,
    });
    const outcome = wizard.outcomes[0];
    const byStep = new Map(
      (outcome?.shots ?? []).map((shot) => [shot.stepIndex, shot.url]),
    );
    for (const [stepIndex, card] of CARD_BY_STEP_INDEX) {
      const url = byStep.get(stepIndex);
      if (url) cards[card] = url;
    }
    if (wizard.skipped) problems.push(wizard.skipped);
    if (outcome?.error) {
      problems.push(
        `мастер: ${outcome.error} (выполнено шагов: ${outcome.stepsDone ?? 0})`,
      );
    }

    // Карточка 4 — отдельным прогоном и без шагов: готовый ролик это
    // состояние из базы, доводить экран нечем.
    const video = await this.runner.run({
      routeKeys: ['postprod-video'],
      locale: arg.locale,
      theme: arg.theme,
      unmasked: true,
      deviceScaleFactor: 2,
      alerts: false,
    });
    const videoOutcome = video.outcomes[0];
    if (videoOutcome?.blobUrl) cards[4] = videoOutcome.blobUrl;
    if (video.skipped) problems.push(video.skipped);
    if (videoOutcome?.error)
      problems.push(`готовый ролик: ${videoOutcome.error}`);

    const missing = [1, 2, 3, 4].filter((n) => !cards[n]);
    if (missing.length > 0) {
      problems.push(`не сняты карточки: ${missing.join(', ')}`);
    }
    this.logger.log(
      `кадры обучалки (${arg.locale}): снято ${4 - missing.length} из 4` +
        (problems.length > 0 ? `; ${problems.join('; ')}` : ''),
    );
    return { locale: arg.locale, cards, problems };
  }
}
