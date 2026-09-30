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
  // Кадры-транзиты сборки роликов обучалки (сквозной аудит 29.09.2026).
  //
  // У них своя уборка — `wipeScenarioFrames` по префиксу актива, — и
  // она зовётся в пяти местах. Но любой единичный сбой (икота Blob
  // после `complete`, смерть функции между заливкой кадров и `submit`,
  // проигрыш в гонке подметальщика) оставляет до тридцати PNG, а через
  // несколько ночей `sweepOldAssets` удаляет строку — единственный
  // носитель `assetId`. После этого имена файлов не восстановить
  // никому, и они лежат платно навсегда. Доккомментарий раннера это
  // признавал («подметальщика по префиксу в проекте нет»), но выводил
  // из этого только необходимость заводить строку первой — случай
  // «строку завели, а уборка всё равно не прошла» не рассматривался.
  'tutorial-video-frames',
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
  'tutorial-video-frames': 'tutorial-video-frames/',
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
  /** Вложение находки тестировщика (аудит этапа 157). */
  | 'attachment'
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
  attachment: 0,
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
      if (isTransientVoiceRecording(pathname, scope)) return 'voice';
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
      if (isTransientVoiceRecording(pathname, scope)) return 'voice';
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
      // `users/<userId>/voices/<voiceId>/sample.<ext>` (этап 73/76) и
      // `users/<userId>/tickets/<ts>-<i>.<ext>` — вложения находок
      // тестировщика (аудит этапа 157). Своего префикса у них нет
      // намеренно: метла обходит закрытый список областей, и файлы под
      // `test-tickets/` не подбирал бы никто.
      if (rest.startsWith('voices/')) return 'voice';
      return rest.startsWith('tickets/') ? 'attachment' : 'other';
    case 'tutorial-video-frames':
      // `tutorial-video-frames/<assetId>/<номер шага>.png` — кадр
      // слайд-шоу; `…/captions.ass` — подписи. Всё под префиксом
      // транзитное: готовый ролик живёт в `tutorial-videos/`.
      return rest.endsWith('.png') ? 'previews' : 'other';
  }
}

/**
 * Транзитные голосовые записи (аудит волны K, 29.09.2026): реплика
 * мастера поздравления (`sessions/<id>/voice-<ts>.<ext>`, K2/K3), реплика
 * брифа до сессии (`projects/<id>/greeting-voice-<ts>.<ext>`, K3) и
 * диктовка описания товара (`projects/<id>/items/<id>/voice-<ts>.<ext>`).
 *
 * Их удаляет `finally` обработки — но только если обработка БЫЛА:
 * клиент, получивший ссылку и загрузивший файл, но не позвавший
 * расшифровку (закрыл вкладку, упала сеть), оставлял запись навсегда —
 * владелец жив, и метла сирот её не трогала. Условия (3.4) обещают, что
 * звук не хранится, поэтому такие файлы удаляются по возрасту, ЖИВ
 * владелец или нет. Час — с запасом больше любой обработки (минуты).
 *
 * С финального аудита ветки K (30.09.2026) это правило — СТРАХОВКА:
 * основную уборку в пределах часа делает крон `voice-uploads-sweep` по
 * строкам учёта `VoiceUpload` (`VoiceUploadService`) — суточная метла
 * ходит по листингу всего префикса и до голосовых файлов на объёме не
 * доходит. Правило остаётся для записей, выданных до учёта, и на случай
 * сбоя учёта; порог возраста у обоих один — эта константа.
 *
 * Клоны голоса (`users/<id>/voices/…`) и озвучка роликов (`voiceover…`)
 * сюда не попадают: это не транзит, а данные человека.
 */
export const VOICE_RECORDING_MAX_AGE_MS = 60 * 60 * 1000;

const TRANSIENT_VOICE: Partial<Record<SweepScope, readonly RegExp[]>> = {
  sessions: [/^sessions\/[^/]+\/voice-\d+\.[a-z0-9]+$/],
  projects: [
    /^projects\/[^/]+\/greeting-voice-\d+\.[a-z0-9]+$/,
    /^projects\/[^/]+\/items\/[^/]+\/voice-\d+\.[a-z0-9]+$/,
  ],
};

export function isTransientVoiceRecording(
  pathname: string,
  scope: SweepScope,
): boolean {
  return (TRANSIENT_VOICE[scope] ?? []).some((re) => re.test(pathname));
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
  const markDelete = (blob: BlobRef) => {
    plan.delete.push(blob.pathname);
    plan.byKind[sweepFileKind(blob.pathname, scope)] += 1;
    if (
      !plan.oldestUploadedAt ||
      blob.uploadedAt.toISOString() < plan.oldestUploadedAt
    ) {
      plan.oldestUploadedAt = blob.uploadedAt.toISOString();
    }
  };
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
    const age = now.getTime() - blob.uploadedAt.getTime();
    // Транзитная голосовая запись старше часа — удаляется и у живого
    // владельца (см. `isTransientVoiceRecording`). Владелец сиротой не
    // считается: он жив, просто запись не дошла до обработки.
    if (
      isTransientVoiceRecording(blob.pathname, scope) &&
      age >= VOICE_RECORDING_MAX_AGE_MS
    ) {
      markDelete(blob);
      continue;
    }
    if (live.has(id)) continue;
    if (age < minAgeMs) {
      plan.skippedTooNew += 1;
      continue;
    }
    orphans.add(id);
    markDelete(blob);
  }
  plan.orphanOwners = orphans.size;
  return plan;
}
