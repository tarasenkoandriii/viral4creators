/**
 * «Я в кадре» в поздравлении и в личном бренд-буке — чистая логика
 * клиента (ТЗ docs-tz/TZ-Greeting-2.0-Adaptive-Persona-Landing.md §4.1
 * п. 7–8, §4.7, §4.8, §4.9 «Витрина»). Без React и сети — ради тестов
 * без браузера (`scripts/persona-greeting.test.ts`).
 *
 * Здесь решается, ЧТО показать; сервер всё равно проверяет сам (образ
 * принадлежит персоне, Hedra и скетч, согласие на лицо) — клиент только
 * не предлагает заведомо невозможного и не молчит об ограничениях.
 */

// ── Состояние персоны (GET /personas/me) ────────────────────────────────

/** Образ персоны — то, что отдаёт `GET /personas/me` (контракт волны K4). */
export interface PersonaLookLite {
  id: string;
  label: string;
  isBase: boolean;
  /** Пресет — для подписи образа без своего названия (`lookDisplayLabel`). */
  preset: string | null;
  /** pending | ready | failed — колонка `PersonaLook.status`. */
  status: string;
  photoUrl: string | null;
  sketchUrl: string | null;
}

export interface PersonaMeLite {
  persona: { id: string; verified: boolean } | null;
  looks: PersonaLookLite[];
  /**
   * Рубильник `PERSONA_ENABLED`: выключен, а персона есть — сервер всё
   * равно отдаёт её (200, `enabled: false`) ради права на удаление.
   */
  enabled?: boolean;
}

/**
 * Что клиент знает о персоне. `disabled` — сервер ответил 404
 * `PERSONA_DISABLED` (флаг `PERSONA_ENABLED` выключен; распознаёт
 * `isPersonaDisabled` из services/persona-api.ts): тогда режима нет
 * вовсе, и интерфейс не показывает о нём ни слова. `error` — сеть или
 * иной сбой: ведём себя как при `disabled` (выбор «ИИ-ведущий» остаётся
 * единственным и молчаливым), чтобы сбой вспомогательного запроса не
 * ломал бриф.
 */
export type PersonaState =
  | { kind: 'loading' }
  | { kind: 'disabled' }
  | { kind: 'error' }
  | { kind: 'ready'; me: PersonaMeLite };

/**
 * Состояние из общего кеша персоны FE1 (`usePersonaMe`, один запрос
 * `GET /personas/me` на экран). Гость (401) для брифа и бренд-бука —
 * то же, что сбой: режим молча прячется, вход в него — на своём экране.
 * Ответ с `enabled: false` (флаг выключен, своя персона есть) — для
 * брифа и бренд-бука то же, что 404: выбрать образ или создать личный
 * бренд-бук сервер всё равно не даст. Экран удаления FE1 читает свою
 * загрузку и этим не затронут.
 */
export function personaStateFromLoad(
  load:
    | { kind: 'loading' | 'disabled' | 'guest' | 'error' }
    | { kind: 'ready'; me: PersonaMeLite }
): PersonaState {
  switch (load.kind) {
    case 'ready':
      return load.me.enabled === false
        ? { kind: 'disabled' }
        : { kind: 'ready', me: load.me };
    case 'loading':
      return { kind: 'loading' };
    case 'disabled':
      return { kind: 'disabled' };
    default:
      return { kind: 'error' };
  }
}

/** Образ годен в кадр: готов, и есть портрет. */
export function lookReady(look: PersonaLookLite): boolean {
  return look.status === 'ready' && !!look.photoUrl;
}

/** Персона есть, проверка пройдена — только тогда «я» можно выбрать. */
export function hasVerifiedPersona(state: PersonaState): boolean {
  return state.kind === 'ready' && !!state.me.persona?.verified;
}

/** Готовые образы проверенной персоны; базовый — первым. */
export function readyLooks(state: PersonaState): PersonaLookLite[] {
  if (!hasVerifiedPersona(state) || state.kind !== 'ready') return [];
  const ready = state.me.looks.filter(lookReady);
  return [...ready.filter((l) => l.isBase), ...ready.filter((l) => !l.isBase)];
}

