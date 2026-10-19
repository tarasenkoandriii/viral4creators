/**
 * «Образ для сказок» в профиле рассказчика (Story‑Tales, TODO стр. 79,
 * WP5) — чистая логика блока: подписи, цена и квота, что можно нажать
 * и почему нельзя. Без React — проверяется `scripts/narrator-looks.test.ts`.
 *
 * Сервер — единственный источник правды (согласие, режим, квота, цена,
 * пригодность варианта); здесь только объяснение человеку и выбор кнопки.
 * Тексты по-русски, как во всём закрытом разделе Story.
 */

export type NarratorMode =
  | 'photo'
  | 'pencil'
  | 'lineart'
  | 'flat'
  | 'watercolor'
  | 'cartoon';

export type NarratorLookProblem =
  | 'deleted'
  | 'not-ready'
  | 'consent'
  | 'character-changed'
  | 'source-changed'
  | 'asset-missing'
  | 'mode-mismatch';

export interface NarratorLookItem {
  id: string;
  parentLookId: string | null;
  characterId: string;
  outfit: string;
  makeup: string;
  status: string;
  styleStatus: string;
  style: Exclude<NarratorMode, 'photo'> | null;
  sourceHash: string;
  photoHash: string | null;
  styledHash: string | null;
  consentVersion: string;
  imageCalls: number;
  reservedMicroUsd: number;
  error: string | null;
  createdAt: string;
  active: boolean;
  problem: NarratorLookProblem | null;
}

export interface NarratorLookPrice {
  perCall: Array<{ model: string; estimateMicroUsd: number }>;
  estimateMicroUsd: number;
  reserveMicroUsd: number;
}

export interface NarratorLooksState {
  manifestId: string;
  consent: {
    version: string;
    text: string;
    active: boolean;
    acceptedAt: string | null;
    acceptedVersion: string | null;
    revokedAt: string | null;
  };
  character: null | {
    id: string;
    label: string;
    hasPhoto: boolean;
    originalDeleted: boolean;
    mode: NarratorMode;
    sketchRendering: 'realistic' | 'stylized' | null;
  };
  active: {
    kind: 'original' | 'variant';
    lookId: string | null;
    asset: 'photo' | 'styled' | null;
    mode: NarratorMode;
    problem: NarratorLookProblem | null;
    modeChanged: boolean;
  };
  presets: { outfits: readonly string[]; makeups: readonly string[] };
  quota: {
    dayUsed: number;
    dayLimit: number;
    monthUsed: number;
    monthLimit: number;
  };
  price: {
    create: NarratorLookPrice | null;
    restyle: NarratorLookPrice | null;
  };
  items: NarratorLookItem[];
}

export const OUTFIT_LABEL: Record<string, string> = {
  casual: 'Повседневная',
  'cozy-home': 'Домашняя уютная',
  festive: 'Праздничная',
  business: 'Деловая',
  winter: 'Зимняя',
};

export const MAKEUP_LABEL: Record<string, string> = {
  none: 'без макияжа',
  light: 'лёгкий макияж',
  natural: 'натуральный макияж',
};

export const MODE_LABEL: Record<NarratorMode, string> = {
  photo: 'фото',
  pencil: 'скетч «карандаш»',
  lineart: 'скетч «линии»',
  flat: 'скетч «flat»',
  watercolor: 'скетч «акварель»',
  cartoon: 'цветной мультяшный',
};

export const PROBLEM_TEXT: Record<NarratorLookProblem, string> = {
  deleted: 'Вариант удалён.',
  'not-ready':
    'Вариант не готов: генерация не завершилась успешно — повторите её явно или выберите другой вариант.',
  consent:
    'Согласие на синтетический образ отозвано или дано заново после создания — вариант недоступен для новых рендеров.',
  'character-changed': 'Вариант сделан для другого персонажа-рассказчика.',
  'source-changed': 'Фото рассказчика заменено после создания варианта.',
  'asset-missing': 'Изображение для этого режима не готово.',
  'mode-mismatch': 'Вариант сделан в другом режиме — нужна перестилизация.',
};

/**
 * Человеческие названия редакций согласия (S3‑7): внутренний код версии
 * (`story-parent-image-v1`) в тексте интерфейса не показывается.
 */
export const CONSENT_TITLE: Record<string, string> = {
  'story-parent-image-v1': 'версия 1',
};
export function consentTitle(version: string | null | undefined): string {
  return (version && CONSENT_TITLE[version]) || 'текущая редакция';
}

/** Пути API блока (все под гардом владельца Story). */
export function narratorLooksPath(manifestId: string, suffix = ''): string {
  return `/brand-manifests/${encodeURIComponent(manifestId)}/narrator-looks${suffix}`;
}

