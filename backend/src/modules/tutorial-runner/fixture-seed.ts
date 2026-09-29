/**
 * fixture-seed.ts — общая логика заведения/обновления фикстурного
 * пользователя для регресс-раннера обучалки (§3.3 ТЗ
 * doc/TMA-UI-SNAPSHOT-AND-TUTORIAL-VIDEO-SPEC.md, этап 97).
 *
 * Извлечено из `backend/scripts/seed-fixture-user.ts` этапом 105, когда
 * выяснилось, что единственный способ запустить сидирование — ручной
 * CLI-вызов с прод DATABASE_URL, недоступный оператору без доступа к
 * серверу/CI. Сама функция принимает готовый `PrismaClient`-совместимый
 * объект (не создаёт своего подключения) — вызывающая сторона решает,
 * откуда его взять:
 *  - CLI-скрипт (`scripts/seed-fixture-user.ts`) создаёт свой
 *    `PrismaClient` с адаптером — тот же приём, что раньше, просто тело
 *    цепочки upsert'ов переехало сюда;
 *  - админский эндпоинт (`FixtureSeedAdminController`, этот же модуль)
 *    переиспользует уже подключённый `PrismaService` уже запущенного
 *    процесса — тот самый, что обслуживает прод-трафик, значит и
 *    DATABASE_URL уже прод, второй раз указывать не нужно.
 *
 * Все ID фиксированы строками (см. `FIXTURE_IDS`) — повторный запуск
 * обновляет те же строки через `upsert`, не плодит дубликаты. Такая же
 * гарантия идемпотентности, что была у исходного скрипта — оба
 * потребителя её наследуют бесплатно.
 *
 * `generatedVideo.pathname` указывает на несуществующий объект в Vercel
 * Blob — раннер взаимодействует с DOM (goto/fill/click/waitFor/
 * assertVisible/assertText), а не скачивает сам файл видео, так что
 * реальные байты ролика ему не нужны (см. историю
 * `scripts/seed-fixture-user.ts` — то же упрощение, тот же довод).
 */

import type { PrismaClient } from '@prisma/client';
import { ProjectType } from '@prisma/client';
import { currencyForCountry } from '../../common/data/countries';
import { GenerationStatus } from '../../common/types/generation.types';
import { AnalysisStatus } from '../../common/types/analysis.types';
import { SessionStatus } from '../../common/types/session.types';
import { DEFAULT_VOICE_MODE } from '../../common/voice-mode';
import { greetingBriefSnapshotFrom } from '../project-session/snapshot';

export const FIXTURE_IDS = {
  manifest: 'fixture-tutorial-manifest',
  character: 'fixture-tutorial-character',
  project: 'fixture-tutorial-project',
  item: 'fixture-tutorial-item',
  session: 'fixture-tutorial-session',
  /**
   * Вторая и третья сессии — разбор достижимости хуков 29.09.2026.
   *
   * Сессия с ГОТОВЫМ роликом показывает поверхности просмотра и не
   * показывает поверхности работы, и это не дефект интерфейса, а его
   * природа: законченное не может показывать органы управления тем,
   * что его производит. Десять хуков каталога жили на экранах, до
   * которых с неё не дойти:
   *
   *   - `relevance-panel` и соседи рисуются под `!prompt`
   *     (`GenerationWizard.tsx`) — нужна сессия ДО промпта;
   *   - карточка запуска рендера (`aspect-ratio-picker`,
   *     `video-generate` и ещё четыре) — под
   *     `generatedVideo?.status !== 'complete'` — нужна сессия С
   *     одобренным промптом и БЕЗ ролика.
   *
   * Стоит это ноль: сидирование — обычный upsert строк, платных
   * вызовов здесь нет ни одного.
   */
  sessionPromptPending: 'fixture-tutorial-session-prompt-pending',
  sessionReadyToRender: 'fixture-tutorial-session-ready-to-render',
  generatedVideo: 'fixture-tutorial-generated-video',
  /** Проект ТРЕТЬЕГО типа (`CLIENT_SITE`) — отдельный от рекламного, а
   *  не тот же самый: у `CLIENT_SITE` нет товаров, всё специфичное живёт
   *  в `ClientSiteTutorialDraft`. Заведён этапом G ТЗ
   *  `docs-tz/TZ-Enterprise-Tutorial-Landing.md`, чтобы маршрут
   *  `site-tutorial` было на чём резолвить. */
  clientSiteProject: 'fixture-tutorial-client-site-project',
  /**
   * Проекты ЧЕТВЁРТОГО типа (`GREETING_VIDEO`) — три, по одному на
   * состояние экрана (29.09.2026).
   *
   * Три ПРОЕКТА, а не три сессии: мастер поздравления берёт последнюю
   * сессию проекта с сервера, а не из localStorage, поэтому состояние
   * задаётся адресом. Разные проекты — единственный способ иметь три
   * состояния одновременно.
   */
  greetingProject: 'fixture-tutorial-greeting-project',
  greetingDraftingProject: 'fixture-tutorial-greeting-drafting-project',
  greetingReadyProject: 'fixture-tutorial-greeting-ready-project',
  greetingDraftingSession: 'fixture-tutorial-greeting-drafting-session',
  greetingReadySession: 'fixture-tutorial-greeting-ready-session',
} as const;

