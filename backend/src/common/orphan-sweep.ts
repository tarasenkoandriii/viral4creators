/**
 * Подметатель осиротевших файлов (doc/STORAGE-AUDIT.md, этап 27).
 *
 * Зачем он нужен, если уборка сессий уже удаляет их файлы: во-первых,
 * файлы сессий, истёкших ДО этапа 26, привязать больше не к чему —
 * строк нет, путей взять неоткуда; во-вторых, любой будущий сбой уборки
 * (упавшая функция, новый вид файла, забытый в blob-paths.ts) оставит
 * мусор, и лучше иметь регулярную метлу, чем узнать об этом по счёту.
 *
 * Решение о удалении принимает эта чистая функция, а не код, который
 * ходит в сеть: правило «сирота = префикс сессии, которой нет в БД, и
 * файл старше порога» должно быть видно и проверяемо целиком.
 */

/**
 * ## Этап 41: метла ходит не только по сессиям (Б-1.1, Б-1.2)
 *
 * До этого метла знала один префикс — `sessions/`. Этого хватало ровно
 * до тех пор, пока файлы других владельцев удалялись их собственными
 * сервисами. Два места, где это перестало работать:
 *
 *   - каскад `users → projects → product_items` и
 *     `users → brand_manifests` (этап 40) сносит строки в обход
 *     `ProjectService.deleteProject` и `BrandManifestService.remove` с их
 *     уборкой блобов. Хуже того, после каскада пути взять уже неоткуда:
 *     раньше (`SET NULL`) осиротевшую строку можно было хотя бы найти;
 *   - копия ролика заявки на публикацию (`publications/<id>/video.mp4`,
 *     этап 39) удалялась только при отзыве PENDING.
 *
 * Поэтому владелец файла определяется по префиксу, а живость проверяется
 * в своей таблице. Префикс `library/` в метлу сознательно не включён:
 * его каталог — это `sourceKey` с заменённым двоеточием, обратное
 * преобразование неоднозначно, и ошибка здесь означала бы удаление
 * обложек у живых записей.
 *
 * ## Этап 76 (шестой аудит, Е-5.2): `users/` — пятая область
 *
 * `UserVoicesService.createUploadUrl` (клонирование голоса, этап 73)
 * минтит presigned PUT на `users/<userId>/voices/<voiceId>/sample.<ext>`
 * ДО того, как появляется строка `UserVoice` (та создаётся только в
 * `confirmClone`) — до этой правки `users/` не входил ни в одну функцию
 * очистки вообще, и незавершённая (или проваленная после загрузки)
 * попытка клонирования оставляла файл вечным сиротой без единого
 * механизма подбора. `ownerIdOf` уже универсальна по паттерну
 * `<префикс>/<id>/…` — здесь `<id>` это `userId`, тот же приём, что у
 * остальных четырёх областей (владелец = верхний сегмент пути, живость
 * = таблица владельца). Одно ограничение честности: `User.userVoices`
 * каскадится при удалении пользователя (`onDelete: Cascade`), так что
 * эта метла подбирает файлы удалённых пользователей — а «загрузил и не
 * дошёл до confirmClone» для ВСЁ ЕЩЁ живого пользователя останется, раз
 * владелец (сам пользователь) жив; аудит отдельно предлагал и второй
 * путь (TTL на неподтверждённый presigned-путь) — не реализован в этом
 * проходе, эта метла и так закрывает саму находку (полное отсутствие
 * ЛЮБОГО механизма для префикса).
 */
export const SWEEP_SCOPES = [
  'sessions',
  'projects',
  'brand-manifests',
  'publications',
  'shared-videos',
  'users',
] as const;

export type SweepScope = (typeof SWEEP_SCOPES)[number];

/** Префикс листинга для каждой области. */
export const SWEEP_PREFIX: Record<SweepScope, string> = {
  sessions: 'sessions/',
  projects: 'projects/',
  'brand-manifests': 'brand-manifests/',
  publications: 'publications/',
  'shared-videos': 'shared-videos/',
  users: 'users/',
};

export interface BlobRef {
  pathname: string;
  uploadedAt: Date;
}

export interface SweepPlan {
  /** Что удалять. */
  delete: string[];
  /** Id владельцев, встреченных в путях (для отчёта). */
  ownerIds: string[];
  /** Пропущено, потому что файл слишком свежий (возможна гонка с созданием). */
  skippedTooNew: number;
  /** Пропущено, потому что путь не разобрался в `<префикс>/<id>/…`. */
  skippedUnknown: number;
  /** Сколько владельцев-сирот встретилось (у скольких файлы под удаление). */
  orphanOwners: number;
  /**
   * Разбивка удаляемого по видам файлов — по ней видно, ЧТО именно
   * утекает: если растёт `generated`, значит уборка сессий не отработала;
   * если `previews` — сбой на другом шаге (этап 29, детальная статистика).
   */
  byKind: Record<SweepFileKind, number>;
  /** Байты не считаем — листинг их не всегда даёт; считаем файлы. */
  oldestUploadedAt: string | null;
}

