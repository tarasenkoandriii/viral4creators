/**
 * TutorialScenarioGeneratorService — крон-воркер `tutorial-scenario-
 * generate` (doc/TMA-UI-SNAPSHOT-AND-TUTORIAL-VIDEO-SPEC.md §4.10,
 * этап 94). Вызывается `CronJobsService.runTutorialScenarioGenerate()`,
 * тем же способом, что и остальные воркеры этого модуля семейства
 * (`ExportService.runSyncTick`, `CatalogBatchWorkerService.runBatch` и
 * т.п.) — прогон делает вся эта логика, `CronJobsService` только
 * оборачивает джоб-локом и передаёт результат в `runAndLog`.
 *
 * ## Объём
 *
 * Только 10 шагов обучалки (`ASSISTANT_STEPS`, subjectKey '1'..'10').
 * Свободные ключи воркфлоу за пределами обучалки
 * (`postprod-revoice` и подобные, §4.4) — по-прежнему отдельный, более
 * поздний шаг.
 *
 * **Локали — уже не одна.** С этапа C ТЗ
 * `docs-tz/TZ-Tutorial-Video-Voiced.md` список языков приходит
 * настройкой `tutorial.scenarioLocales` (по умолчанию `['ru']`, то
 * есть прежнее поведение), и прогон обходит пары (шаг × локаль).
 * Прежняя оговорка «только локаль `ru` — расширение отдельный, более
 * поздний шаг» относилась ровно к этому этапу, и он сделан.
 * Порядок обхода — ротация по давности (`generate-rotation.ts`, пункт
 * A1): за ночь бюджет пропускает ≈28 пар из 75, и фиксированный
 * порядок оставлял хвостовые локали без сценариев навсегда.
 * ИСПОЛНЕНИЕ сгенерированных сценариев живёт отдельно — в
 * `TutorialScenarioRunnerService` (этап 97, puppeteer). Он же
 * заполняет `lastRunAt`/`lastRunStatus`/`lastRunError`; этот сервис
 * их только СТИРАЕТ, и лишь когда переписал шаги: прошлый результат
 * относится к шагам, которых больше нет (правка аудита этапа C).
 * Прежняя оговорка «исполнение в этой итерации не реализуется, поля
 * остаются пустыми» устарела дважды и держалась до сквозного аудита
 * A+B+C.
 *
 * ## Best-effort по каждому шагу отдельно
 *
 * Один упавший/невалидный ответ модели на одном шаге не должен уронить
 * весь прогон — тот же принцип, что у остальных крон-воркеров проекта
 * (`best-effort`, см. доккомментарии `CronController`): считается и
 * логируется, прогон продолжается на следующем subjectKey.
 */

import { Injectable, Logger } from '@nestjs/common';
import { GoogleGenAI } from '@google/genai';
import { createGeminiClient } from '../../common/gemini-client';
import { GEMINI_MODEL } from '../../common/gemini-model';
import { PrismaService } from '../../prisma/prisma.service';
import { AiUsageService } from '../ai-usage/ai-usage.service';
import {
  ASSISTANT_STEPS,
  AssistantStepItem,
} from '../../common/tutorial-knowledge/generated';
import { PlatformSettingsService } from '../../common/platform-settings.service';
import {
  greetingTopicKeys,
  parseTutorialLocales,
  tutorialStepFor,
  TUTORIAL_LOCALES_SETTING_KEY,
} from './tutorial-locales';
import { estimateScenarioCost, ScenarioCostEstimate } from './scenario-cost';
import { estimateCost } from '../../common/ai-pricing';
import {
  DEFAULT_VIDEO_PROVIDER_SETTING_KEY,
  resolveDefaultVideoProvider,
  VideoProviderKey,
} from '../generation/default-video-provider';
import {
  budgetExhausted,
  openTutorialBudget,
  TutorialBudget,
} from '../tutorial-runner/tutorial-budget';
import { ScenarioStep } from './scenario-steps.types';
import { mergeNarration } from './scenario-steps';
import { stableStringify } from '../../common/stable-json';
import {
  buildScenarioPrompt,
  parseScenarioResponse,
} from './tutorial-scenario-prompt';
import {
  GENERATE_ROTATION_SETTING_KEY,
  orderByStaleness,
  parseGenerateStamps,
  rotationKey,
  serializeGenerateStamps,
} from './generate-rotation';

