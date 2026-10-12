/**
 * Заход 13 (Р-З13-Б3; хвост захода 11 «TMA „Обучение → Голос“: карточки
 * терминов и „не туда“») — те же подсказки, что в панели редактора `we.`
 * (№113, Р-З11-Б4/Б5/Б7/Б9), для кабинета TMA без пикера:
 *
 *   GET  /assist/sites/:id/voice-map/site/suggestions          карточки + ревизия + цели для выбора
 *   POST /assist/sites/:id/voice-map/site/suggestions/term     { expectedRevision, id } → термин в черновик
 *   POST /assist/sites/:id/voice-map/site/suggestions/rebind   { expectedRevision, id, to } → фраза — синоним `to`
 *   POST /assist/sites/:id/voice-map/site/suggestions/mute     { id } → «не предлагать» 30 дней
 *
 * Права — как у карты «Сайта» в TMA (владелец или `assist: manager`, гвард
 * контроллера) + сайт этого кабинета (`loadAssistSite`, чужой — 404).
 * Серверные функции — общие с панелью (`EditorAssistService`: свёртка
 * терминов и «не туда», `acceptTermFor`, `mute`; `MapMissesService.detailFor`).
 * Текст фразы берёт сервер из свежего списка по id (произвольный текст
 * маршруты не принимают). Запись — обычной операцией черновика
 * (`VoiceMapService.patch`, ревизия → 409, журнал карты, источник `tma`);
 * ответ несёт обратные операции — «Отменить» в TMA шлёт их тем же
 * `PATCH …/draft` с новой ревизией (карту успели поменять — 409).
 *
 * Отличия от панели (Р-З13-Б3):
 *  - «не туда» — по всем страницам (у панели — цели текущей страницы);
 *  - карточка «не туда» скрыта, когда фраза уже стала фразой ДРУГОЙ
 *    активной цели (перепривязали — здесь или в редакторе; «Отменить»
 *    возвращает карточку без журнала «не предлагать»);
 *  - перепривязка — выбор цели из списка (активные, не «никогда»);
 *    со старой цели фраза снимается одним пакетом, только если была её
 *    синонимом (имя не трогаем — `nameClash`, Р-З11-Б9).
 */
import { HttpStatus, Injectable } from '@nestjs/common';
import { SitesDb } from '../../prisma/sites-db.service';
import { loadAssistSite } from '../assist-site-setup/widget-settings.service';
import { phraseNorm } from '../assist-ui-core/memo';
import {
  effectiveRisk,
  parseVoiceMapContent,
  targetPhrases,
  VOICE_MAP_LANGS,
  VOICE_MAP_LIMITS,
  type VoiceMapContent,
  type VoiceMapLang,
  type VoiceMapTarget,
} from '../assist-ui-core/voice-map';
import type { AccountMembership } from '../site-core/account/roles';
import type {
  TmaRebindTarget,
  TmaSuggestionActionView,
  TmaSuggestionsView,
  TmaWrongCard,
} from './api-types';
import { EDITOR_ASSIST, type WrongItem } from './editor/editor-assist';
import {
  EditorAssistService,
  type SuggestionActor,
} from './editor/editor-assist.service';
import { MapMissesService } from './map-misses';
import { voiceMapError } from './voice-map-errors';
import { VoiceMapService } from './voice-map.service';

type Db = ReturnType<SitesDb['forAccount']>;

const ID_RE = /^[0-9a-f]{24}$/;

/** Целей в списке «перепривязать к…» не больше (карта — до 500). */
export const TMA_REBIND_TARGETS = 500;

const isMapLang = (l: string | null): l is VoiceMapLang =>
  !!l && (VOICE_MAP_LANGS as readonly string[]).includes(l);

/** Цель, которой можно дать фразу: активна, не запрещена, не «никогда». */
const bindable = (t: VoiceMapTarget) =>
  t.status === 'active' && !t.denylisted && effectiveRisk(t) !== 'never';

/**
 * Фраза уже фраза (имя/синоним) другой активной цели — «не туда» по ней
 * больше не показываем (перепривязали). Чистая функция — для тестов.
 */
export function rebound(
  content: VoiceMapContent,
  key: string,
  phrase: string,
): boolean {
  const n = phraseNorm(phrase);
  return content.targets.some(
    (t) =>
      t.key !== key &&
      t.status === 'active' &&
      targetPhrases(t).some((p) => p.norm === n),
  );
}

/** Фраза совпадает с ИМЕНЕМ цели `key` (любой язык). */
export function nameClash(
  content: VoiceMapContent,
  key: string,
  phrase: string,
): boolean {
  const t = content.targets.find((x) => x.key === key);
  const n = phraseNorm(phrase);
  return (
    !!t &&
    VOICE_MAP_LANGS.some((l) => !!t.names[l] && phraseNorm(t.names[l]!) === n)
  );
}