// ── «Кто в кадре» в брифе (§4.1 п. 8, §4.8) ─────────────────────────────

export type PresenterVariant = 'photo' | 'sketch';
export const PRESENTER_VARIANTS: readonly PresenterVariant[] = [
  'photo',
  'sketch',
];

/** Тело `presenter` в DTO брифа — ровно контракт волны. */
export type GreetingPresenter =
  | { kind: 'ai' }
  | { kind: 'persona'; lookId: string; variant: PresenterVariant };

/**
 * Ведущий строкой — ключом для формы. Бриф сравнивает поля «было/стало»
 * строгим равенством (`lib/greeting-brief-diff.ts`), объект там дал бы
 * «изменено» на каждом сохранении; строка — нет.
 */
export const AI_PRESENTER_KEY = 'ai';

export function presenterKey(p: GreetingPresenter): string {
  return p.kind === 'ai' ? AI_PRESENTER_KEY : `${p.variant}:${p.lookId}`;
}

/** Обратное к `presenterKey`; мусор — `null`, а не «ИИ» молча. */
export function parsePresenterKey(key: string): GreetingPresenter | null {
  if (key === AI_PRESENTER_KEY) return { kind: 'ai' };
  const i = key.indexOf(':');
  if (i < 0) return null;
  const variant = key.slice(0, i);
  const lookId = key.slice(i + 1);
  if (!lookId) return null;
  if (variant !== 'photo' && variant !== 'sketch') return null;
  return { kind: 'persona', lookId, variant };
}

/**
 * Ведущий из сохранённого брифа: сервер отдаёт `presenter` объектом
 * (`GreetingBriefView.presenter`). Читается бережно: без поля (сервер без
 * режима персоны) или с испорченной формой — ИИ-ведущий; неизвестный
 * вариант — фото (портрет у образа есть всегда, скетча может не быть).
 */
export function presenterFromBrief(brief: {
  presenter?: unknown;
}): GreetingPresenter {
  const p = brief.presenter as
    | { kind?: unknown; lookId?: unknown; variant?: unknown }
    | null
    | undefined;
  if (!p || typeof p !== 'object' || p.kind !== 'persona')
    return { kind: 'ai' };
  if (typeof p.lookId !== 'string' || !p.lookId) return { kind: 'ai' };
  return {
    kind: 'persona',
    lookId: p.lookId,
    variant: p.variant === 'sketch' ? 'sketch' : 'photo',
  };
}

export interface PresenterOption {
  key: string;
  kind: 'ai' | 'persona';
  lookId: string | null;
  variant: PresenterVariant | null;
  /** Образ — для подписи через `lookDisplayLabel` (у «ИИ» и неизвестного — `null`). */
  look: PersonaLookLite | null;
  /** Миниатюра выбранного варианта. */
  thumbUrl: string | null;
  /**
   * Образ из брифа, которого нет среди готовых, — ТОЛЬКО когда персона
   * загружена: пока ответ не пришёл или запрос упал, «удалён» было бы
   * неправдой (аудит волны, CONTRACT5 FE2) — тогда `pending`.
   */
  missing: boolean;
  /** Образ из брифа, а персона ещё не загружена или не загрузилась. */
  pending: boolean;
}

/**
 * Что показывает блок «Кто в кадре»:
 * - `hidden` — режим выключен (или неизвестен): ни выбора, ни ссылки;
 * - `create` — режим есть, персоны нет вовсе: только ссылка «Создать
 *   себя». Персона есть, но не проверена или получила отказ (в том
 *   числе «младше 18» — надгробие) — ссылки нет: «создать» её второй раз
 *   нельзя, а свой экран у неё и так есть;
 * - `choose` — выбор ИИ-ведущий / я (образ …) / я (скетч …).
 *
 * Если в брифе уже стоит «я», а персона с тех пор удалена или режим
 * выключили, блок всё равно показывает выбор (`choose`): иначе человек
 * не увидел бы, кто стоит ведущим, и не смог бы вернуть ИИ.
 */