/** Пара круга генерации: тема (шаг мастера или тема поздравления) × локаль. */
type RotationPair = { locale: string; key: string; item: AssistantStepItem };

/**
 * Бюджет на весь прогон генерации. Меньше потолка функции с запасом
 * на ответ: обрыв по таймауту не оставляет ни журнала, ни
 * `failures[]`, а свой бюджет позволяет вернуть частичный результат
 * и назвать отложенное. Тот же приём, что `RUN_DEADLINE_MS` у
 * исполнителя.
 *
 * Экспортируется ради теста ротации: «за N ночей покрыты все пары»
 * считается от этого бюджета, и зашитое в тест число молча разошлось
 * бы с ним при первой правке.
 */
export const GENERATE_DEADLINE_MS = 4 * 60 * 1000;

export interface TutorialScenarioGenerateResult {
  /**
   * Сколько пар (тема × локаль) в круге генерации — при пяти локалях
   * это 75 (десять шагов мастера и пять тем поздравления на язык), а
   * не 15. С ротацией (пункт A1) это размер КРУГА, а не число
   * обойдённых за ночь: сколько не успели — в `deferred`. Имя `pairs`, а не `subjectKeys`: с этапа C
   * второе читалось бы в журнале крона как «50 шагов обучалки», а их
   * по-прежнему десять (правка аудита этапа C).
   */
  pairs: number;
  /**
   * На каких языках РЕАЛЬНО генерировали. Не то же, что список из
   * настройки: локаль без словаря шагов пропускается, и рапортовать
   * «генерировали на de», не сгенерировав ничего, нельзя.
   */
  locales: string[];
  /**
   * Сколько строк не тронули, потому что их правил человек
   * (`generatedBy: 'manual'`). Не ошибка и не успех — отдельное
   * число, иначе молчаливая перезапись выглядела бы как генерация.
   */
  skippedManual: number;
  /** Заполнено, когда прогон отложен целиком — сегодня это суточный
   *  денежный потолок. Без отдельного поля «отложено» выглядело бы
   *  как «прогнали, и делать было нечего». */
  skipped?: string;
  /**
   * Сколько пар круга не успели взять в работу (бюджет времени или
   * денег) — они первыми пойдут в следующий прогон по ротации. Без
   * этого числа по журналу не видно, сколько ночей займёт круг.
   */
  deferred: number;
  generated: number;
  costly: number;
  failed: number;
  /**
   * Локаль в записи об отказе обязательна с этапа C: без неё пять
   * локалей дают пять неразличимых строк «шаг 1 не сгенерирован», и
   * непонятно, сломался один язык или все.
   */
  failures: Array<{ subjectKey: string; locale: string; reason: string }>;
  /**
   * Сколько реплик отброшено валидацией (§3-бис.2 ТЗ
   * docs-tz/TZ-Tutorial-Video-Voiced.md, этап D) — сценарии при этом
   * сгенерированы и записаны, просто эти кадры будут немыми.
   *
   * Отдельное число, а не строка в `failed`: отказ сценария и
   * отброшенная реплика — разные события с разной ценой. Первое
   * означает «регрессионного прогона на этот шаг не будет», второе —
   * «прогон будет, кадр будет, диктор промолчит». Смешать их значит
   * поднять тревогу там, где потерялась подпись, или не поднять там,
   * где потерялся шаг.
   */
  narrationsDropped: number;
}

@Injectable()
export class TutorialScenarioGeneratorService {
  private readonly logger = new Logger(TutorialScenarioGeneratorService.name);
  private readonly genai: GoogleGenAI;

  constructor(
    private readonly prisma: PrismaService,
    private readonly aiUsage: AiUsageService,
    // Список локалей — настройкой (этап C). `PlatformSettingsService`
    // приходит из global-модуля `TtsModule`, явный импорт не нужен.
    private readonly settings: PlatformSettingsService,
  ) {
    // Тот же приём, что video-audit/relevance/analysis и т.п. — клиент
    // создаётся сервисом сам, не инжектится (common/gemini-client.ts).
    this.genai = createGeminiClient();
  }