/**
 * Операции перепривязки фразы со старой цели `from` на `to` и обратные
 * (чистая функция). Со старой цели фраза снимается во всех языках, только
 * если была её синонимом и цель активна (неактивную не «оживляем»).
 */
export function rebindOps(
  content: VoiceMapContent,
  from: string,
  to: string,
  phrase: string,
  lang: VoiceMapLang,
): {
  ops: Array<Record<string, unknown>>;
  undo: Array<Record<string, unknown>>;
  detached: boolean;
} {
  const b = content.targets.find((x) => x.key === to);
  const ops: Array<Record<string, unknown>> = [
    { op: 'add-synonym', key: to, lang, text: phrase },
  ];
  const undo: Array<Record<string, unknown>> = b
    ? [{ op: 'upsert-target', target: { key: to, synonyms: b.synonyms } }]
    : [];
  const a = content.targets.find((x) => x.key === from);
  const n = phraseNorm(phrase);
  const has = (t: VoiceMapTarget) =>
    VOICE_MAP_LANGS.some((l) =>
      (t.synonyms[l] ?? []).some((s) => phraseNorm(s.text) === n),
    );
  if (!a || a.status !== 'active' || from === to || !has(a))
    return { ops, undo, detached: false };
  const synonyms = Object.fromEntries(
    VOICE_MAP_LANGS.map(
      (l) =>
        [l, (a.synonyms[l] ?? []).filter((s) => phraseNorm(s.text) !== n)] as [
          VoiceMapLang,
          unknown[],
        ],
    ).filter(([, v]) => v.length),
  );
  ops.push({ op: 'upsert-target', target: { key: a.key, synonyms } });
  undo.push({
    op: 'upsert-target',
    target: { key: a.key, synonyms: a.synonyms },
  });
  return { ops, undo, detached: true };
}

function targetName(t: VoiceMapTarget): string {
  for (const l of VOICE_MAP_LANGS) if (t.names[l]) return t.names[l]!;
  return t.key;
}

@Injectable()
export class VoiceMapSuggestionsService {
  constructor(
    private readonly sitesDb: SitesDb,
    private readonly maps: VoiceMapService,
    private readonly misses: MapMissesService,
    private readonly assist: EditorAssistService,
  ) {}

  private who(m: AccountMembership, siteId: string): SuggestionActor {
    return { accountId: m.accountId, siteId, memberId: m.memberId };
  }

  private gone() {
    return voiceMapError(
      HttpStatus.CONFLICT,
      'VOICE_MAP_SUGGESTION_GONE',
      'Предложение уже неактуально — список обновлён',
    );
  }

  private invalid(message: string) {
    return voiceMapError(HttpStatus.BAD_REQUEST, 'VOICE_MAP_INVALID', message);
  }

  /** Сайт кабинета (404 — чужой) и база тенанта. */
  private async site(m: AccountMembership, siteId: string): Promise<Db> {
    const db = this.sitesDb.forAccount(m.accountId);
    await loadAssistSite(db, m.accountId, siteId);
    return db;
  }

  /** «Не туда» по всем страницам, без отклонённых, порог посетителей. */
  private async wrongCards(
    db: Db,
    siteId: string,
    accountId: string,
    content: VoiceMapContent,
    muted: ReadonlySet<string>,
  ): Promise<Array<WrongItem & { lang: VoiceMapLang | null }>> {
    const { wrongs } = await this.misses.detailFor(accountId, siteId);
    // Перепривязанные и не uk/ru/en — до срезов свёртки (аудит P3-4).
    const items = await this.assist.wrong(
      db,
      siteId,
      wrongs.filter((w) => !w.multi),
      muted,
      (r) =>
        (r.lang === null || isMapLang(r.lang)) &&
        !rebound(content, r.key, r.phrase),
    );
    // Язык уже отобран `keep` (uk/ru/en или нет).
    return items.filter(
      (w) => w.visitors >= EDITOR_ASSIST.minWrongVisitors,
    ) as Array<WrongItem & { lang: VoiceMapLang | null }>;
  }

