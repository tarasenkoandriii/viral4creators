/**
 * Какие файлы в Vercel Blob принадлежат сессии — doc/STORAGE-AUDIT.md
 * (этап 26). Чистая функция: её единственная задача — перечислить пути,
 * чтобы TTL-уборка удаляла ровно то, что удаляет удаление сессии, и
 * ничего сверх того.
 *
 * Почему это отдельный файл, а не метод сервиса: список путей должен
 * читаться и тестироваться целиком, в одном месте. Каждый новый вид файла
 * в сессии обязан появиться здесь — иначе он утечёт в хранилище навсегда
 * (ровно этот дефект этап 26 и чинит).
 */

import { Session } from './types/session.types';
import { VideoSourceType } from './types/video.types';

/**
 * Все блобы, за которые отвечает сессия. Пути, живущие вне её префикса
 * (фото товара в `projects/…`, фото персонажа бренда в
 * `brand-manifests/…`), сюда НЕ входят: они переживают сессию по смыслу —
 * это данные проекта и манифеста, а не прогона.
 */
export function sessionBlobPathnames(session: Session): string[] {
  const paths = new Set<string>();
  const prefix = `sessions/${session.sessionId}/`;

  // Транзитная копия референса. В норме её удаляет сам анализ, но если
  // он упал между загрузкой и удалением — файл остаётся за сессией.
  const video = session.originalVideo;
  if (video && video.sourceType === VideoSourceType.UPLOAD) {
    paths.add(video.blobPathname);
  }

  // Готовый ролик (§7): единственный по-настоящему тяжёлый файл сессии.
  if (session.generatedVideo?.pathname) {
    paths.add(session.generatedVideo.pathname);
  }
  // Результат постобработки (§15.4/§16.1, этапы 34–35) — второй тяжёлый
  // файл, если кадр обрезали или накладывали свою дорожку. Без этой
  // строки он утёк бы: ровно тот дефект, который чинил этап 26.
  if (session.generatedVideo?.postPathname) {
    paths.add(session.generatedVideo.postPathname);
  }
  // Синтезированная дорожка (§15.3, этап 35) — маленькая, но своя.
  if (session.generatedVideo?.voiceoverPathname) {
    paths.add(session.generatedVideo.voiceoverPathname);
  }
  // Автоэкспорт под площадки, ярус A (TODO §III, п.35, этап 75) — файлы
  // дешёвой обрезки лежат в том же префиксе сессии
  // (`sessions/{id}/export-*.mp4`, см. `PostProductionService.pollExport`).
  // Без этой строки удаление сессии оставило бы их немедленным сиротой
  // до следующего прохода метлы — тот же класс дефекта, что этот файл
  // существует чинить (см. доккомментарий вверху).
  for (const v of session.generatedVideo?.exportVariants ?? []) {
    if (v.pathname) paths.add(v.pathname);
  }
  // Жёстко вшитые субтитры основного пайплайна (§46, этап 67) — `.srt`
  // лежит в префиксе сессии рядом с самим роликом (Е-2.6 шестого аудита:
  // раньше отсутствовал здесь — смягчено суточной меткой «метлы», но
  // инвариант доккомментария этого файла был неточным).
  if (session.generatedVideo?.subtitlePathname) {
    paths.add(session.generatedVideo.subtitlePathname);
  }
  // Текст-карточки промпта (`text-card.service.ts`, `sessions/<id>/
  // text-card-<role>.png`) — М-5.8 седьмого аудита, тот же класс, что
  // Е-2.6: путь хранится в `generationPrompt.onScreenTextMoments[]`.
  for (const m of session.generationPrompt?.onScreenTextMoments ?? []) {
    if (m.cardPathname) paths.add(m.cardPathname);
  }

  // Прошлые попытки (`videoHistory`, М-2.1/М-5.1 седьмого аудита): у
  // каждой свой `generated-<uuid>.mp4` плюс те же производные, что у
  // текущей — без этого цикла они жили бы в Blob до суточной метлы
  // после удаления строки, как сироты без ссылки из БД.
  for (const past of session.videoHistory ?? []) {
    if (past.pathname) paths.add(past.pathname);
    if (past.postPathname) paths.add(past.postPathname);
    if (past.voiceoverPathname) paths.add(past.voiceoverPathname);
    if (past.subtitlePathname) paths.add(past.subtitlePathname);
    for (const v of past.exportVariants ?? []) {
      if (v.pathname) paths.add(v.pathname);
    }
  }

  // Пилот говорящего аватара (этап 72, `doc/AVATAR-LIPSYNC-PIPELINE-SPEC.md`)
  // — четыре файла того же префикса сессии (Е-2.6 шестого аудита, тот же
  // повод, что у subtitlePathname выше). `voiceoverPathname` — уже путь;
  // `renderedUrl`/`downloadUrl` — публичные ссылки на свой Blob, приводим
  // к пути тем же `pathnameFromBlobUrl`, что `itemPhotoPathname` ниже
  // (без субтитров `downloadUrl === renderedUrl` — `Set` не даст дубля).
  if (session.avatarVideo) {
    paths.add(session.avatarVideo.voiceoverPathname);
    const rendered = pathnameFromBlobUrl(
      session.avatarVideo.renderedUrl,
      prefix,
    );
    if (rendered) paths.add(rendered);
    const download = pathnameFromBlobUrl(
      session.avatarVideo.downloadUrl,
      prefix,
    );
    if (download) paths.add(download);
    if (session.avatarVideo.subtitlePathname) {
      paths.add(session.avatarVideo.subtitlePathname);
    }
  }

  // Фото товара, загруженное ПРЯМО В СЕССИЮ (§9): у быстрой генерации
  // без проекта другого владельца нет. У сессии из товара путь ведёт в
  // `projects/…` — там владелец товар, и фильтр по префиксу ниже его
  // отсечёт сам (этап 39, А-2.14).
  if (session.productInformation?.productImagePathname) {
    paths.add(session.productInformation.productImagePathname);
  }

  // Кадры-превью персонажей, сцен и массовки (§18.1/§19).
  for (const c of session.videoAnalysis?.characters ?? []) {
    if (c.previewUrl) paths.add(`${prefix}previews/character-${c.id}.jpg`);
  }
  for (const s of session.videoAnalysis?.scenes ?? []) {
    if (s.previewUrl) paths.add(`${prefix}previews/scene-${s.id}.jpg`);
  }
  for (const e of session.videoAnalysis?.extras ?? []) {
    if (e.previewUrl) paths.add(`${prefix}previews/extra-${e.id}.jpg`);
  }

  // Фото-замены персонажей — «новый скин» (§10.2). У замены из манифеста
  // photoPathname пуст: тот файл принадлежит бренду, не сессии.
  for (const cast of session.characterCasting?.casts ?? []) {
    const p = cast.replacement?.photoPathname;
    if (p) paths.add(p);
  }

  // Загруженные сцены (§17).
  for (const scene of session.scenes ?? []) {
    if (scene.photoPathname) paths.add(scene.photoPathname);
  }

  // Референс-кадры поздравления (`sessions/<id>/greeting-refs/…`) —
  // и загруженные человеком, и нарисованные фичей №6. Отсутствовали
  // здесь с самого появления `greetingReferenceImages`: ровно тот класс
  // дефекта, ради которого этот файл существует (см. доккомментарий
  // вверху — «каждый новый вид файла в сессии обязан появиться здесь»).
  // Суточная метла по осиротевшим файлам их подбирала, но инвариант
  // «удаление сессии удаляет её файлы» держался не до конца.
  //
  // Применённый скетч (`sketch.pathname`) сюда НЕ добавляется намеренно:
  // он живёт в `sketches/…`, вне префикса сессии, и у него своя
  // жизнь — фильтр по префиксу внизу отсёк бы его в любом случае.
  for (const ref of session.greetingReferenceImages ?? []) {
    if (ref.photoPathname) paths.add(ref.photoPathname);
  }

  // Музыкальная подложка, загруженная пользователем
  // (`sessions/<id>/music/…`, фича №4). Тема из каталога платформы
  // сюда не попадает и не должна: она общая, одна на всех, и удаление
  // одной сессии не вправе её тронуть — отличает их `source`.
  const music = session.greetingBriefSnapshot?.musicTheme;
  // `upload` — файл человека, `library` — трек, скачанный нами из
  // библиотеки со свободной лицензией: оба лежат под префиксом сессии
  // и принадлежат ей. `catalog` и `link` — чужие: первый общий для
  // всех, второй вообще не у нас.
  if (
    (music?.source === 'upload' || music?.source === 'library') &&
    music.pathname
  ) {
    paths.add(music.pathname);
  }

  // Наклейка (фича №8) всегда наша копия: условия Pixabay запрещают
  // постоянный хотлинк, поэтому файл скачивается к нам и живёт под
  // префиксом сессии — значит и удаляется вместе с ней.
  const sticker = session.greetingBriefSnapshot?.sticker;
  if (sticker?.pathname) paths.add(sticker.pathname);

  // Защита от чужих путей: сессия не вправе удалить файл вне своего
  // префикса, даже если он как-то попал в её данные.
  return [...paths].filter((p) => p.startsWith(prefix));
}

