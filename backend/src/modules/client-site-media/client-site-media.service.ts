/**
 * Обучалка генератора → помощник сайта (Э6 помощника, ТЗ §4.11, §4.12).
 *
 *  - привязка черновика к сайту помощника (`clientSiteId`): только после
 *    проверки внутренним API sites-backend, что человек — владелец или
 *    менеджер помощника в кабинете этого сайта (`site-link`). Без этого
 *    любой привязал бы свой ролик к чужому сайту;
 *  - синхронизация роликов: полный набор ОДОБРЕННЫХ оператором (черновик
 *    `APPROVED`, ролик собран: `assemblyStatus = complete`, `blobUrl`)
 *    привязанных к сайту черновиков → sites-backend `site-videos`
 *    (замена). Поводы: привязка/отвязка, ролик собран (раннер обучалки),
 *    удаление черновика. Отказ сети не роняет ни визард, ни сборку:
 *    следующий повод пришлёт полный набор заново;
 *  - карта интерфейса: элементы страницы из раунда обучалки
 *    (`PageExploration`) → sites-backend `ui-map` — только у привязанного
 *    черновика и только пока сценарий без входа (публичные страницы).
 *
 * Барьер лендинга (`assistant.service.ts`, `clientSiteDraftId: null`) не
 * трогается: ролики обучалки по сайту заказчика по-прежнему никогда не
 * попадают консультанту лендинга, а `reviewed` у них остаётся `false`.
 * Э-С Ш5: лендинг стал сайтом тенанта (`ASSIST_LANDING_SITE_ID`) — его
 * набор роликов ведёт
 * `LandingVideosService` (тот же барьер); сюда к нему не привязать черновик
 * по чужому сайту, и набор черновиков туда не уходит никогда.
 */
import { maskSensitiveEcho } from '../../common/assist-chat-core';
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import {
  SitesInternalClient,
  SitesNotConfiguredError,
  SitesRejectedError,
  SitesUnavailableError,
  sitesTelegramId,
  type SitesUiCandidate,
  type SitesUiElementInput,
  type SitesUiRole,
  type SitesUiViewport,
  type SitesVideoInput,
} from '../sites-internal/sites-internal.client';
import { CAPTURE_VIEWPORT } from '../tutorial-runner/tutorial-video-assembly';
import {
  reconcileAssistVideoSets,
  rememberSyncFailure,
  rememberVideoSet,
  type AssistVideosReconcileResult,
} from './assist-videos-reconcile';
import { landingAssistSiteId } from './landing-assist-config';
import { draftRequiresLogin, draftStepHosts } from './requires-login';

/**
 * Тот же потолок, что у sites-backend (`SYNC_VIDEOS_MAX` = 60, Ш5(5): 10
 * шагов × 5 языков генератора, с запасом).
 */
export const SYNC_VIDEOS_MAX = 60;
/**
 * Бюджет ВСЕГО тела карты (байты UTF-8, как `SYNC_BODY_BUDGET`):
 * sites-backend принимает ≤ 8 КБ (INTERNAL_SITES_BODY_LIMIT). Кириллические
 * подписи — 2 байта на символ, адрес страницы — до 2 КБ: счёт по символам
 * одних элементов (до аудита Э6) пропускал тела > 8 КБ, и карта такой
 * страницы не доходила никогда (413).
 */
export const UI_MAP_BODY_BUDGET = 7_500;
/**
 * Бюджет тела набора роликов (байты UTF-8): sites-backend принимает на
 * `site-videos` ≤ 64 КБ (`INTERNAL_SITE_VIDEOS_BODY_LIMIT_BYTES`, свой
 * парсер; остальные внутренние маршруты — 8 КБ). 60 роликов с длинными
 * кириллическими названиями и адресами Blob — ≈ 40 КБ; запас — под
 * подпись и рост полей. Не влезло бы — 413 на КАЖДОЙ синхронизации, и
 * отвязка/удаление черновика до сайта не доходили бы никогда.
 *
 * Совместимость: старый sites-backend (8 КБ, потолок 15) ответит 413/400 на
 * большой набор — `syncSite` вернёт `false` и НЕ запишет отпечаток, ночная
 * сверка повторит после его выкладки. Малые наборы проходят и у старого.
 */
export const SYNC_BODY_BUDGET = 60_000;
const SITE_ID = /^[A-Za-z0-9_-]{1,64}$/;

export interface AssistLinkView {
  clientSiteId: string | null;
  siteName: string | null;
}

interface ExplorationLike {
  currentUrl?: unknown;
  elements?: unknown;
}