  async list(
    m: AccountMembership,
    siteId: string,
  ): Promise<TmaSuggestionsView> {
    const db = await this.site(m, siteId);
    const row = await this.maps.loadMap(db, m.accountId, siteId);
    const content = parseVoiceMapContent(row.draft);
    const muted = await this.assist.mutedIds(db, siteId);
    const terms = (await this.assist.terms(db, siteId, content, muted)).filter(
      (t) => t.visitors >= EDITOR_ASSIST.minTermVisitors,
    );
    const wrong: TmaWrongCard[] = (
      await this.wrongCards(db, siteId, m.accountId, content, muted)
    ).map((w) => ({
      id: w.id,
      key: w.key,
      phrase: w.phrase,
      lang: w.lang,
      visitors: w.visitors,
      count: w.count,
      nameClash: nameClash(content, w.key, w.phrase),
    }));
    const targets: TmaRebindTarget[] = content.targets
      .filter(bindable)
      .slice(0, TMA_REBIND_TARGETS)
      .map((t) => ({
        key: t.key,
        name: targetName(t),
        scope: t.scope,
        page: t.scope === 'page' ? t.pagePath : null,
      }));
    return {
      days: Math.round(EDITOR_ASSIST.windowMs / 86_400_000),
      revision: row.draftRevision,
      terms: terms.map((t) => ({
        id: t.id,
        phrase: t.phrase,
        visitors: t.visitors,
        count: t.count,
      })),
      wrong,
      targets,
      termsLeft: Math.max(0, EDITOR_ASSIST.termsMax - content.terms.length),
    };
  }

  /** Принять термин: та же операция, что у панели (`set-terms`), источник `tma`. */
  async acceptTerm(
    m: AccountMembership,
    siteId: string,
    body: unknown,
  ): Promise<TmaSuggestionActionView & { term: string }> {
    await this.site(m, siteId);
    const r = await this.assist.acceptTermFor(
      this.who(m, siteId),
      body,
      'tma',
      () => this.gone(),
    );
    return {
      revision: r.revision,
      term: r.term,
      undo: [{ op: 'set-terms', terms: r.before }],
    };
  }

  /**
   * Перепривязать «не туда»: фраза карточки — синоним выбранной цели `to`
   * (язык команды; без языка — основной язык персоны, иначе `uk`); со
   * старой цели снимается одним пакетом, если была её синонимом.
   */
  async rebind(
    m: AccountMembership,
    siteId: string,
    body: unknown,
  ): Promise<
    TmaSuggestionActionView & {
      key: string;
      from: string;
      phrase: string;
      lang: VoiceMapLang;
      detached: boolean;
    }
  > {
    const b = (body ?? {}) as {
      expectedRevision?: unknown;
      id?: unknown;
      to?: unknown;
    };
    if (
      typeof b.expectedRevision !== 'number' ||
      !Number.isInteger(b.expectedRevision) ||
      typeof b.id !== 'string' ||
      !ID_RE.test(b.id) ||
      typeof b.to !== 'string' ||
      !VOICE_MAP_LIMITS.keyRe.test(b.to)
    )
      throw this.invalid('Нужны ревизия черновика, id предложения и цель');
    const db = await this.site(m, siteId);
    const row = await this.maps.loadMap(db, m.accountId, siteId);
    if (row.draftRevision !== b.expectedRevision)
      throw voiceMapError(
        HttpStatus.CONFLICT,
        'VOICE_MAP_CONFLICT',
        'Карту изменили в другой вкладке — обновите',
      );
    const content = parseVoiceMapContent(row.draft);
    const muted = await this.assist.mutedIds(db, siteId);
    const item = (
      await this.wrongCards(db, siteId, m.accountId, content, muted)
    ).find((w) => w.id === b.id);
    if (!item) throw this.gone();
    const to = content.targets.find((t) => t.key === b.to);
    if (!to || !bindable(to) || to.key === item.key)
      throw this.invalid(
        to?.key === item.key
          ? 'Это та же цель — выберите правильную'
          : 'Такой цели нет или ей нельзя давать фразы',
      );
    let lang: VoiceMapLang = 'uk';
    if (item.lang) lang = item.lang;
    else {
      const site = (await this.assist.siteLangs(db, siteId)).find(isMapLang);
      if (site) lang = site;
    }
    const plan = rebindOps(content, item.key, to.key, item.phrase, lang);
    const res = await this.maps.patch(
      { accountId: m.accountId, memberId: m.memberId },
      siteId,
      { expectedRevision: row.draftRevision, ops: plan.ops },
      'tma',
    );
    return {
      revision: res.revision,
      undo: plan.undo,
      key: to.key,
      from: item.key,
      phrase: item.phrase,
      lang,
      detached: plan.detached,
    };
  }

  /** «Не предлагать» 30 дней — общий журнал панели (только id карточки). */
  async mute(
    m: AccountMembership,
    siteId: string,
    body: unknown,
  ): Promise<{ id: string }> {
    const id = (body as { id?: unknown } | null)?.id;
    if (typeof id !== 'string' || !ID_RE.test(id))
      throw this.invalid('Нужен id предложения');
    await this.site(m, siteId);
    return this.assist.mute(this.who(m, siteId), { id });
  }
}