  async run(): Promise<TutorialScenarioGenerateResult> {
    // Локали — настройкой, а не константой (этап C): пятый уровень
    // отката §9 требует сузить список до `['ru']` БЕЗ деплоя, когда
    // чужой язык начнёт ронять `assertText`.
    const locales = parseTutorialLocales(
      await this.settings.get(TUTORIAL_LOCALES_SETTING_KEY),
    );
    const result: TutorialScenarioGenerateResult = {
      pairs: 0,
      locales: [],
      skippedManual: 0,
      deferred: 0,
      generated: 0,
      costly: 0,
      failed: 0,
      failures: [],
      narrationsDropped: 0,
    };

    // Бюджет времени, которого у генератора не было: этап C умножил
    // его работу на пять (50 последовательных вызовов модели в одном
    // HTTP-запросе), а функция живёт ограниченное время. Без бюджета
    // обрыв усекал прогон на той локали, до которой дошёл, — всегда
    // на последних по списку, молча, и `failures[]` не сохранялся
    // вовсе (находка сквозного аудита A+B+C). У всех соседей по
    // семейству бюджет есть.
    const deadline = Date.now() + GENERATE_DEADLINE_MS;

    // Денежный потолок — рядом с бюджетом времени и по той же причине
    // (сквозной аудит 29.09.2026): до него у ночной работы обучалки
    // потолков было три, и все три считали штуки и секунды, а не
    // деньги. Генерация — первая из трёх трат за ночь, и выбирать
    // потолок она может сама: пятьдесят пар по вызову модели.
    const budget = await openTutorialBudget(this.settings, this.aiUsage);

    // Провайдер видео, предзаполненный в мастере (правка 29.09.2026 по
    // замечанию владельца: умолчание — Grok, не Veo). Читается ОДИН раз
    // на прогон и передаётся в промпт: сценарий должен объявлять модель
    // того движка, которым продукт реально отрендерит ролик, иначе
    // прикидка расходится с тратой в разы — $3.20 против $0.64 за
    // восьмисекундный ролик, — и оператор одобряет не ту сумму.
    const videoProvider = resolveDefaultVideoProvider(
      await this.settings
        .get(DEFAULT_VIDEO_PROVIDER_SETTING_KEY)
        .catch(() => null),
    );
    if (budgetExhausted(budget)) {
      const reason =
        'суточный потолок расхода обучалки выбран — генерация отложена до завтра';
      this.logger.warn(reason);
      return { ...result, skipped: reason };
    }

    // Владелец расхода. Генерация — фоновый крон без живого
    // пользователя, и до сквозного аудита A+B+C её расход шёл БЕЗ
    // владельца: `AiUsageService.record` помечает такую строку
    // `anonymous`, и она выбирает общий суточный потолок анонимных
    // посетителей (≈$5) — тот же, из которого платит настоящий гость
    // на лендинге. Пятьдесят вызовов Gemini за ночь его и выбирали.
    // Пишем на ту же фикстуру, на которую пишет исполнитель
    // (`fixture-seed.ts`): она помечена `isTestUser`, и отчёт
    // расходов показывает её отдельным блоком, а не в общих числах.
    // `undefined` (фикстуры нет) — поведение ровно прежнее: расход
    // записан, просто без владельца; молчать о деньгах хуже.
    const ownerId = await this.fixtureOwnerId();

    // Сначала — весь круг пар (тема × локаль) плоским списком, и
    // только потом обход. Прежний обход шёл локаль за локалью в
    // порядке настройки, и бюджет времени (≈28 пар из 75 при пяти
    // локалях) каждую ночь кончался на одном и том же месте: хвостовые
    // локали не генерировались никогда (пункт A1 обучалок). Плоский
    // список нужен, чтобы ротация могла поставить впереди пару из любой
    // локали, а не только локаль целиком.
    const circle: RotationPair[] = [];
    for (const locale of locales) {
      // Словарь шагов у каждой локали свой и уже переведён — это и
      // есть весь «перевод» в этом этапе. Локали без словаря
      // пропускаем громко: молча она дала бы ноль шагов и выглядела
      // бы как «сгенерировали, просто нечего».
      const steps = ASSISTANT_STEPS[locale] ?? [];
      if (steps.length === 0) {
        this.logger.warn(
          `локаль ${locale} запрошена, но шагов обучалки для неё нет — пропуск`,
        );
        continue;
      }
      /*
       * Две семьи тем в одном прогоне (29.09.2026): десять шагов
       * мастера товара под номерами и пять тем поздравления под
       * именами. Ключ задаётся здесь, а не выводится из индекса
       * внутри цикла: у второй семьи номера нет вовсе, и вывод из
       * индекса дал бы ей чужие ключи '1'..'5', то есть перезаписал бы
       * первые пять сценариев мастера.
       *
       * Порядок — сначала мастер: при равной давности (первая ночь,
       * отметок ещё нет) бюджет отложит менее обжитую половину.
       */
      circle.push(
        ...steps.map((item, i) => ({ locale, key: String(i + 1), item })),
        ...greetingTopicKeys(locale).flatMap((key) => {
          const item = tutorialStepFor(key, locale);
          return item ? [{ locale, key, item }] : [];
        }),
      );
    }
    result.pairs = circle.length;

    // Ротация по давности — тот же приём, что `lastRunAt asc nulls
    // first` у исполнителя: впереди пары, которые дольше всех не брали
    // в работу. Настройку читаем терпимо: без карты порядок просто
    // прежний, а уронить генерацию из-за вспомогательной отметки
    // хуже, чем одну ночь пройти по старому порядку.
    const stamps = parseGenerateStamps(
      await this.settings.get(GENERATE_ROTATION_SETTING_KEY).catch(() => null),
    );
    const taken = await this.runPairs(
      orderByStaleness(circle, stamps),
      stamps,
      circle,
      result,
      deadline,
      ownerId,
      budget,
      videoProvider,
    );
    // Локаль попадает в отчёт, только если хоть одну её пару сегодня
    // взяли в работу, и в порядке настройки: с ротацией локаль может
    // целиком уйти на завтра, и рапортовать «генерировали на de», не
    // сгенерировав ничего, нельзя (правка аудита этапа C).
    result.locales = locales.filter((l) => taken.has(l));

    this.logger.log(
      `сценарии обучалки: локалей ${result.locales.length} (${result.locales.join(', ')}), ` +
        `сгенерировано ${result.generated}, платных ${result.costly}, ` +
        `отказов ${result.failed}, отброшено реплик ${result.narrationsDropped}, ` +
        `не тронуто правленных руками ${result.skippedManual}, ` +
        `отложено по ротации ${result.deferred} из ${result.pairs}`,
    );
    return result;
  }