export type PresenterBlockMode = 'hidden' | 'create' | 'choose';

export function presenterBlockMode(
  state: PersonaState,
  current: GreetingPresenter
): PresenterBlockMode {
  if (hasVerifiedPersona(state)) return 'choose';
  if (current.kind === 'persona') return 'choose';
  if (state.kind === 'ready' && state.me.persona === null) return 'create';
  return 'hidden';
}

/**
 * Варианты выбора: «ИИ-ведущий», затем у каждого готового образа —
 * «я (образ)» и, если у образа есть скетч-аватар, «я (скетч)». Текущий
 * выбор, которого среди готовых нет (образ удалён), остаётся в списке
 * с пометкой `missing` — молча подменять ведущего нельзя.
 */
export function presenterOptions(
  state: PersonaState,
  current: GreetingPresenter
): PresenterOption[] {
  const out: PresenterOption[] = [
    {
      key: AI_PRESENTER_KEY,
      kind: 'ai',
      lookId: null,
      variant: null,
      look: null,
      thumbUrl: null,
      missing: false,
      pending: false,
    },
  ];
  for (const look of readyLooks(state)) {
    out.push({
      key: presenterKey({ kind: 'persona', lookId: look.id, variant: 'photo' }),
      kind: 'persona',
      lookId: look.id,
      variant: 'photo',
      look,
      thumbUrl: look.photoUrl,
      missing: false,
      pending: false,
    });
    if (look.sketchUrl) {
      out.push({
        key: presenterKey({
          kind: 'persona',
          lookId: look.id,
          variant: 'sketch',
        }),
        kind: 'persona',
        lookId: look.id,
        variant: 'sketch',
        look,
        thumbUrl: look.sketchUrl,
        missing: false,
        pending: false,
      });
    }
  }
  const currentKey = presenterKey(current);
  if (current.kind === 'persona' && !out.some((o) => o.key === currentKey)) {
    out.push({
      key: currentKey,
      kind: 'persona',
      lookId: current.lookId,
      variant: current.variant,
      look: null,
      thumbUrl: null,
      missing: state.kind === 'ready',
      pending: state.kind !== 'ready',
    });
  }
  return out;
}

/**
 * Подпись варианта «Кто в кадре». Подпись образа — общая с экраном
 * персоны (`lookDisplayLabel` FE1: своё название → «Базовый образ» →
 * пресет → «без названия»), её передаёт вызывающий: так пустая подпись
 * не превращается в «Я — образ «»».
 */
export function presenterOptionLabel(
  o: PresenterOption,
  t: {
    ai: string;
    missing: string;
    pending: string;
    photo: string;
    sketch: string;
  },
  labelOf: (look: PersonaLookLite) => string
): string {
  if (o.kind === 'ai') return t.ai;
  if (o.missing) return t.missing;
  // Образ неизвестен (персона не загружена) — нейтральная подпись.
  if (!o.look) return t.pending;
  return (o.variant === 'sketch' ? t.sketch : t.photo).replace(
    '{label}',
    labelOf(o.look)
  );
}

/**
 * Hedra и скетч-ведущий: поддержку рисованных портретов у Hedra
 * Character-3 ТЗ велит проверить ДО того, как предлагать (§4.8). Пока не
 * проверено — клиент предупреждает заранее, а окончательный ответ даёт
 * сервер (его отказ показывается как есть).
 */
export function hedraSketchConflict(
  provider: string,
  presenter: GreetingPresenter
): boolean {
  return (
    provider === 'hedra' &&
    presenter.kind === 'persona' &&
    presenter.variant === 'sketch'
  );
}

/**
 * Слать ли `presenter` в сохранении брифа. Режим выключен, и в брифе
 * ИИ-ведущий — поле не шлём вовсе: сервер без режима персоны не обязан
 * его понимать, а выбирать всё равно не из чего. Иначе шлём всегда —
 * и «я», и возврат к «ИИ».
 */
