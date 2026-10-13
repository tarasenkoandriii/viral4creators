/**
 * AI Publisher — каналы F09 и смена статуса публикации: чистые функции
 * экранов (`ChannelsPanel`, публикации на карточке материала). Тела —
 * `CreateChannelBody`/`PatchChannelBody`/`PublicationTransitionBody`
 * контракта `distribution-api.ts` (сверка — `scripts/publisher-bodies.test.ts`);
 * правила — как у сервера (`channels.service.ts`, `PUBLICATION_MACHINE`).
 */
import type {
  ChannelView,
  CreateChannelIn,
  PatchChannelIn,
  PublicationTransitionIn,
  PublicationView,
} from './calendar-api';

/** Код канала — как `channels.service.ts`: латиница/цифры, `_`/`-`, до 64. */
export const CHANNEL_CODE_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
/** Значение UTM — алфавит триггера `pub_utm_guard` (`core/utm.ts`), до 100. */
export const UTM_VALUE_RE = /^[\p{L}\p{N} ._:/-]{1,100}$/u;

export const CHANNEL_CREATE_KINDS = ['own', 'community', 'paid_venue'] as const;
export type AdsChoice = 'yes' | 'no' | 'unknown';

export interface ChannelForm {
  code: string;
  title: string;
  kind: string;
  utmSource: string;
  utmMedium: string;
  ads: AdsChoice;
  rulesNote: string;
  status: string;
}

export const adsChoice = (v: boolean | null): AdsChoice =>
  v === null ? 'unknown' : v ? 'yes' : 'no';
const adsValue = (c: AdsChoice): boolean | null =>
  c === 'unknown' ? null : c === 'yes';

export function channelForm(ch: ChannelView | null): ChannelForm {
  return {
    code: ch?.code ?? '',
    title: ch?.title ?? '',
    kind: ch?.kind ?? '',
    utmSource: ch?.utmSource ?? '',
    utmMedium: ch?.utmMedium ?? '',
    ads: adsChoice(ch ? ch.adsAllowed : null),
    rulesNote: ch?.rulesNote ?? '',
    status: ch?.status ?? 'available',
  };
}

/** Поле формы, которое сервер отвергнет (подсветка до запроса). */
export function channelFieldErrors(
  f: ChannelForm,
  creating: boolean
): Array<'code' | 'title' | 'kind' | 'utmSource' | 'utmMedium'> {
  const out: Array<'code' | 'title' | 'kind' | 'utmSource' | 'utmMedium'> = [];
  if (creating && !CHANNEL_CODE_RE.test(f.code.trim())) out.push('code');
  if (!f.title.trim() || f.title.trim().length > 200) out.push('title');
  if (creating && !(CHANNEL_CREATE_KINDS as readonly string[]).includes(f.kind))
    out.push('kind');
  if (!UTM_VALUE_RE.test(f.utmSource.trim())) out.push('utmSource');
  if (!UTM_VALUE_RE.test(f.utmMedium.trim())) out.push('utmMedium');
  return out;
}

/** Тело создания канала или `null` (кнопка неактивна). */
export function channelCreateBody(f: ChannelForm): CreateChannelIn | null {
  if (channelFieldErrors(f, true).length) return null;
  const note = f.rulesNote.trim();
  return {
    code: f.code.trim(),
    title: f.title.trim(),
    kind: f.kind as CreateChannelIn['kind'],
    utmSource: f.utmSource.trim(),
    utmMedium: f.utmMedium.trim(),
    adsAllowed: adsValue(f.ads),
    ...(note ? { rulesNote: note } : {}),
  };
}

/**
 * Тело правки канала: только изменённые поля + `expectedRevision`;
 * `null` — менять нечего или поле неверно. Код и вид не меняются (сервер
 * их не принимает).
 */
export function channelPatchBody(
  ch: ChannelView,
  f: ChannelForm
): PatchChannelIn | null {
  if (channelFieldErrors(f, false).length) return null;
  const b: PatchChannelIn = { expectedRevision: ch.revision };
  const title = f.title.trim();
  const src = f.utmSource.trim();
  const med = f.utmMedium.trim();
  const note = f.rulesNote.trim();
  if (title !== ch.title) b.title = title;
  if (src !== ch.utmSource) b.utmSource = src;
  if (med !== ch.utmMedium) b.utmMedium = med;
  if (adsValue(f.ads) !== ch.adsAllowed) b.adsAllowed = adsValue(f.ads);
  if (note !== (ch.rulesNote ?? '')) b.rulesNote = note || null;
  if (
    f.status !== ch.status &&
    (f.status === 'available' || f.status === 'unavailable')
  )
    b.status = f.status;
  return Object.keys(b).length > 1 ? b : null;
}

export type PublicationTarget = PublicationTransitionIn['to'];

/**
 * Куда человек может перевести публикацию (`PUBLICATION_MACHINE`, маршрут
 * `publication.manage` — PO/OP): `pending` → опубликовано / не удалось /
 * снято; `published` → снято. `replaced` ставит только система.
 */
export function publicationTargets(
  p: Pick<PublicationView, 'status'>
): PublicationTarget[] {
  if (p.status === 'pending') return ['published', 'failed', 'withdrawn'];
  if (p.status === 'published') return ['withdrawn'];
  return [];
}

/** Тело перехода или `null` (снятие — только с причиной). */
export function publicationTransitionBody(
  p: Pick<PublicationView, 'status' | 'revision'>,
  to: PublicationTarget,
  reason: string
): PublicationTransitionIn | null {
  if (!publicationTargets(p).includes(to)) return null;
  const r = reason.trim();
  if (to === 'withdrawn' && !r) return null;
  return {
    expectedRevision: p.revision,
    to,
    ...(r ? { reason: r.slice(0, 2000) } : {}),
  };
}

/** Снятие публикации канала `site` снимает страницу материала (410). */
export const withdrawTakesDownPage = (channelKind: string | undefined) =>
  channelKind === 'site';
