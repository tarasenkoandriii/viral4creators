/**
 * W7 (Э6-хвост, L6445): привязка СУЩЕСТВУЮЩЕГО черновика обучалки к сайту
 * помощника из визарда — плашка «привязано к помощнику» и выбор сайта.
 *
 *   GET  /projects/:id/site-tutorial/assist-link → AssistLinkState
 *   POST /projects/:id/site-tutorial/assist-link { siteId | null } → AssistLinkState
 *
 * Кандидаты — внутренний API sites-backend `site-candidates`: сайты, где
 * человек владелец кабинета или менеджер помощника (то же правило, что у
 * `site-link`), у сайта есть помощник, и хост черновика — среди
 * подтверждённых хостов сайта. Сайт лендинга генератора
 * (`ASSIST_LANDING_SITE_ID`) — никогда (барьер лендинга, Э-С Ш5).
 *
 * Отказ привязать — 409 `ASSIST_LINK_UNAVAILABLE` одним кодом: кабинет
 * сайтов не подключён, у аккаунта нет Telegram, у черновика нет адреса,
 * сайт не среди кандидатов (чужой, без помощника, хост не подтверждён,
 * лендинг). Чужой проект — 404, как у остальных маршрутов визарда.
 * Кабинет сайтов не ответил — 503 (временное).
 *
 * Прежний `PUT` (deep-link из TMA помощника, первый раунд) не меняется:
 * там сайт пришёл из кабинета помощника, и проверка хоста черновика ему не
 * нужна — человек открыл визард ИЗ этого сайта.
 */
import {
  ConflictException,
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
  type SitesSiteCandidate,
} from '../sites-internal/sites-internal.client';
import { ClientSiteMediaService } from './client-site-media.service';
import { landingAssistSiteId } from './landing-assist-config';

export const ASSIST_LINK_UNAVAILABLE = 'ASSIST_LINK_UNAVAILABLE';

export interface AssistLinkCandidate {
  siteId: string;
  name: string;
}

export interface AssistLinkState {
  linked: boolean;
  siteId: string | null;
  siteName: string | null;
  canLink: boolean;
  candidates: AssistLinkCandidate[];
}

const HOST = /^[a-z0-9.-]{1,253}$/;

/** Хост черновика для подбора сайтов: только https/http с точкой в имени. */
export function draftHost(baseUrl: string | null | undefined): string | null {
  if (!baseUrl) return null;
  try {
    const u = new URL(baseUrl);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    const h = u.hostname.toLowerCase().replace(/\.$/, '');
    return HOST.test(h) && h.includes('.') ? h : null;
  } catch {
    return null;
  }
}

function unavailable(message: string): ConflictException {
  return new ConflictException({
    error: ASSIST_LINK_UNAVAILABLE,
    code: ASSIST_LINK_UNAVAILABLE,
    message,
  });
}

interface DraftLink {
  id: string;
  clientSiteId: string | null;
  baseUrl: string | null;
}

@Injectable()
export class AssistLinkService {
  private readonly logger = new Logger(AssistLinkService.name);
  /** id сайта лендинга (`ASSIST_LANDING_SITE_ID`) — тесты подменяют. */
  env: NodeJS.ProcessEnv = process.env;

  constructor(
    private readonly prisma: PrismaService,
    private readonly sites: SitesInternalClient,
    private readonly media: ClientSiteMediaService,
  ) {}