export function shouldSendPresenter(
  state: PersonaState,
  baseline: GreetingPresenter,
  current: GreetingPresenter
): boolean {
  if (hasVerifiedPersona(state)) return true;
  return baseline.kind === 'persona' || current.kind === 'persona';
}

/**
 * Тело сохранения брифа: форма держит ведущего строкой-ключом (ради
 * сравнения «было/стало»), сервер ждёт объект. Ключ уходит, только если
 * он есть в теле (после старта сессии — только изменённый) и его вообще
 * пора слать (`shouldSendPresenter`); испорченный ключ не шлётся.
 */
export function withPresenterBody<T extends { presenter?: string | null }>(
  body: T,
  send: boolean
): Omit<T, 'presenter'> & { presenter?: GreetingPresenter } {
  const { presenter: key, ...rest } = body;
  if (!send || typeof key !== 'string') return rest;
  const presenter = parsePresenterKey(key);
  return presenter ? { ...rest, presenter } : rest;
}

// ── Лица в референсах (§4.8, Г-8) ───────────────────────────────────────

/**
 * Что сказать про лицо на фото референса (§4.8, Г-8; сервер после
 * аудита — fail-closed, CONTRACT5 п.4):
 * - `none` — проверка лица не нашла, или режим персоны выключен (тогда
 *   сервер не требует согласия — поведение как до волны);
 * - `needs-consent` — лицо найдено, согласия нет: фото в видеомодель не
 *   уйдёт (подтвердить согласие или сделать скетч с заменой лица);
 * - `unchecked` — лица могло и не быть, но проверить не удалось (старый
 *   референс без отметки или сбой проверки): сервер считает «лицо может
 *   быть», и выходы те же, что у `needs-consent`;
 * - `consented` — автор подтвердил согласие человека на фото;
 * - `sketched` — активен скетч: лицо заменено, согласие не нужно.
 *
 * Требует ли сервер согласия СЕЙЧАС — решает только `needsFaceConsent`:
 * при выключенном флаге он `false` даже у фото с `hasFace: true`.
 */
export type ReferenceFaceState =
  | 'none'
  | 'needs-consent'
  | 'unchecked'
  | 'consented'
  | 'sketched';

export function referenceFaceState(img: {
  /** Проверка нашла лицо (`null` — не проверялось или не отмечено). */
  hasFace?: boolean | null;
  /** Итог сервера: согласие нужно (лицо может быть, согласия нет, не скетч). */
  needsFaceConsent?: boolean;
  faceConsentAt?: string | null;
  variant: 'original' | 'sketch';
  /** Проверка лица упала (сервер fail-closed пишет тогда `hasFace: true`). */
  faceCheckUnavailable?: boolean;
}): ReferenceFaceState {
  if (img.hasFace === false) return 'none';
  if (img.needsFaceConsent) {
    // Сбой проверки сервер помечает `hasFace: true` («лицо может быть»),
    // поэтому «найдено» различаем по его явному признаку сбоя.
    return img.hasFace === true && img.faceCheckUnavailable !== true
      ? 'needs-consent'
      : 'unchecked';
  }
  if (img.faceConsentAt) return 'consented';
  if (img.variant === 'sketch' && img.hasFace === true) return 'sketched';
  return 'none';
}

// ── Личный бренд-бук (§4.7) ─────────────────────────────────────────────

export type BrandManifestKind = 'COMPANY' | 'PERSONAL';

/**
 * Шрифты и цвета карточек — белый список сервера
 * (`backend/src/common/greeting-cards.ts`: `CARD_FONTS`, `CARD_COLORS`).
 * Сегодня карточки жёстко Arial белым, а текст ложится через libass:
 * незнакомый fontconfig шрифт превращает кириллицу в квадраты, тёмный
 * цвет не читается на тёмной плашке. Поэтому выбор — из короткого списка
 * ключей, а не свободный ввод. Расхождение с сервером ловит тест
 * синхронизации (`scripts/persona-greeting.test.ts`).
 */