@Injectable()
export class ClientSiteMediaService {
  private readonly logger = new Logger(ClientSiteMediaService.name);
  /** Часы отметки набора (`asOf`, мс) — подменяются тестами. */
  now: () => number = () => Date.now();
  /** Э-С Ш5: id сайта лендинга (`ASSIST_LANDING_SITE_ID`) — тесты подменяют. */
  env: NodeJS.ProcessEnv = process.env;

  constructor(
    private readonly prisma: PrismaService,
    private readonly sites: SitesInternalClient,
  ) {}

  private async ownDraft(userId: string, projectId: string) {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, userId, deletedAt: null },
      select: { id: true, type: true },
    });
    if (!project || project.type !== 'CLIENT_SITE') {
      throw new NotFoundException('проект не найден');
    }
    const draft = (await this.prisma.clientSiteTutorialDraft.findUnique({
      where: { projectId },
      select: { id: true, clientSiteId: true },
    })) as { id: string; clientSiteId: string | null } | null;
    if (!draft) throw new NotFoundException('черновик обучалки ещё не начат');
    return draft;
  }

  private async telegramIdOf(userId: string): Promise<string | null> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { telegramId: true },
    });
    return sitesTelegramId(user?.telegramId);
  }

  /** Привязать (siteId) или отвязать (null) черновик от сайта помощника. */
  async setLink(
    userId: string,
    projectId: string,
    siteId: string | null,
  ): Promise<AssistLinkView> {
    const draft = await this.ownDraft(userId, projectId);
    const previous = draft.clientSiteId;
    if (siteId === null) {
      await this.prisma.clientSiteTutorialDraft.update({
        where: { id: draft.id },
        data: { clientSiteId: null },
      });
      if (previous) await this.syncSite(previous);
      return { clientSiteId: null, siteName: null };
    }
    if (!SITE_ID.test(siteId)) {
      throw new BadRequestException('неверный id сайта помощника');
    }
    // Э-С Ш5: сайт лендинга генератора — служебный тенант, его роликами
    // распоряжается только штатная обучалка (барьер лендинга).
    if (siteId === landingAssistSiteId(this.env)) {
      throw new ForbiddenException(
        'Это сайт помощника лендинга генератора — к нему ролики обучалок по сайтам не привязываются',
      );
    }
    const telegramId = await this.telegramIdOf(userId);
    if (!telegramId) {
      throw new ForbiddenException(
        'привязать к помощнику можно только из Telegram-аккаунта',
      );
    }
    let link: { siteName: string };
    try {
      link = await this.sites.linkSite(telegramId, siteId);
    } catch (e) {
      if (e instanceof SitesRejectedError) {
        throw new ForbiddenException(
          'Этот сайт помощника не найден среди ваших — нужна роль владельца или менеджера помощника',
        );
      }
      if (
        e instanceof SitesNotConfiguredError ||
        e instanceof SitesUnavailableError
      ) {
        throw new ServiceUnavailableException(
          'кабинет помощника сейчас недоступен — попробуйте позже',
        );
      }
      throw e;
    }
    await this.prisma.clientSiteTutorialDraft.update({
      where: { id: draft.id },
      data: { clientSiteId: siteId },
    });
    if (previous && previous !== siteId) await this.syncSite(previous);
    await this.syncSite(siteId);
    return { clientSiteId: siteId, siteName: link.siteName };
  }

  /** id сайта помощника черновика проекта (до удаления черновика). */
  async siteOfProject(projectId: string): Promise<string | null> {
    const d = (await this.prisma.clientSiteTutorialDraft
      .findUnique({ where: { projectId }, select: { clientSiteId: true } })
      .catch(() => null)) as { clientSiteId: string | null } | null;
    return d?.clientSiteId ?? null;
  }

  /** Ролик черновика собран (раннер) — обновить набор его сайта. */
  async syncForDraft(draftId: string): Promise<void> {
    const d = (await this.prisma.clientSiteTutorialDraft
      .findUnique({ where: { id: draftId }, select: { clientSiteId: true } })
      .catch(() => null)) as { clientSiteId: string | null } | null;
    if (d?.clientSiteId) await this.syncSite(d.clientSiteId);
  }

  /**
   * Полный набор одобренных роликов сайта → sites-backend. Никогда не
   * бросает: сбой — в лог, следующий повод пришлёт набор заново.
   */
  async syncSite(siteId: string): Promise<boolean> {
    // Э-С Ш5: набор сайта лендинга — только `LandingVideosService`; полный
    // набор черновиков сюда заменил бы ролики лендинга (и наоборот).
    if (siteId === landingAssistSiteId(this.env)) return false;
    try {
      // Аудит Э6 (гонка): отметка набора — ДО чтения базы. Два повода
      // подряд (отвязка и сборка) шлют полные наборы параллельно; пришедший
      // позже, но собранный раньше набор вернул бы отвязанный ролик.
      // sites-backend принимает только набор не старше последнего
      // принятого (иначе `stale: true`, ничего не меняя). Часы генератора:
      // расхождение инстансов в доли секунды — устаревший набор поправит
      // следующий повод, как и при сбое сети.
      const asOf = this.now();
      const videos = await this.collectVideos(siteId);
      if (!this.sites.configured()) return false;
      const res = await this.sites.syncSiteVideos(siteId, videos, asOf);
      if (res?.stale) {
        this.logger.log(
          `набор роликов сайта помощника ${siteId} устарел (принят более новый)`,
        );
      } else {
        // W7: отпечаток принятого набора — ночная сверка шлёт только то,
        // что не дошло (`assist-videos-reconcile.ts`).
        await rememberVideoSet(this.prisma, siteId, videos, asOf);
      }
      return true;
    } catch (e) {
      this.logger.warn(
        `ролики сайта помощника ${siteId} не отправлены: ${e instanceof Error ? e.name : 'error'}`,
      );
      // Аудит [P3]: время попытки — в конец очереди ночной сверки; «сайт не
      // найден / не ваш» считается подряд (`assist-videos-reconcile.ts`).
      const permanent =
        e instanceof SitesRejectedError && [403, 404, 409].includes(e.status);
      await rememberSyncFailure(this.prisma, siteId, this.now(), permanent);
      return false;
    }
  }

  /**
   * W7: ночная сверка наборов роликов всех сайтов помощника (крон
   * `client-site-retention`). Сбой — в лог и в итог, крон не роняет.
   */
  async reconcileSites(): Promise<AssistVideosReconcileResult> {
    return reconcileAssistVideoSets({
      prisma: this.prisma,
      media: this,
      configured: this.sites.configured(),
      landingSiteId: landingAssistSiteId(this.env),
      now: this.now,
    });
  }

  /** Одобренные и собранные ролики привязанных к сайту черновиков. */
  async collectVideos(siteId: string): Promise<SitesVideoInput[]> {
    if (siteId === landingAssistSiteId(this.env)) return [];
    const drafts = (await this.prisma.clientSiteTutorialDraft.findMany({
      where: { clientSiteId: siteId, status: 'APPROVED' },
    })) as unknown as Array<
      Parameters<typeof draftRequiresLogin>[0] & {
        id: string;
        projectId: string;
        title: string | null;
      }
    >;
    if (!drafts.length) return [];
    const assets = (await this.prisma.tutorialVideoAsset.findMany({
      where: {
        clientSiteDraftId: { in: drafts.map((d) => d.id) },
        assemblyStatus: 'complete',
        blobUrl: { not: null },
      },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        clientSiteDraftId: true,
        title: true,
        locale: true,
        durationMs: true,
        blobUrl: true,
      },
    })) as Array<{
      id: string;
      clientSiteDraftId: string | null;
      title: string;
      locale: string;
      durationMs: number | null;
      blobUrl: string | null;
    }>;
    const projects = (await this.prisma.project.findMany({
      where: { id: { in: drafts.map((d) => d.projectId) }, deletedAt: null },
      select: { id: true, user: { select: { telegramId: true } } },
    })) as Array<{ id: string; user: { telegramId: string | null } | null }>;
    const ownerOf = new Map(
      projects.map((p) => [p.id, sitesTelegramId(p.user?.telegramId)]),
    );
    const draftById = new Map(drafts.map((d) => [d.id, d]));
    const out: SitesVideoInput[] = [];
    const seenDraft = new Set<string>();
    for (const a of assets) {
      const d = a.clientSiteDraftId ? draftById.get(a.clientSiteDraftId) : null;
      // Один ролик на черновик — последний собранный.
      if (!d || seenDraft.has(d.id) || !a.blobUrl) continue;
      const owner = ownerOf.get(d.projectId);
      if (!owner) continue;
      seenDraft.add(d.id);
      out.push({
        externalId: a.id,
        draftId: d.id,
        ownerTelegramId: owner,
        title: (d.title ?? a.title).slice(0, 120),
        locale: /^[a-z]{2}$/.test(a.locale) ? a.locale : 'ru',
        durationMs: a.durationMs,
        url: a.blobUrl,
        requiresLogin: draftRequiresLogin(d),
        stepHosts: draftStepHosts(d).slice(0, 10),
      });
      if (out.length >= SYNC_VIDEOS_MAX) break;
    }
    // Не влезает в тело — уходят самые старые (набор отсортирован от новых).
    // `asOf` — самым длинным числом мс, какое бывает (13 цифр до 2286 г.).
    while (
      out.length &&
      Buffer.byteLength(
        JSON.stringify({ siteId, asOf: 9_999_999_999_999, videos: out }),
        'utf8',
      ) > SYNC_BODY_BUDGET
    ) {
      out.pop();
    }
    return out;
  }

  /**
   * Раунд обучалки (explore/step/refresh) привязанного черновика —
   * элементы страницы в карту интерфейса сайта помощника. Только пока
   * сценарий без входа: страница за логином в публичную карту не идёт.
   * Никогда не бросает и визард не задерживает дольше таймаута клиента.
   */
  async afterRound(
    userId: string,
    projectId: string,
    exploration: ExplorationLike | null | undefined,
  ): Promise<void> {
    try {
      if (!exploration || typeof exploration.currentUrl !== 'string') return;
      const draft = (await this.prisma.clientSiteTutorialDraft.findUnique({
        where: { projectId },
      })) as
        | (Parameters<typeof draftRequiresLogin>[0] & {
            clientSiteId: string | null;
          })
        | null;
      if (!draft?.clientSiteId || !this.sites.configured()) return;
      // Пустой сценарий (первый раунд) — не повод молчать: признаки входа
      // проверяются те же, что у ролика, шаги — какие уже есть.
      const steps = Array.isArray(draft.steps) ? draft.steps : [];
      if (draftRequiresLogin({ ...draft, steps: [...steps, { kind: 'goto' }] }))
        return;
      const telegramId = await this.telegramIdOf(userId);
      if (!telegramId) return;
      const viewport = explorerViewport();
      const elements = fitUiMapBody(
        {
          telegramId,
          siteId: draft.clientSiteId,
          url: exploration.currentUrl,
          viewport,
        },
        mapElements(exploration.elements),
      );
      if (!elements.length) return;
      await this.sites.pushUiMap(
        telegramId,
        draft.clientSiteId,
        exploration.currentUrl,
        elements,
        viewport,
      );
    } catch (e) {
      this.logger.warn(
        `карта интерфейса из раунда не отправлена (${projectId}): ${e instanceof Error ? e.name : 'error'}`,
      );
    }
  }
}

