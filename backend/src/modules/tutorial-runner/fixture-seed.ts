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
import { SessionStatus } from '../../common/types/session.types';
import { DEFAULT_VOICE_MODE } from '../../common/voice-mode';

export const FIXTURE_IDS = {
  manifest: 'fixture-tutorial-manifest',
  character: 'fixture-tutorial-character',
  project: 'fixture-tutorial-project',
  item: 'fixture-tutorial-item',
  session: 'fixture-tutorial-session',
  generatedVideo: 'fixture-tutorial-generated-video',
  /** Проект ТРЕТЬЕГО типа (`CLIENT_SITE`) — отдельный от рекламного, а
   *  не тот же самый: у `CLIENT_SITE` нет товаров, всё специфичное живёт
   *  в `ClientSiteTutorialDraft`. Заведён этапом G ТЗ
   *  `docs-tz/TZ-Enterprise-Tutorial-Landing.md`, чтобы маршрут
   *  `site-tutorial` было на чём резолвить. */
  clientSiteProject: 'fixture-tutorial-client-site-project',
} as const;

export interface FixtureSeedResult {
  userId: string;
  telegramId: string;
  manifestId: string;
  characterId: string;
  projectId: string;
  itemId: string;
  sessionId: string;
  clientSiteProjectId: string;
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

  const sessionData = {
    locale: 'ru',
    productInformation: {
      title: item.title,
      description: item.description,
    },
  };
  // Этап 122: готовый ролик живёт во второй колонке — так же, как его
  // пишет `SessionService.updateSession`. Положить его в `data` значило
  // бы завести фикстуру в раскладке, которой в проде не бывает: экраны
  // постпрода и админки читают `liveData`, и регрессионный обход снимал
  // бы пустой экран, ничего при этом не заметив.
  const sessionLiveData = { generatedVideo };

  await prisma.session.upsert({
    where: { id: FIXTURE_IDS.session },
    update: {
      userId: user.id,
      projectId: project.id,
      productItemId: item.id,
      status: SessionStatus.VIDEO_COMPLETE,
      generationStatus: GenerationStatus.COMPLETE,
      data: sessionData,
      liveData: sessionLiveData,
    },
    create: {
      id: FIXTURE_IDS.session,
      userId: user.id,
      projectId: project.id,
      productItemId: item.id,
      status: SessionStatus.VIDEO_COMPLETE,
      generationStatus: GenerationStatus.COMPLETE,
      data: sessionData,
      liveData: sessionLiveData,
    },
  });
  log.push(`Сессия с готовым роликом: ${FIXTURE_IDS.session}`);
  log.push('Готово: фикстурные данные заведены/обновлены.');

  return {
    userId: user.id,
    telegramId,
    manifestId: manifest.id,
    characterId: character.id,
    projectId: project.id,
    itemId: item.id,
    sessionId: FIXTURE_IDS.session,
    clientSiteProjectId: clientSiteProject.id,
    log,
  };
}