export const CARD_STYLE_FONTS = ['sans', 'serif', 'condensed', 'mono'] as const;
export type CardStyleFont = (typeof CARD_STYLE_FONTS)[number];

/** Ключ цвета → RGB (для кружков выбора и предпросмотра). */
export const CARD_STYLE_COLOR_HEX = {
  white: 'FFFFFF',
  cream: 'FFF4D6',
  gold: 'FFD54F',
  pink: 'F8BBD0',
  sky: 'B3E5FC',
  mint: 'C8E6C9',
} as const;
export type CardStyleColor = keyof typeof CARD_STYLE_COLOR_HEX;
export const CARD_STYLE_COLORS = Object.keys(
  CARD_STYLE_COLOR_HEX
) as CardStyleColor[];

export interface CardStyle {
  font: CardStyleFont;
  color: CardStyleColor;
}

export const DEFAULT_CARD_STYLE: CardStyle = { font: 'sans', color: 'white' };

/**
 * `cardStyle` из ответа сервера (колонка Json — форма не гарантирована),
 * по тому же правилу, что серверный `normalizeCardStyle`: не объект или
 * ни одного знакомого ключа — `null` (стиль не задан); знаком хоть
 * один — второй берётся по умолчанию.
 */
export function normalizeCardStyle(raw: unknown): CardStyle | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const { font, color } = raw as { font?: unknown; color?: unknown };
  const f = (CARD_STYLE_FONTS as readonly unknown[]).includes(font)
    ? (font as CardStyleFont)
    : null;
  const c = (CARD_STYLE_COLORS as readonly unknown[]).includes(color)
    ? (color as CardStyleColor)
    : null;
  if (!f && !c) return null;
  return {
    font: f ?? DEFAULT_CARD_STYLE.font,
    color: c ?? DEFAULT_CARD_STYLE.color,
  };
}

/**
 * Образ по умолчанию личного бренд-бука в списке выбора:
 * - `none` — не выбран; `present` — среди готовых образов;
 * - `missing` — персона загружена, а образа среди готовых нет (удалён);
 * - `pending` — персона ещё грузится или не загрузилась: «удалён» было
 *   бы неправдой, показываем нейтральное «выбранный образ».
 */
export type DefaultLookOption = 'none' | 'present' | 'missing' | 'pending';

export function defaultLookOption(
  defaultLookId: string,
  state: PersonaState
): DefaultLookOption {
  if (!defaultLookId) return 'none';
  if (state.kind !== 'ready') return 'pending';
  return readyLooks(state).some((l) => l.id === defaultLookId)
    ? 'present'
    : 'missing';
}

/** Подпись «от кого» по умолчанию — тот же потолок, что имя в брифе. */
export const SIGNATURE_MAX = 120;

/**
 * Показывать ли переключатель «компания / личный». Личный без персоны
 * сервер не примет (PERSONAL требует персону), поэтому выбор появляется
 * только у проверенной персоны. У бренд-бука, который уже личный, выбор
 * виден всегда — иначе после удаления персоны его нельзя было бы
 * вернуть в «компанию».
 */
export function showKindSwitch(
  state: PersonaState,
  currentKind: BrandManifestKind
): boolean {
  return currentKind === 'PERSONAL' || hasVerifiedPersona(state);
}

/**
 * Можно ли создать бренд-бук с этим видом. Корпоративный закрыт режимом
 * (`brandManifest`, §23), личный — на всех тарифах (В-1, временно по
 * рекомендации ТЗ), но только с проверенной персоной.
 */
export function canCreateManifest(
  kind: BrandManifestKind,
  companyAllowed: boolean,
  state: PersonaState
): boolean {
  return kind === 'PERSONAL' ? hasVerifiedPersona(state) : companyAllowed;
}

/**
 * Вид нового бренд-бука по умолчанию: корпоративный, если он доступен;
 * иначе личный (у LITE с персоной кнопка «Создать» ведёт именно к нему).
 */