  /**
   * Тот же фикстурный пользователь, под которым исполнитель гоняет
   * сценарии (`FIXTURE_TELEGRAM_ID`, `fixture-seed.ts`). Ищется, а не
   * заводится: заводить пользователя из генератора значило бы, что
   * ночной крон создаёт строки в `User` на стенде, где фикстура
   * намеренно не настроена.
   *
   * Любая неудача — `undefined`, и прогон идёт дальше: расход без
   * владельца хуже, чем с владельцем, но НЕсгенерированные сценарии
   * хуже обоих.
   */
  private async fixtureOwnerId(): Promise<string | undefined> {
    const telegramId = process.env.FIXTURE_TELEGRAM_ID?.trim();
    if (!telegramId) return undefined;
    try {
      const user = (await this.prisma.user.findUnique({
        where: { telegramId },
        select: { id: true },
      })) as { id: string } | null;
      return user?.id;
    } catch {
      return undefined;
    }
  }

  /**
   * Пишет сценарий пары (шаг, локаль). `false` — строку не тронули.
   *
   * ## Почему не голый `upsert`
   *
   * Пара (шаг, локаль) — это ОДИН сценарий, а не журнал попыток:
   * с `create` каждый суточный прогон добавлял новую строку,
   * исполнитель брал их все и снимал по ролику на каждую, а с пятью
   * локалями это умножилось бы на пять (§3-бис.6). Но безусловный
   * `upsert` ломает три вещи сразу, и все три нашёл аудит этапа C.
   *
   * **1. Правку человека он затирает.** До этапа I промпт требовал от
   * модели плейсхолдеры, «которые оператор поправит на настоящие перед
   * первым исполнением» (теперь — закрытый каталог `qa-hooks.ts`, но
   * ручная правка по-прежнему возможна), а §11 п.8 приёмки прямо
   * стоит на сценарии с руками проставленными селекторами. До этапа
   * C правка выживала: генератор делал `create`, и поправленная
   * строка оставалась рядом. Поэтому `generatedBy: 'manual'` —
   * стоп-сигнал: такую строку генератор не трогает вовсе.
   *
   * **2. Одобрение он наследует молча.** Сценарий был
   * `costly, approved`; ночью модель переписала платные шаги —
   * другая модель, другие единицы. Старое «да» означало бы деньги за
   * то, чего оператор не видел. Поэтому одобрение снимается, но
   * ТОЛЬКО когда шаги действительно изменились и платность в деле:
   * сбрасывать его на неизменившемся сценарии значило бы гонять
   * оператора переодобрять одно и то же каждую ночь.
   *
   * **3. Результат прошлого прогона он оставляет.** `lastRunStatus`
   * относится к ШАГАМ, которых после перезаписи больше нет, и
   * карточка показывает зелёное «ok» на переписанном сценарии.
   * Изменились шаги — прошлый результат больше ничего не значит.
   */
  private async writeScenario(
    subjectKey: string,
    locale: string,
    steps: ScenarioStep[],
    cost: ScenarioCostEstimate,
  ): Promise<boolean> {
    const existing = (await this.prisma.tutorialScenario.findUnique({
      where: { subjectKey_locale: { subjectKey, locale } },
      select: {
        steps: true,
        generatedBy: true,
        costly: true,
        approved: true,
        // Только ради строки в журнале: решение снять отметку
        // принимается по `changed`, а не по ней. Но «снята» и «её и
        // не было» — разные события, и писать первое про второе
        // значит приучить читателя журнала не верить ему.
        narrationReviewedAt: true,
      },
    })) as {
      steps: unknown;
      generatedBy: string;
      costly: boolean;
      approved: boolean;
      narrationReviewedAt: Date | null;
    } | null;

    if (!existing) {
      await this.prisma.tutorialScenario.create({
        data: {
          subjectKey,
          locale,
          generatedBy: 'ai',
          steps: steps as object,
          costly: cost.costly,
          estimatedCostMicroUsd: cost.estimatedCostMicroUsd,
          costUnpriced: cost.unpriced,
        },
      });
      return true;
    }

    if (existing.generatedBy === 'manual') {
      this.logger.log(
        `сценарий шага ${subjectKey} (${locale}) правлен руками — не трогаем, генерация пропущена`,
      );
      return false;
    }

    // `stableStringify`, а НЕ `JSON.stringify`. Прежний комментарий
    // здесь уверял, что «обе стороны — один и тот же JSON, ложного
    // «изменилось» не будет», и это было неправдой: `steps` —
    // колонка `jsonb`, а Postgres хранит её в своём порядке ключей
    // (короткие раньше длинных). Шаг `{kind, selector, value}`
    // возвращается как `{kind, value, selector}` — проверено на
    // живом Postgres 16, — то есть `changed` было истинно ВСЕГДА для
    // любого сценария с `fill`/`assertText`. Следствия: каждую ночь
    // стирался результат прогона и снималось одобрение платного
    // сценария, то есть одобрить его насовсем было невозможно
    // (находка сквозного аудита A+B+C).
    // Свежий ответ модели СЛИВАЕТСЯ с сохранённым: механика новая,
    // реплика прежняя там, где шаг не изменился. Без этого этап D
    // ломал три предыдущих разом — полное обоснование у
    // `mergeNarration`, здесь коротко: реплика это свободный текст,
    // модель формулирует её каждую ночь заново, и «строка не
    // совпала» перестало значить «сценарий изменился».
    const merged = mergeNarration(existing.steps, steps);
    // Стоимость не пересчитывается по слитым шагам, и это безопасно:
    // слияние трогает ТОЛЬКО реплики, а `estimateScenarioCost` их не
    // видит вовсе — он считает по шагам `triggerPaidOperation`, у
    // которых реплики не бывает по типу. Пересчёт дал бы то же
    // число и создал бы впечатление, что оно могло бы отличаться.
    const payload = {
      steps: merged as object,
      costly: cost.costly,
      estimatedCostMicroUsd: cost.estimatedCostMicroUsd,
      costUnpriced: cost.unpriced,
    };

    const changed = stableStringify(existing.steps) !== stableStringify(merged);
    const dropApproval =
      changed && existing.approved && (existing.costly || cost.costly);

    await this.prisma.tutorialScenario.update({
      where: { subjectKey_locale: { subjectKey, locale } },
      data: {
        ...payload,
        generatedBy: 'ai',
        // `lastRunAt` НЕ стирается, хотя статус — да. Дата отвечает
        // на вопрос «когда эту строку последний раз брали в работу»,
        // и он не перестаёт быть верным от того, что шаги
        // переписали. А вот исполнитель сортирует по ней («кто
        // дольше всех не исполнялся»), и обнуление у всех строк
        // разом вырождало порядок обратно в `createdAt asc` — ту
        // самую починку этапа C, из-за которой две локали из пяти не
        // исполнялись никогда (находка сквозного аудита A+B+C).
        ...(changed ? { lastRunStatus: null, lastRunError: null } : {}),
        // Отметка о вычитке реплик снимается ровно тогда, когда шаги
        // ИЗМЕНИЛИСЬ (§3-бис.5 ТЗ, этап D): вычитан был прежний
        // текст. Условие `changed` здесь обязательно, и по той же
        // причине, по которой оно стоит у одобрения: без него ночной
        // прогон снимал бы отметку каждую ночь на неизменившемся
        // сценарии, и при включённом требовании вычитки озвучить
        // что-либо стало бы невозможно в принципе — оператор
        // отмечает днём, крон снимает ночью.
        //
        // В отличие от одобрения, платность здесь ни при чём:
        // одобрение про деньги, вычитка про текст, а текст меняется
        // и у бесплатного сценария.
        ...(changed
          ? { narrationReviewedBy: null, narrationReviewedAt: null }
          : {}),
        ...(dropApproval
          ? { approved: false, approvedBy: null, approvedAt: null }
          : {}),
      },
    });
    if (changed && existing.narrationReviewedAt) {
      this.logger.log(
        `сценарий шага ${subjectKey} (${locale}) переписан — отметка о вычитке реплик снята`,
      );
    }
    if (dropApproval) {
      this.logger.warn(
        `сценарий шага ${subjectKey} (${locale}) переписан и содержит платные шаги — одобрение снято, нужно новое`,
      );
    }
    return true;
  }