/** Виды файлов — для читаемой статистики уборки. */
export type SweepFileKind =
  | 'generated'
  | 'original'
  | 'previews'
  | 'characters'
  | 'scenes'
  | 'photo'
  | 'voice'
  | 'video'
  | 'other';

export const EMPTY_KINDS: Record<SweepFileKind, number> = {
  generated: 0,
  original: 0,
  previews: 0,
  characters: 0,
  scenes: 0,
  photo: 0,
  voice: 0,
  video: 0,
  other: 0,
};

export function sweepFileKind(
  pathname: string,
  scope: SweepScope = 'sessions',
): SweepFileKind {
  const rest = pathname.replace(
    new RegExp(`^${SWEEP_PREFIX[scope]}[^/]+/`),
    '',
  );
  switch (scope) {
    case 'sessions':
      if (rest.startsWith('generated')) return 'generated';
      if (rest.startsWith('original')) return 'original';
      if (rest.startsWith('previews/')) return 'previews';
      if (rest.startsWith('characters/')) return 'characters';
      if (rest.startsWith('scenes/')) return 'scenes';
      return 'other';
    case 'projects': {
      // `projects/<projectId>/items/<itemId>/photo.jpg` — фото товара,
      // `…/voice-<ts>.webm` — надиктованное описание.
      const file = rest.split('/').pop() ?? '';
      if (file.startsWith('photo')) return 'photo';
      if (file.startsWith('voice')) return 'voice';
      return 'other';
    }
    case 'brand-manifests':
      if (rest.startsWith('characters/')) return 'characters';
      if (rest.startsWith('scenes/')) return 'scenes';
      return 'other';
    case 'publications':
      return rest.startsWith('video') ? 'video' : 'other';
    case 'shared-videos': {
      // `shared-videos/<id>/video.mp4` — своя копия ролика;
      // `shared-videos/<id>/photo.<ext>` — своя копия фото товара (для OG).
      const file = rest.split('/').pop() ?? '';
      if (file.startsWith('video')) return 'video';
      if (file.startsWith('photo')) return 'photo';
      return 'other';
    }
    case 'users':
      // `users/<userId>/voices/<voiceId>/sample.<ext>` (этап 73/76) —
      // единственный вид файла под этим префиксом сегодня.
      return rest.startsWith('voices/') ? 'voice' : 'other';
  }
}

/** `<префикс>/<id>/что-угодно` → id; всё остальное → null. */
export function ownerIdOf(
  pathname: string,
  scope: SweepScope = 'sessions',
): string | null {
  const m = pathname.match(new RegExp(`^${SWEEP_PREFIX[scope]}([^/]+)/`));
  return m ? m[1] : null;
}

/** Прежнее имя — оставлено, чтобы не переписывать вызовы про сессии. */
export function sessionIdOf(pathname: string): string | null {
  return ownerIdOf(pathname, 'sessions');
}

/**
 * @param blobs      что вернул листинг хранилища по префиксу области
 * @param liveIds    id владельцев, которые ЕСТЬ в базе (сессии, проекты,
 *                   манифесты, заявки — в зависимости от `scope`)
 * @param now        точка отсчёта возраста
 * @param minAgeMs   файл младше порога не трогаем: он мог быть загружен
 *                   секунду назад к владельцу, которого мы не увидели в
 *                   выборке (страховка от гонки, не от ошибки)
 * @param scope      область; по умолчанию сессии — прежнее поведение
 */
export function orphanSweepPlan(
  blobs: BlobRef[],
  liveIds: Iterable<string>,
  now: Date,
  minAgeMs: number,
  scope: SweepScope = 'sessions',
): SweepPlan {
  const live = new Set(liveIds);
  const plan: SweepPlan = {
    delete: [],
    ownerIds: [],
    skippedTooNew: 0,
    skippedUnknown: 0,
    orphanOwners: 0,
    byKind: { ...EMPTY_KINDS },
    oldestUploadedAt: null,
  };
  const seen = new Set<string>();
  const orphans = new Set<string>();
  for (const blob of blobs) {
    const id = ownerIdOf(blob.pathname, scope);
    if (!id) {
      plan.skippedUnknown += 1;
      continue;
    }
    if (!seen.has(id)) {
      seen.add(id);
      plan.ownerIds.push(id);
    }
    if (live.has(id)) continue;
    if (now.getTime() - blob.uploadedAt.getTime() < minAgeMs) {
      plan.skippedTooNew += 1;
      continue;
    }
    orphans.add(id);
    plan.delete.push(blob.pathname);
    plan.byKind[sweepFileKind(blob.pathname, scope)] += 1;
    if (
      !plan.oldestUploadedAt ||
      blob.uploadedAt.toISOString() < plan.oldestUploadedAt
    ) {
      plan.oldestUploadedAt = blob.uploadedAt.toISOString();
    }
  }
  plan.orphanOwners = orphans.size;
  return plan;
}