export function defaultCreateKind(
  companyAllowed: boolean,
  state: PersonaState
): BrandManifestKind {
  return !companyAllowed && hasVerifiedPersona(state) ? 'PERSONAL' : 'COMPANY';
}

/**
 * Поля личного бренд-бука для PATCH. У корпоративного — `null`: сервер
 * хранит их только у личного, а переход «личный → компания» обязан их
 * сбросить, иначе подпись и образ человека остались бы в бренд-буке,
 * который можно продать на аукционе.
 */
export function personalManifestPatch(
  kind: BrandManifestKind,
  fields: {
    defaultLookId: string;
    signature: string;
    defaultTone: string;
    cardStyle: CardStyle | null;
  }
): {
  kind: BrandManifestKind;
  defaultLookId: string | null;
  signature: string | null;
  defaultTone: string | null;
  cardStyle: CardStyle | null;
} {
  if (kind !== 'PERSONAL') {
    return {
      kind,
      defaultLookId: null,
      signature: null,
      defaultTone: null,
      cardStyle: null,
    };
  }
  return {
    kind,
    defaultLookId: fields.defaultLookId || null,
    signature: fields.signature.trim().slice(0, SIGNATURE_MAX) || null,
    defaultTone: fields.defaultTone || null,
    cardStyle: fields.cardStyle,
  };
}

// ── Витрина (§4.9) ──────────────────────────────────────────────────────

/**
 * Снят ли ролик с персоной — признак `usesPersona` в снимке брифа сессии
 * (`Session.greetingBriefSnapshot`, его ставит сервер). Снимок во
 * фронтенде не типизирован (types/index.ts), поэтому читается бережно:
 * только строгое `true`.
 */
export function snapshotUsesPersona(snapshot: unknown): boolean {
  return (
    !!snapshot &&
    typeof snapshot === 'object' &&
    (snapshot as { usesPersona?: unknown }).usesPersona === true
  );
}

/**
 * Тело заявки на публичную страницу. У ролика с персоной галочка
 * «можно в витрину» отдельная и по умолчанию снята; у остальных поле не
 * шлётся вовсе — их витрина решается оператором, как раньше.
 */
export function sharedVideoRequestExtra(
  usesPersona: boolean,
  showcaseConsent: boolean
): { allowShowcaseWithPersona?: boolean } {
  return usesPersona ? { allowShowcaseWithPersona: showcaseConsent } : {};
}

/**
 * Фото сцены бренд-бука не прошло проверку лица (CONTRACT5 п.10): при
 * включённом режиме «Я в кадре» оно уходит в поздравление только
 * словами, пока из него не сделан скетч. Заметка — только при явном
 * `photoFaceChecked === false` (сервер без поля — молчим), при
 * известном включённом режиме и у оригинала с фото.
 */
export function scenePhotoTextOnly(
  asset: {
    photoUrl: string | null;
    photoVariant?: 'original' | 'sketch';
    photoFaceChecked?: boolean;
  },
  state: PersonaState
): boolean {
  return (
    state.kind === 'ready' &&
    !!asset.photoUrl &&
    asset.photoVariant !== 'sketch' &&
    asset.photoFaceChecked === false
  );
}

// ── Бренд-бук в проекте (CONTRACT5 п.5в, п.13) ─────────────────────────

/**
 * Личный бренд-бук привязывается только к поздравлению: лицо и голос
 * человека не должны уйти в товарный ролик, который потом можно
 * продать. Сервер отвечает отказом сам; интерфейс просто не предлагает
 * такой выбор. Уже привязанный (`keepId`, до этой волны) остаётся в
 * списке, чтобы выпадающий список не показывал пустоту вместо него.
 */
export function manifestsForProjectType<
  T extends { id: string; kind?: BrandManifestKind },
>(list: readonly T[], projectType: string, keepId?: string | null): T[] {
  if (projectType === 'GREETING_VIDEO') return [...list];
  return list.filter((m) => m.kind !== 'PERSONAL' || m.id === keepId);
}