/**
 * Публичный URL блоба → путь, но только если он начинается с ожидаемого
 * префикса. Префикс обязателен: удаление по пути, пришедшему из данных,
 * без проверки — это способ снести чужой файл, подсунув «свой» URL.
 */
export function pathnameFromBlobUrl(
  url: string | null | undefined,
  prefix: string,
): string | null {
  if (!url) return null;
  try {
    const path = decodeURIComponent(new URL(url).pathname.replace(/^\/+/, ''));
    return path.startsWith(prefix) ? path : null;
  } catch {
    return null;
  }
}

/** Путь фото товара, выведенный из публичного URL (`projects/…/photo.jpg`). */
export function itemPhotoPathname(photoUrl: string | null): string | null {
  return pathnameFromBlobUrl(photoUrl, 'projects/');
}

/** Пути, которые библиотека держит под своим префиксом для одной записи (§21, этап 26). */
export function libraryEntryPathnames(
  sourceKey: string,
  analysis: {
    characters?: Array<{ previewUrl?: string | null }>;
    scenes?: Array<{ previewUrl?: string | null }>;
    extras?: Array<{ previewUrl?: string | null }>;
  } | null,
): string[] {
  const prefix = `library/${sourceKey.replace(':', '-')}/`;
  const urls = [
    ...(analysis?.characters ?? []),
    ...(analysis?.scenes ?? []),
    ...(analysis?.extras ?? []),
  ].map((x) => x.previewUrl ?? null);
  return [
    ...new Set(
      urls
        .map((u) => pathnameFromBlobUrl(u, prefix))
        .filter((p): p is string => !!p),
    ),
  ];
}