  /**
   * Пишет карту отметок ротации — после КАЖДОЙ пары (аудит кронов
   * 06.10.2026).
   *
   * Прежде запись была одна, в конце прогона, с доводом «прогон
   * укладывается в свой бюджет времени именно для того, чтобы дойти до
   * этой строки». Довод держался на том, что каждый вызов модели
   * короткий, — а таймаута у вызова не было: одно зависшее соединение
   * уводило функцию за потолок платформы, и карта не записывалась
   * вовсе. Следующая ночь начинала с тех же пар — и снова платила за
   * них. Запись после каждой пары — десятки upsert-ов одной строки за
   * ночь, цена ничтожная против повторной оплаты.
   *
   * Неудача — предупреждение, а не исключение: сценарии уже записаны,
   * и ронять из-за отметки весь отчёт прогона (а с ним `failures[]`)
   * хуже, чем одну ночь повторить прежний порядок.
   */
  private async saveStamps(
    stamps: ReadonlyMap<string, number>,
    circle: ReadonlyArray<RotationPair>,
  ): Promise<void> {
    try {
      await this.settings.set(
        GENERATE_ROTATION_SETTING_KEY,
        serializeGenerateStamps(stamps, circle),
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `отметки ротации генерации не сохранены (${reason}) — следующий прогон начнёт с прежнего порядка`,
      );
    }
  }