/**
 * Превью варианта: JSON `{ base64, mime, hash }`, а слишком большое для
 * JSON (413 `NARRATOR_LOOK_IMAGE_TOO_LARGE`) — бинарно через `…/image/raw`.
 */
export function narratorLookImagePath(
  manifestId: string,
  lookId: string,
  asset: 'photo' | 'styled',
  raw = false
): string {
  return narratorLooksPath(
    manifestId,
    `/${encodeURIComponent(lookId)}/image${raw ? '/raw' : ''}?asset=${asset}`
  );
}
export function isImageTooLarge(error: unknown): boolean {
  const r = (
    error as {
      response?: {
        status?: number;
        data?: { error?: { details?: { code?: string } } };
      };
    } | null
  )?.response;
  return (
    r?.status === 413 ||
    r?.data?.error?.details?.code === 'NARRATOR_LOOK_IMAGE_TOO_LARGE'
  );
}

/** 404 — блок не для этого пользователя (Story закрыта): не показываем. */
export function isHiddenForUser(error: unknown): boolean {
  return (
    (error as { response?: { status?: number } } | null)?.response?.status ===
    404
  );
}

export function formatUsd(micro: number): string {
  const usd = Math.max(0, micro) / 1_000_000;
  return `$${usd < 0.1 ? usd.toFixed(3) : usd.toFixed(2)}`;
}

export function modeLabel(mode: NarratorMode): string {
  return MODE_LABEL[mode] ?? mode;
}

export function lookTitle(item: Pick<NarratorLookItem, 'outfit' | 'makeup'>) {
  return `${OUTFIT_LABEL[item.outfit] ?? item.outfit} · ${
    MAKEUP_LABEL[item.makeup] ?? item.makeup
  }`;
}

/** Активный образ = (оригинал | вариант) × (фото | стиль). */
export function activeLabel(state: NarratorLooksState): string {
  const mode = modeLabel(state.active.mode);
  if (state.active.kind === 'original') return `Оригинал × ${mode}`;
  const item = state.items.find((i) => i.id === state.active.lookId);
  return `Вариант «${item ? lookTitle(item) : 'удалён'}» × ${mode}`;
}

export function quotaLine(q: NarratorLooksState['quota']): string {
  return `Генераций сегодня: ${q.dayUsed} из ${q.dayLimit} · в месяце: ${q.monthUsed} из ${q.monthLimit}`;
}

function callsOf(price: NarratorLookPrice | null): number {
  return price?.perCall.length ?? 0;
}

/** Что сохранится из режима при новом варианте — подсказка под кнопкой. */
export function modeKeepNote(state: NarratorLooksState): string {
  const mode = state.character?.mode ?? 'photo';
  if (mode === 'photo') {
    return 'Режим «фото»: вариант — одно фото с новой одеждой (1 вызов модели).';
  }
  return `Режим «${modeLabel(mode)}» сохранится: новое фото сразу пройдёт тот же стиль (2 вызова модели). Лицо в скетче меняется по общим правилам персонажа брендбука.`;
}

export interface GenerationOffer {
  calls: number;
  reserveMicroUsd: number;
  priceLine: string;
  /** Такой же готовый вариант уже есть — сервер вернёт его без оплаты. */
  existing: NarratorLookItem | null;
  /** Почему кнопка выключена; `null` — можно. */
  disabledReason: string | null;
}

export function generationOffer(
  state: NarratorLooksState,
  outfit: string,
  makeup: string
): GenerationOffer {
  const price = state.price.create;
  const calls = callsOf(price);
  const mode = state.character?.mode ?? 'photo';
  const existing =
    state.items.find(
      (i) =>
        i.status === 'READY' &&
        i.outfit === outfit &&
        i.makeup === makeup &&
        i.characterId === state.character?.id &&
        !i.parentLookId &&
        (mode === 'photo' ? i.style === null : i.style === mode) &&
        i.problem === null
    ) ?? null;
  const q = state.quota;
  let disabledReason: string | null = null;
  if (!state.consent.active)
    disabledReason = 'Сначала подтвердите согласие на синтетический образ.';
  else if (!state.character)
    disabledReason = 'Выберите персонажа-рассказчика и сохраните профиль.';
  else if (!state.character.hasPhoto)
    disabledReason =
      'Нужно оригинальное фото рассказчика: варианты делаются только из него.';
  else if (!price)
    disabledReason = 'Нет ставки модели изображений — генерация выключена.';
  else if (state.items.some((i) => i.status === 'PENDING'))
    disabledReason = 'Вариант уже генерируется — дождитесь результата.';
  else if (
    !existing &&
    (q.dayUsed + calls > q.dayLimit || q.monthUsed + calls > q.monthLimit)
  )
    disabledReason = `Квота генераций исчерпана: нужно ${calls}, осталось ${Math.max(
      0,
      Math.min(q.dayLimit - q.dayUsed, q.monthLimit - q.monthUsed)
    )}.`;
  return {
    calls,
    reserveMicroUsd: price?.reserveMicroUsd ?? 0,
    priceLine: price
      ? `≈ ${formatUsd(price.estimateMicroUsd)} · резерв ${formatUsd(
          price.reserveMicroUsd
        )} · вызовов модели: ${calls}`
      : 'Цена недоступна',
    existing,
    disabledReason,
  };
}