  private async ownDraft(
    userId: string,
    projectId: string,
  ): Promise<DraftLink | null> {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, userId, deletedAt: null },
      select: { id: true, type: true },
    });
    if (!project || project.type !== 'CLIENT_SITE') {
      throw new NotFoundException('проект не найден');
    }
    return (await this.prisma.clientSiteTutorialDraft.findUnique({
      where: { projectId },
      select: { id: true, clientSiteId: true, baseUrl: true },
    })) as DraftLink | null;
  }

  private async telegramIdOf(userId: string): Promise<string | null> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { telegramId: true },
    });
    return sitesTelegramId(user?.telegramId);
  }

  /**
   * Кандидаты из sites-backend без сайта лендинга. `strict` — для POST:
   * недоступность — ошибка; для GET — пустой список (плашка без кнопки).
   */
  private async candidatesFor(
    telegramId: string | null,
    host: string | null,
    strict: boolean,
  ): Promise<SitesSiteCandidate[]> {
    if (!telegramId || !host || !this.sites.configured()) {
      if (strict) {
        throw unavailable(
          !this.sites.configured()
            ? 'кабинет помощника не подключён'
            : !telegramId
              ? 'привязать к помощнику можно только из Telegram-аккаунта'
              : 'у черновика ещё нет адреса сайта',
        );
      }
      return [];
    }
    try {
      const { sites } = await this.sites.siteCandidates(telegramId, host);
      const landing = landingAssistSiteId(this.env);
      return (Array.isArray(sites) ? sites : []).filter(
        (s) => s && typeof s.siteId === 'string' && s.siteId !== landing,
      );
    } catch (e) {
      this.logger.warn(
        `кандидаты привязки к помощнику не получены: ${e instanceof Error ? e.name : 'error'}`,
      );
      if (!strict) return [];
      // Старый sites-backend без маршрута (404) и прочие 4xx — «нельзя».
      if (
        e instanceof SitesRejectedError ||
        e instanceof SitesNotConfiguredError
      )
        throw unavailable('кабинет помощника не может подобрать сайты');
      if (e instanceof SitesUnavailableError)
        throw new ServiceUnavailableException(
          'кабинет помощника сейчас недоступен — попробуйте позже',
        );
      throw e;
    }
  }

  private state(
    siteId: string | null,
    siteName: string | null,
    candidates: SitesSiteCandidate[],
  ): AssistLinkState {
    return {
      linked: !!siteId,
      siteId,
      siteName,
      canLink: candidates.length > 0,
      candidates: candidates.map((c) => ({ siteId: c.siteId, name: c.name })),
    };
  }

  async get(userId: string, projectId: string): Promise<AssistLinkState> {
    const draft = await this.ownDraft(userId, projectId);
    if (!draft) return this.state(null, null, []);
    const telegramId = await this.telegramIdOf(userId);
    const candidates = await this.candidatesFor(
      telegramId,
      draftHost(draft.baseUrl),
      false,
    );
    const siteId = draft.clientSiteId;
    let siteName: string | null =
      candidates.find((c) => c.siteId === siteId)?.name ?? null;
    // Привязан deep-link'ом к сайту, чей хост не совпал с черновиком, —
    // имя спросим прямо (то же правило ролей); не вышло — без имени.
    if (siteId && siteName === null && telegramId && this.sites.configured()) {
      siteName = await this.sites
        .linkSite(telegramId, siteId)
        .then((l) => l.siteName ?? null)
        .catch(() => null);
    }
    return this.state(siteId, siteName, candidates);
  }

  /** Привязать к `siteId` из кандидатов; `null` — отвязать. */
  async set(
    userId: string,
    projectId: string,
    siteId: string | null,
  ): Promise<AssistLinkState> {
    const draft = await this.ownDraft(userId, projectId);
    if (!draft) throw unavailable('черновик обучалки ещё не начат');
    const previous = draft.clientSiteId;
    if (siteId === null) {
      if (previous) {
        await this.prisma.clientSiteTutorialDraft.update({
          where: { id: draft.id },
          data: { clientSiteId: null },
        });
        await this.media.syncSite(previous);
      }
      const telegramId = await this.telegramIdOf(userId);
      const candidates = await this.candidatesFor(
        telegramId,
        draftHost(draft.baseUrl),
        false,
      );
      return this.state(null, null, candidates);
    }
    if (siteId === landingAssistSiteId(this.env)) {
      throw unavailable(
        'это сайт помощника лендинга генератора — к нему ролики обучалок по сайтам не привязываются',
      );
    }
    const telegramId = await this.telegramIdOf(userId);
    const candidates = await this.candidatesFor(
      telegramId,
      draftHost(draft.baseUrl),
      true,
    );
    const site = candidates.find((c) => c.siteId === siteId);
    if (!site) {
      throw unavailable(
        'этого сайта нет среди ваших сайтов помощника с адресом черновика (нужна роль владельца или менеджера помощника и подтверждённый адрес)',
      );
    }
    if (previous !== siteId) {
      await this.prisma.clientSiteTutorialDraft.update({
        where: { id: draft.id },
        data: { clientSiteId: siteId },
      });
      if (previous) await this.media.syncSite(previous);
    }
    // Набор — и при повторной привязке к тому же сайту: кнопка «привязать»
    // заодно дошлёт набор, который не дошёл по событию.
    await this.media.syncSite(siteId);
    return this.state(siteId, site.name, candidates);
  }
}