export interface FixtureSeedResult {
  userId: string;
  telegramId: string;
  manifestId: string;
  characterId: string;
  projectId: string;
  itemId: string;
  sessionId: string;
  /** Сессия на шаге промпта, промпт ещё не сгенерирован. */
  promptPendingSessionId: string;
  /** Промпт одобрен, ролика нет — экран запуска рендера. */
  readyToRenderSessionId: string;
  clientSiteProjectId: string;
  /** Поздравление: бриф есть, сессии нет. */
  greetingProjectId: string;
  /** Поздравление: сессия есть, сценарий не собран. */
  greetingDraftingProjectId: string;
  /** Поздравление: сценарий собран, видны все девять карточек. */
  greetingReadyProjectId: string;
  /** Человекочитаемый журнал шагов — тот же текст, что раньше шёл в console.log CLI-скрипта. */
  log: string[];
}

/**
 * Заводит/обновляет фикстурного пользователя со всей цепочкой данных,
 * которую ждут шаги сценариев обучалки (манифест бренда → персонаж →
 * проект → товар → сессия с готовым роликом). Ничего не удаляет и не
 * трогает, кроме строк с фиксированными ID из `FIXTURE_IDS` плюс `User`
 * с указанным `telegramId` — безопасно перезапускать в любой момент.
 */