/**
 * Ш4(5): вид вёрстки снимка — по окну исследователя обучалки
 * (`CAPTURE_VIEWPORT`, общий для всех съёмщиков; сейчас 390×844 —
 * `mobile`). Порог — тот же, что у sites-backend для посетителя
 * (`visitorViewport`: уже 768 — телефон).
 */
export function explorerViewport(
  width: number = CAPTURE_VIEWPORT.width,
): SitesUiViewport {
  return width < 768 ? 'mobile' : 'desktop';
}

/**
 * Ш4(5): роль ARIA элемента раунда — по тегу и `input[type]`. Без роли
 * sites-backend не заводит кандидат «роль+имя», и элемент из обучалки
 * узнаётся в снимке обхода/QA только по селектору.
 */
export function elementRole(tag: string, type?: unknown): SitesUiRole | null {
  switch (tag) {
    case 'a':
      return 'link';
    case 'button':
      return 'button';
    case 'select':
      return 'combobox';
    case 'textarea':
      return 'textbox';
    case 'input':
      break;
    default:
      return null;
  }
  const t = typeof type === 'string' ? type.toLowerCase() : 'text';
  switch (t) {
    case 'checkbox':
      return 'checkbox';
    case 'radio':
      return 'radio';
    case 'search':
      return 'searchbox';
    case 'number':
      return 'spinbutton';
    case 'range':
      return 'slider';
    case 'submit':
    case 'button':
    case 'reset':
    case 'image':
      return 'button';
    case 'hidden':
    case 'file':
    case 'color':
      return null;
    default:
      return 'textbox';
  }
}