  /**
   * Обходит пары в уже заданном порядке. Возвращает локали, чьи пары
   * взяли в работу; `stamps` дополняет на месте.
   */
  private async runPairs(
    /** Пары в порядке ротации. Ключ приходит снаружи, а не выводится
     *  из индекса: у шагов мастера он номер, у тем поздравления — имя. */
    pairs: ReadonlyArray<RotationPair>,
    /** Карта «когда пару последний раз брали в работу». */
    stamps: Map<string, number>,
    /** Весь круг пар — для записи карты (`saveStamps` пишет только его). */
    circle: ReadonlyArray<RotationPair>,
    result: TutorialScenarioGenerateResult,
    deadline: number,
    /** Фикстурный пользователь — владелец расхода (см. `run`). */
    ownerId: string | undefined,
    /** Суточный денежный потолок тика — один на все локали. */
    budget: TutorialBudget,
    /** Движок видео, предзаполненный в мастере, — в промпт. */
    videoProvider: VideoProviderKey,
  ): Promise<Set<string>> {
    const taken = new Set<string>();
    for (let i = 0; i < pairs.length; i++) {
      const { locale, key: subjectKey, item: step } = pairs[i];
      if (Date.now() >= deadline) {
        result.deferred = pairs.length - i;
        this.logger.warn(
          `бюджет времени исчерпан на теме ${subjectKey} (${locale}) — пар отложено ${result.deferred}, они первыми пойдут в следующий прогон`,
        );
        break;
      }
      if (budgetExhausted(budget)) {
        result.deferred = pairs.length - i;
        this.logger.warn(
          `суточный потолок расхода обучалки выбран на теме ${subjectKey} (${locale}) — пар отложено ${result.deferred}, они первыми пойдут в следующий прогон`,
        );
        break;
      }
      // Отметка ставится при ВЗЯТИИ в работу, а не при успехе — как
      // `lastRunAt` у исполнителя, который пишет дату и на `failed`.
      // Иначе локаль, на которой модель стабильно отказывает, каждую
      // ночь стояла бы в голове очереди и съедала бюджет, а круг по
      // остальным парам растягивался бы на её длину. Случайный отказ
      // от этого не теряется: пара вернётся через круг (≈3 ночи).
      stamps.set(rotationKey(locale, subjectKey), Date.now());
      taken.add(locale);
      try {
        // Правленная руками пара проверяется ДО вызова модели
        // (сквозной аудит 29.09.2026). Раньше проверка стояла внутри
        // `writeScenario`, то есть после `generateContent` и после
        // записи расхода: `generatedBy: 'manual'` объявлен договором
        // «со следующей ночи генератор эту строку не трогает», а
        // генератор её трогал — просто платно и впустую. Десять
        // правленных пар давали десять лишних вызовов Gemini каждую
        // ночь, и ответ выбрасывался.
        const existing = await this.prisma.tutorialScenario.findUnique({
          where: { subjectKey_locale: { subjectKey, locale } },
          select: { generatedBy: true },
        });
        if (existing?.generatedBy === 'manual') {
          this.logger.log(
            `сценарий шага ${subjectKey} (${locale}) правлен руками — не трогаем, модель не зовём`,
          );
          result.skippedManual++;
          continue;
        }

        const prompt = buildScenarioPrompt(
          subjectKey,
          locale,
          step,
          videoProvider,
        );
        // Таймаут вызова — не дольше остатка бюджета прогона (аудит
        // кронов 06.10.2026). Бюджет проверялся только МЕЖДУ парами, а
        // сам вызов модели не был ограничен ничем: зависшее соединение
        // на последней паре уводило функцию за потолок платформы.
        // Остаток не меньше секунды — иначе вызов с нулевым таймаутом
        // упал бы, ещё не начавшись, и выглядел бы как отказ модели.
        const callTimeoutMs = Math.max(1_000, deadline - Date.now());
        const res = await this.genai.models.generateContent({
          model: GEMINI_MODEL,
          contents: [{ text: prompt }],
          config: {
            responseMimeType: 'application/json',
            httpOptions: { timeout: callTimeoutMs },
            abortSignal: AbortSignal.timeout(callTimeoutMs),
          },
        });
        await this.aiUsage.recordGemini(res, {
          operation: 'tutorial-scenario-generate',
          model: GEMINI_MODEL,
          userId: ownerId,
        });
        // Потраченное ведётся в памяти, а не перечитывается из журнала
        // перед каждой парой: пятьдесят агрегатов за прогон ради
        // одного числа — см. `openBudget` в исполнителе.
        budget.spentMicroUsd += estimateCost(GEMINI_MODEL, {
          inputTokens: res.usageMetadata?.promptTokenCount ?? 0,
          outputTokens: res.usageMetadata?.candidatesTokenCount ?? 0,
        }).costMicroUsd;

        const parsed = parseScenarioResponse(res.text ?? '', subjectKey);
        if (!parsed.ok) {
          result.failed++;
          result.failures.push({
            subjectKey,
            locale,
            reason: parsed.reason ?? 'неизвестная причина',
          });
          this.logger.warn(
            `сценарий для шага ${subjectKey} (${locale}) не сгенерирован: ${parsed.reason}`,
          );
          continue;
        }

        // Отброшенные реплики — в `failures[]`, как требует
        // §3-бис.2, и НЕ в `lastRunStatus`: то поле принадлежит
        // исполнителю, он пишет туда `ok`/`failed` каждую ночь и
        // затёр бы запись генератора ближайшим же прогоном.
        // Поимённо, а не числом: «отброшено 3» не даёт починить ни
        // одну, а причин четыре (не строка, пустая, длинная,
        // многострочная).
        for (const dropped of parsed.droppedNarrations) {
          result.narrationsDropped++;
          result.failures.push({
            subjectKey,
            locale,
            reason: `реплика шага ${dropped.stepNumber} отброшена: ${dropped.reason}`,
          });
        }
        if (parsed.droppedNarrations.length > 0) {
          this.logger.warn(
            `сценарий для шага ${subjectKey} (${locale}): отброшено реплик ${parsed.droppedNarrations.length} — эти кадры будут немыми`,
          );
        }

        // Повисшие объявления платных вызовов — туда же и по той же
        // причине. Молчать тут нельзя вдвойне: без этой строки
        // единственным следом правки было бы то, что сценарий
        // ПЕРЕСТАЛ быть платным, — а «перестал» в журнале не видно
        // вовсе (находка повторного аудита этапа F).
        for (const dropped of parsed.droppedPaidOperations) {
          result.failures.push({
            subjectKey,
            locale,
            reason: `шаг ${dropped.stepNumber}: ${dropped.reason}`,
          });
        }
        if (parsed.droppedPaidOperations.length > 0) {
          this.logger.warn(
            `сценарий для шага ${subjectKey} (${locale}): вырезано повисших объявлений платных вызовов ${parsed.droppedPaidOperations.length} — сценарий не будет ждать одобрения впустую`,
          );
        }

        const cost = estimateScenarioCost(parsed.steps);
        const written = await this.writeScenario(
          subjectKey,
          locale,
          parsed.steps,
          cost,
        );
        if (!written) {
          result.skippedManual++;
          continue;
        }
        result.generated++;
        if (cost.costly) result.costly++;
        if (cost.unpriced) {
          this.logger.warn(
            `сценарий для шага ${subjectKey} (${locale}): прикидка стоимости занижена (нет ставки хотя бы для одной модели) — проверьте common/ai-pricing.ts перед одобрением`,
          );
        }
      } catch (error) {
        result.failed++;
        const reason = error instanceof Error ? error.message : String(error);
        result.failures.push({ subjectKey, locale, reason });
        this.logger.warn(
          `сценарий для шага ${subjectKey} (${locale}) упал с ошибкой: ${reason}`,
        );
      } finally {
        // По ходу, а не в конце: см. `saveStamps`. В `finally` — чтобы
        // и `continue` (правлена руками, отказ модели), и исключение
        // оставили отметку взятой пары.
        await this.saveStamps(stamps, circle);
      }
    }
    return taken;
  }
}