export async function seedFixtureUser(
  prisma: PrismaClient,
  telegramId: string,
): Promise<FixtureSeedResult> {
  const log: string[] = [];

  // `isTestUser` — и в `update` тоже, чтобы уже заведённая фикстура
  // получила флаг при первом же прогоне сида.
  //
  // Это не косметика. Расход ночной обучалки (синтез речи, сборка
  // ffmpeg, генерация сценариев) записывается НА ЭТОГО
  // пользователя; без флага он попадал бы в общие числа отчёта
  // расходов вперемешку с настоящими людьми.
  //
  // `freeOutsideProject` — вторая половина той же правки, и без неё
  // первая простреливает себе в ногу (находка повторного сквозного
  // аудита A+B+C). Фикстура заводится на тарифе по умолчанию
  // (`LITE`), а его суточный потолок — два доллара, самый низкий в
  // продукте. Гейта в пути обучалки нет, прогон бы не остановился,
  // но `PlanService.stateOf` отдаёт `budget.nearlyExhausted` уже на
  // 80 % потолка, а `AccountNotice` рисует по нему плашку в ОБОЛОЧКЕ
  // приложения — то есть на каждом экране. Прогон ходит по SPA под
  // этим пользователем и СНИМАЕТ ЭКРАНЫ: плашка «дневной лимит
  // исчерпан» уехала бы в обучающий ролик для посетителей и в
  // снимки мастера для лендинга. С этой галочкой действует потолок
  // тестовых аккаунтов (по умолчанию $20), до которого ночному
  // прогону далеко. Зелёную плашку «тестовый доступ» она при этом
  // НЕ включает: `showsTestAccess` требует непустой список
  // сценарных галочек, а его у фикстуры нет и не должно быть. Проект для этого уже
  // держит отдельный блок: «провайдеру за них заплачено, и молча
  // выкинуть их расход значило бы занизить реальные траты, но и
  // смешивать нельзя». До сквозного аудита A+B+C расход обучалки шёл
  // вообще без владельца и выбирал общий суточный потолок АНОНИМНЫХ
  // посетителей (≈$5) — то есть один ночной прогон озвучки мог
  // закрыть мастер настоящим гостям до полуночи.
  const user = await prisma.user.upsert({
    where: { telegramId },
    update: { isTestUser: true, freeOutsideProject: true },
    create: {
      telegramId,
      firstName: 'Fixture Runner',
      isOperator: false,
      isTestUser: true,
      freeOutsideProject: true,
      /**
       * Тариф задаётся ЯВНО и только при создании (разбор
       * достижимости 29.09.2026).
       *
       * Умолчание схемы — LITE, а у LITE выключены `relevance`,
       * `audit` и `referenceAssets` (`common/plans.ts`). Это ровно
       * три хука каталога: `relevance-panel`, `audit-panel`,
       * `reference-slots`. На LITE-фикстуре они не появились бы ни
       * при каком состоянии сессии и ни при каком клике — то есть
       * заново та же поломка, ради которой весь этот разбор и
       * затевался, только спрятанная в тарифе, а не в данных сессии.
       *
       * Сегодня фикстура на проде Premium, но держится это на строке
       * в базе, поставленной руками 13.09.2026. Пересев фикстуры на
       * чистого пользователя молча вернул бы LITE.
       *
       * ТОЛЬКО в `create`: `telegramId` из `.env` вполне может
       * указывать на живой аккаунт («возьмём мой»), и менять тариф
       * живому человеку сидирование права не имеет. Уже заведённому
       * пользователю тариф не трогаем, а расхождение называем в
       * журнале ниже.
       */
      plan: 'PREMIUM',
    },
  });
  // Оператор обязан прочитать это в ответе кнопки «Завести
  // фикстуру»: `telegramId` в `.env` вполне может указывать на живой
  // аккаунт («возьмём мой»), и тогда флаг тестового уводит расход
  // ЭТОГО человека из общих чисел отчёта. Молча — нельзя.
  log.push(
    `Пользователь: ${user.id} (telegramId=${telegramId}) — помечен тестовым, ` +
      'его расход показывается отдельным блоком отчёта, а суточный потолок — ' +
      'потолок тестовых аккаунтов',
  );
  // Тариф существующего пользователя не трогаем, но молчать о нём
  // нельзя: на LITE три хука каталога недостижимы навсегда, и
  // сценарии с ними будут падать на `waitFor` без внятной причины.
  if (user.plan !== 'PREMIUM') {
    log.push(
      `ВНИМАНИЕ: тариф фикстуры — ${user.plan}, а не PREMIUM. Проверка ` +
        'релевантности, проверка ролика на артефакты и свои референс-слоты ' +
        'на нём выключены (common/plans.ts), значит сценарии хуков ' +
        'relevance-panel, audit-panel и reference-slots будут падать по ' +
        'таймауту. Тариф менялся не здесь — поменяйте его в «Пользователях».',
    );
  }

  const manifest = await prisma.brandManifest.upsert({
    where: { id: FIXTURE_IDS.manifest },
    update: { userId: user.id },
    create: {
      id: FIXTURE_IDS.manifest,
      userId: user.id,
      title: 'Fixture Brand',
      styleNotes:
        'Фикстурный манифест бренда для автоматического исполнителя сценариев обучающих видео (этап 97).',
      voiceNotes: 'Нейтральный, дружелюбный тон.',
    },
  });
  log.push(`Манифест бренда: ${manifest.id}`);

  const character = await prisma.brandCharacter.upsert({
    where: { id: FIXTURE_IDS.character },
    update: { brandManifestId: manifest.id },
    create: {
      id: FIXTURE_IDS.character,
      brandManifestId: manifest.id,
      label: 'Fixture Model',
      description:
        'Персонаж-заглушка без фото — сценарии проверяют, что экран выбора персонажа открывается и показывает карточку, не саму картинку.',
    },
  });
  log.push(`Персонаж бренда: ${character.id}`);

  const project = await prisma.project.upsert({
    where: { id: FIXTURE_IDS.project },
    update: { userId: user.id, brandManifestId: manifest.id },
    create: {
      id: FIXTURE_IDS.project,
      userId: user.id,
      type: ProjectType.SINGLE,
      title: 'Fixture Project',
      countryCode: 'UA',
      currency: currencyForCountry('UA') ?? 'UAH',
      brandManifestId: manifest.id,
    },
  });
  log.push(`Проект: ${project.id}`);

  const item = await prisma.productItem.upsert({
    where: { id: FIXTURE_IDS.item },
    update: { projectId: project.id },
    create: {
      id: FIXTURE_IDS.item,
      projectId: project.id,
      title: 'Fixture Product',
      description:
        'Товар-заглушка для регрессионных сценариев обучающих видео — без фото.',
      category: 'demo',
    },
  });
  log.push(`Товар: ${item.id}`);

  /**
   * Проект-обучалка по сайту заказчика (этап G ТЗ
   * `docs-tz/TZ-Enterprise-Tutorial-Landing.md`).
   *
   * Черновик (`ClientSiteTutorialDraft`) здесь СОЗНАТЕЛЬНО не заводится,
   * хотя без него визард открывается только на первой стадии («вставьте
   * адрес»). Черновик обязан нести `roundScreenshots` — настоящие кадры
   * чужого сайта, снятые настоящим раундом. Выдумать их нельзя: фикстура
   * с несуществующими картинками дала бы экран с битыми кадрами, и
   * первый же снимок для лендинга оказался бы снимком поломки. Стадии
   * `page`/`review` снимаются прогоном по живому сайту (этап I того же
   * ТЗ), а не подделкой данных.
   *
   * То же основание, что у `generatedVideo.pathname` ниже, но вывод
   * ОБРАТНЫЙ, и это не противоречие: там несуществующий файл безвреден,
   * потому что раннер работает с DOM и видео не скачивает; здесь кадры
   * — это и есть то, что видно на экране.
   */
  const clientSiteProject = await prisma.project.upsert({
    where: { id: FIXTURE_IDS.clientSiteProject },
    update: { userId: user.id },
    create: {
      id: FIXTURE_IDS.clientSiteProject,
      userId: user.id,
      type: ProjectType.CLIENT_SITE,
      title: 'Fixture Client Site Tutorial',
      countryCode: 'UA',
      currency: currencyForCountry('UA') ?? 'UAH',
    },
  });
  log.push(`Проект-обучалка (CLIENT_SITE): ${clientSiteProject.id}`);

  /**
   * Снимок товара в сессии — по НАСТОЯЩЕМУ контракту
   * `ProductInformation`, а не по придуманным ключам.
   *
   * До 29.09.2026 здесь стояло `{ title, description }`. Контракт —
   * `productName` / `productDescription`, и читает его
   * `seedFromSession` (`frontend/src/hooks/useWorkflow.ts`) именно по
   * этим именам. Получал он `undefined`, и дальше рушилась вся
   * навигация: `stepTargets` открывает позицию «Промпт» только при
   * `sourced && s.productName`. Экран товара при этом открывался
   * пустым, хотя товар в фикстуре есть.
   *
   * Ошибка была тихой ровно потому, что `data` — Json-колонка: лишние
   * ключи никто не отвергает, а недостающие превращаются в
   * `undefined` в интерфейсе, а не в ошибку здесь.
   *
   * `productImagePathname` задан намеренно: по нему `seedFromSession`
   * ставит `imageUploadProgress: 100`, а без этой сотни карточка
   * запуска рендера скрыта первым же условием — то есть третья
   * сессия не показала бы того, ради чего заведена. Файла по этому
   * пути в Blob нет, и это безвредно по тому же основанию, что у
   * `generatedVideo.pathname` ниже: раннер работает с DOM.
   */
  const productInformation = {
    productName: item.title,
    productDescription: item.description ?? '',
    addedAt: new Date().toISOString(),
    category: item.category ?? null,
    countryCode: 'UA',
    languageCode: 'ru',
    dialogueLanguage: 'ru',
    productImagePathname: `sessions/${FIXTURE_IDS.session}/product.jpg`,
    sourceProductItemId: item.id,
  };

  /**
   * Разбор референса. Без него `stepTargets` не открывает НИ ОДНОЙ
   * позиции степпера кроме «Загрузки»: `analysed` ложно, а из него
   * выводится `sourced`, от которого зависят «Товар» и «Промпт».
   *
   * То есть до 29.09.2026 на фикстуре была кликабельна ровно одна
   * позиция из пяти, и любой сценарий, переходящий по степперу,
   * молча не переходил никуда: `goToStep` при `target === null`
   * возвращает прежнее состояние, клик проходит, экран не меняется, а
   * следующий `waitFor` ждёт пятнадцать секунд и падает. Так падали
   * сценарии 4 и 7 во всех пяти боевых прогонах.
   *
   * Персонаж и сцена перечислены не для красоты: `CharacterCasting`
   * рисуется при `analysis?.characters !== undefined`, `SceneCasting`
   * — при непустом разборе. Пустой массив достаточен для первого, но
   * карточка без строк проверяла бы меньше, чем может.
   */
  const videoAnalysis = {
    analysisId: `${FIXTURE_IDS.session}-analysis`,
    analyzedAt: new Date().toISOString(),
    status: AnalysisStatus.COMPLETE,
    sceneBreakdown:
      'Фикстурный разбор референса для регрессионных сценариев обучалки. ' +
      'Сцена 1: крупный план товара на столе. Сцена 2: человек берёт товар в руки. ' +
      'Сцена 3: товар в использовании, финальный кадр с логотипом.',
    characters: [
      {
        id: 'c1',
        label: 'Fixture Presenter',
        role: 'presenter',
        appearance: 'Человек средних лет, светлая рубашка, нейтральный фон.',
        prominence: 'main' as const,
        previewAt: null,
        previewUrl: null,
      },
    ],
    scenes: [
      {
        id: 's1',
        start: 0,
        end: 3,
        title: 'Крупный план товара на столе',
        previewAt: null,
        previewUrl: null,
      },
      {
        id: 's2',
        start: 3,
        end: 6,
        title: 'Человек берёт товар в руки',
        previewAt: null,
        previewUrl: null,
      },
    ],
    extras: [],
  };

  /**
   * Одобренный промпт. `stepTargets` открывает позицию «Видео» только
   * при `s.prompt?.approvedAt` — без него до экрана запуска рендера
   * не дойти ни кликом, ни как-либо ещё.
   */
  const approvedPrompt = (sessionId: string) => ({
    promptId: `${sessionId}-prompt`,
    generatedText:
      'Фикстурный промпт для регрессионных сценариев обучающих видео.',
    finalText: 'Фикстурный промпт для регрессионных сценариев обучающих видео.',
    characterCount: 62,
    generatedAt: new Date().toISOString(),
    approvedAt: new Date().toISOString(),
    moderationStatus: 'approved',
  });

  // См. доккомментарий файла: реального файла в Blob по этому pathname
  // нет и не будет создано этой функцией.
  const generatedVideo = {
    generatedVideoId: FIXTURE_IDS.generatedVideo,
    pathname: `sessions/${FIXTURE_IDS.session}/generated.mp4`,
    fileName: 'generated.mp4',
    mimeType: 'video/mp4',
    status: GenerationStatus.COMPLETE,
    // Строкой (не `Date`): `data` — Json-колонка, `Prisma.InputJsonValue`
    // не принимает `Date` напрямую.
    initiatedAt: new Date().toISOString(),
    provider: 'veo' as const,
    // Режим озвучки — НЕ умолчание и не косметика (находка второго
    // боевого прогона 29.09.2026). `RevoicePanel` на экране постпрода
    // рендерится только при `usesOwnVoice(video.voiceMode)`, а фикстура
    // клала ролик вовсе без поля — карточка переозвучки не появлялась
    // никогда, и сценарий хука `revoice-panel` ждал её 15 секунд.
    //
    // `'voiceover'` здесь не произвольный выбор: это
    // `DEFAULT_VOICE_MODE` (`common/voice-mode.ts`) — то, что продукт
    // ставит новым брендам с 15.09.2026. Фикстура должна выглядеть как
    // обычный сегодняшний ролик, иначе она проверяет не тот продукт.
    voiceMode: DEFAULT_VOICE_MODE,
  };

  /**
   * Три сессии, а не одна, и различаются они СОСТОЯНИЕМ, а не
   * содержимым: товар, разбор и бренд у всех одинаковы, чтобы
   * расхождение экранов нельзя было списать на разные данные.
   */
  const seedSession = async (
    id: string,
    status: SessionStatus,
    extra: {
      generationStatus?: GenerationStatus;
      prompt?: boolean;
      video?: boolean;
    },
    note: string,
  ): Promise<void> => {
    const data = {
      locale: 'ru',
      productInformation,
      videoAnalysis,
      ...(extra.prompt ? { generationPrompt: approvedPrompt(id) } : {}),
    };
    // Этап 122: готовый ролик живёт во второй колонке — так же, как его
    // пишет `SessionService.updateSession`. Положить его в `data` значило
    // бы завести фикстуру в раскладке, которой в проде не бывает: экраны
    // постпрода и админки читают `liveData`, и регрессионный обход снимал
    // бы пустой экран, ничего при этом не заметив.
    const liveData = extra.video ? { generatedVideo } : {};
    const fields = {
      userId: user.id,
      projectId: project.id,
      productItemId: item.id,
      status,
      generationStatus: extra.generationStatus ?? null,
      data,
      liveData,
    };
    await prisma.session.upsert({
      where: { id },
      update: fields,
      create: { id, ...fields },
    });
    log.push(`${note}: ${id}`);
  };

  await seedSession(
    FIXTURE_IDS.session,
    SessionStatus.VIDEO_COMPLETE,
    { generationStatus: GenerationStatus.COMPLETE, prompt: true, video: true },
    'Сессия с готовым роликом',
  );
  await seedSession(
    FIXTURE_IDS.sessionPromptPending,
    SessionStatus.PRODUCT_INFO_ADDED,
    {},
    'Сессия до промпта (релевантность, кнопка «Сгенерировать промпт»)',
  );
  await seedSession(
    FIXTURE_IDS.sessionReadyToRender,
    SessionStatus.PROMPT_GENERATED,
    { prompt: true },
    'Сессия с одобренным промптом и без ролика (карточка запуска рендера)',
  );

  /**
   * Три проекта-поздравления — по одному на состояние экрана.
   *
   * Снимок брифа в сессию кладёт `greetingBriefSnapshotFrom` — ТА ЖЕ
   * функция, которой пользуется продукт (`ProjectSessionService`). Не
   * ради экономии строк: ровно здесь фикстура однажды уже написала
   * снимок товара придуманными ключами, и четыре позиции степпера стали
   * некликабельными — падение выглядело как ошибка сценариев, а было
   * ошибкой фикстуры. Второй раз этот способ не повторяется.
   */
  const seedGreetingProject = async (
    projectId: string,
    title: string,
    recipientName: string,
  ) => {
    const greetingProject = await prisma.project.upsert({
      where: { id: projectId },
      update: { userId: user.id },
      create: {
        id: projectId,
        userId: user.id,
        type: ProjectType.GREETING_VIDEO,
        title,
        countryCode: 'UA',
        currency: currencyForCountry('UA') ?? 'UAH',
      },
    });
    const briefFields = {
      projectId: greetingProject.id,
      // Повод из КАТАЛОГА, а не `OTHER`: у `OTHER` регистр зависит от
      // описания и определяется в том числе платным классификатором —
      // фикстуре такое ни к чему.
      occasion: 'BIRTHDAY' as const,
      customOccasionText: null,
      recipientName,
      senderName: 'Команда',
      tone: 'WARM' as const,
      personalMessage: null,
      presenterProvider: 'grok',
      resolution: '720p',
      brandManifestId: null,
      occasionDate: null,
    };
    const brief = await prisma.greetingBrief.upsert({
      where: { projectId: greetingProject.id },
      update: briefFields,
      create: briefFields,
    });
    log.push(`Проект-поздравление (${title}): ${greetingProject.id}`);
    return { projectId: greetingProject.id, brief };
  };

  const greetingFresh = await seedGreetingProject(
    FIXTURE_IDS.greetingProject,
    'Fixture Greeting (бриф без сессии)',
    'Анна',
  );
  const greetingDrafting = await seedGreetingProject(
    FIXTURE_IDS.greetingDraftingProject,
    'Fixture Greeting (сессия без сценария)',
    'Борис',
  );
  const greetingReady = await seedGreetingProject(
    FIXTURE_IDS.greetingReadyProject,
    'Fixture Greeting (сценарий собран)',
    'Вера',
  );

  const seedGreetingSession = async (
    id: string,
    projectId: string,
    brief: Parameters<typeof greetingBriefSnapshotFrom>[0],
    withPrompt: boolean,
    note: string,
  ) => {
    const fields = {
      userId: user.id,
      projectId,
      // Товара у поздравления нет: это проект 1:1 к брифу, а не к
      // списку карточек. `productItemId` остаётся пустым намеренно.
      productItemId: null,
      status: withPrompt
        ? SessionStatus.PROMPT_GENERATED
        : SessionStatus.CREATED,
      generationStatus: null,
      data: {
        locale: 'ru',
        greetingBriefSnapshot: greetingBriefSnapshotFrom(brief),
        ...(withPrompt ? { generationPrompt: approvedPrompt(id) } : {}),
      },
      liveData: {},
    };
    await prisma.session.upsert({
      where: { id },
      update: fields,
      create: { id, ...fields },
    });
    log.push(`${note}: ${id}`);
  };

  await seedGreetingSession(
    FIXTURE_IDS.greetingDraftingSession,
    greetingDrafting.projectId,
    greetingDrafting.brief,
    false,
    'Сессия поздравления без сценария (кнопка «собрать сценарий»)',
  );
  await seedGreetingSession(
    FIXTURE_IDS.greetingReadySession,
    greetingReady.projectId,
    greetingReady.brief,
    true,
    'Сессия поздравления со сценарием (все девять карточек)',
  );

  log.push('Готово: фикстурные данные заведены/обновлены.');

  return {
    userId: user.id,
    telegramId,
    manifestId: manifest.id,
    characterId: character.id,
    projectId: project.id,
    itemId: item.id,
    sessionId: FIXTURE_IDS.session,
    promptPendingSessionId: FIXTURE_IDS.sessionPromptPending,
    readyToRenderSessionId: FIXTURE_IDS.sessionReadyToRender,
    clientSiteProjectId: clientSiteProject.id,
    greetingProjectId: greetingFresh.projectId,
    greetingDraftingProjectId: greetingDrafting.projectId,
    greetingReadyProjectId: greetingReady.projectId,
    log,
  };
}