/**
 * `PageElement[]` обучалки → элементы карты: подпись — label или видимый
 * текст; ≤ 60 и в бюджете тела (≤ 8 КБ у sites-backend). Чистит и
 * пересчитывает id сам sites-backend.
 *
 * Ш4(5): плюс роль (по тегу/типу) и кандидаты, которые у генератора
 * есть: видимый текст кнопки/ссылки, когда подпись взята из
 * `aria-label`/`placeholder` и с ним не совпадает. Другие атрибуты
 * (`name`) исследователь на единственность не проверял — в кандидаты не
 * идут: у радиокнопок `name` общий, подсветка попала бы не туда.
 */
export function mapElements(raw: unknown): SitesUiElementInput[] {
  if (!Array.isArray(raw)) return [];
  const out: SitesUiElementInput[] = [];
  let size = 0;
  for (const e of raw) {
    if (out.length >= 60) break;
    if (!e || typeof e !== 'object') continue;
    const o = e as Record<string, unknown>;
    const label =
      (typeof o.label === 'string' && o.label.trim()) ||
      (typeof o.visibleText === 'string' && o.visibleText.trim()) ||
      '';
    if (
      typeof o.selector !== 'string' ||
      o.selector.length > 200 ||
      // Аудит захода 7: ПД в селекторе (`[name="ivan@…"]`) в общую карту
      // сайта не идёт — маска сломала бы селектор, значит элемент вон.
      hasPd(o.selector) ||
      typeof o.tag !== 'string' ||
      !label ||
      (o.tag === 'input' && o.type === 'password')
    ) {
      continue;
    }
    const item: SitesUiElementInput = {
      selector: o.selector,
      tag: o.tag,
      label: label.slice(0, 80),
    };
    const role = elementRole(o.tag, o.type);
    if (role) item.role = role;
    const text =
      typeof o.visibleText === 'string'
        ? o.visibleText.trim().slice(0, 80)
        : '';
    const candidates: SitesUiCandidate[] = [];
    if (text && text !== item.label)
      candidates.push({ kind: 'text', name: text });
    // Ш4(5)-хвост: все уникальные кандидаты исследователя (не только
    // выбранный селектор) — элемент узнаётся в снимках обхода/QA по любому.
    candidates.push(...explorerCandidates(o.candidates, role ?? undefined));
    if (candidates.length) item.candidates = candidates;
    size += Buffer.byteLength(JSON.stringify(item), 'utf8') + 1;
    if (size > UI_MAP_BODY_BUDGET) break;
    out.push(item);
  }
  return out;
}