export type ItemAction =
  | { kind: 'active'; label: string }
  | { kind: 'apply'; label: string }
  | {
      kind: 'restyle';
      label: string;
      reserveMicroUsd: number;
      /** Прошлая перестилизация в этот режим — FAILED/UNKNOWN: нужен явный повтор. */
      repeatNeeded: boolean;
    }
  | { kind: 'pending'; label: string }
  | { kind: 'blocked'; label: string; reason: string };

export function statusText(item: NarratorLookItem): string {
  if (item.status === 'PENDING') return 'Генерируется…';
  if (item.status === 'UNKNOWN') return 'Исход неизвестен — автоповтора нет.';
  if (item.status === 'FAILED')
    return `Не удалось${item.error ? `: ${item.error}` : ''}`;
  return 'Готов';
}

/** Главная кнопка карточки варианта. */
export function itemAction(
  state: NarratorLooksState,
  item: NarratorLookItem
): ItemAction {
  if (item.active) return { kind: 'active', label: 'Активен' };
  if (item.status === 'PENDING')
    return { kind: 'pending', label: 'Генерируется…' };
  // «Применить» — только готовому варианту без проблем (not-ready и др. — нет).
  if (item.problem === null && item.status === 'READY')
    return { kind: 'apply', label: 'Применить' };
  if (
    item.problem === 'mode-mismatch' &&
    item.photoHash &&
    state.consent.active &&
    state.price.restyle
  )
    return {
      kind: 'restyle',
      label: `Перестилизовать в «${modeLabel(
        state.character?.mode ?? 'photo'
      )}» · резерв ${formatUsd(state.price.restyle.reserveMicroUsd)}`,
      reserveMicroUsd: state.price.restyle.reserveMicroUsd,
      repeatNeeded: restyleRepeatNeeded(state, item),
    };
  return {
    kind: 'blocked',
    label: 'Недоступен',
    // Статус FAILED/UNKNOWN уже написан строкой выше в карточке — здесь
    // не повторяем его, а говорим, где повторить (S3‑7).
    reason:
      item.status === 'FAILED' || item.status === 'UNKNOWN'
        ? item.parentLookId
          ? 'Повторить можно кнопкой «Перестилизовать» у исходного варианта — с явным подтверждением, оплачивается заново.'
          : 'Повторить можно в «Новый вариант» с теми же одеждой и макияжем — с явным подтверждением, оплачивается заново.'
        : item.problem
          ? PROBLEM_TEXT[item.problem]
          : PROBLEM_TEXT['not-ready'],
  };
}

/**
 * Перестилизация после FAILED/UNKNOWN (S2‑2): дочерний вариант этого
 * исходника в текущем режиме уже пытались сделать — сервер без `repeat`
 * ответит 409, поэтому повтор подтверждается явно (оплачивается заново).
 */
export function restyleRepeatNeeded(
  state: NarratorLooksState,
  parent: Pick<NarratorLookItem, 'id'>
): boolean {
  const mode = state.character?.mode ?? 'photo';
  if (mode === 'photo') return false;
  return state.items.some(
    (i) =>
      i.parentLookId === parent.id &&
      (i.status === 'FAILED' || i.status === 'UNKNOWN') &&
      i.style === mode
  );
}

/** Что показать превью: стилизованный ассет, если есть, иначе фото. */
export function previewAsset(
  item: Pick<NarratorLookItem, 'photoHash' | 'styledHash'>
): 'photo' | 'styled' | null {
  if (item.styledHash) return 'styled';
  if (item.photoHash) return 'photo';
  return null;
}

/** Повторная отправка после FAILED/UNKNOWN требует явного «повторить». */
export function needsRepeatConfirm(
  state: NarratorLooksState,
  outfit: string,
  makeup: string
): boolean {
  const mode = state.character?.mode ?? 'photo';
  return state.items.some(
    (i) =>
      (i.status === 'FAILED' || i.status === 'UNKNOWN') &&
      !i.parentLookId &&
      i.outfit === outfit &&
      i.makeup === makeup &&
      i.characterId === state.character?.id &&
      (mode === 'photo' ? i.style === null : i.style === mode)
  );
}