/**
 * ПД в строке: то, что маска эха (e-mail, телефон, ключ) заменила бы, или
 * длинный номер (≥ 9 цифр — карта, счёт, документ).
 */
export function hasPd(s: string): boolean {
  return maskSensitiveEcho(s) !== s || /\d(?:[\s-]?\d){8,}/.test(s);
}

/**
 * Ш4(5)-хвост: кандидаты исследователя (`PageElement.candidates`) — в
 * форму карты sites-backend (`cleanCandidate`): `id`/`test-id`/`attr` — как
 * есть, `aria` — «роль + имя» с селектором (без роли — css). Селектор ≤ 200,
 * не больше 4 (sites-backend берёт до 10 и хранит 5 лучших).
 */
export function explorerCandidates(
  raw: unknown,
  role: SitesUiRole | undefined,
): SitesUiCandidate[] {
  if (!Array.isArray(raw)) return [];
  const out: SitesUiCandidate[] = [];
  for (const c of raw.slice(0, 4)) {
    if (!c || typeof c !== 'object') continue;
    const o = c as Record<string, unknown>;
    const selector = o.selector;
    if (typeof selector !== 'string' || !selector || selector.length > 200)
      continue;
    // Аудит захода 7: кандидат с ПД (селектор или подпись aria) —
    // отбрасывается, а не маскируется (маска сломала бы селектор).
    if (hasPd(selector) || (typeof o.name === 'string' && hasPd(o.name)))
      continue;
    if (o.kind === 'id' || o.kind === 'test-id' || o.kind === 'attr') {
      out.push({ kind: o.kind, selector });
    } else if (o.kind === 'aria') {
      const name = typeof o.name === 'string' ? o.name.trim().slice(0, 80) : '';
      out.push(
        role && name
          ? { kind: 'role-name', role, name, selector }
          : { kind: 'css', selector },
      );
    }
  }
  return out;
}

/**
 * Тело `ui-map` целиком (`{ telegramId, siteId, url, viewport, elements }`) — в
 * бюджет `UI_MAP_BODY_BUDGET`: лишние элементы с конца отсекаются (порядок
 * — порядок страницы, первые важнее). Адрес, который один не влезает, —
 * пустой список: отправлять нечего.
 */
export function fitUiMapBody(
  head: {
    telegramId: string;
    siteId: string;
    url: string;
    viewport?: SitesUiViewport;
  },
  elements: SitesUiElementInput[],
): SitesUiElementInput[] {
  const out = [...elements];
  const size = () =>
    Buffer.byteLength(JSON.stringify({ ...head, elements: out }), 'utf8');
  while (out.length && size() > UI_MAP_BODY_BUDGET) out.pop();
  return out;
}
