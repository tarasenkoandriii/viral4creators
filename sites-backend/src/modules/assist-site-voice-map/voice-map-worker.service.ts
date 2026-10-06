/**
 * Голосовая карта × браузерный воркер Ш3 (Э6-тер (е) режим «Снимок» и
 * задание `assist-voice-map-check`; ТЗ §5-кватер.2, §5-кватер.10,
 * §5-кватер.13; Р-Э6т-9).
 *
 *  - «Снимок»: воркер открывает ПУБЛИЧНУЮ страницу verified-хоста «Сайта»
 *    (L1 `assist-crawl`, не admin-хост) в чистом контексте без cookie, без
 *    кликов и без отправки форм, снимает видимую область и список
 *    интерактивных элементов с рамками. TMA рисует скриншот и рамки; снимок
 *    живёт 24 ч (строка задания и приватный артефакт), в знания не идёт.
 *    Элементы в форме карты Ш4 уходят в общую карту источником `qa`
 *    (браузерный источник: воркер — раннер QA, QA-ТЗ §4.2).
 *  - Сверка карты (`voice-map-check`, тот же код, что Т-3 — «только
 *    разрешение дескрипторов, без кликов»): по образцам шаблонов версии
 *    (или опубликованной — тогда это Т-3 «потерявшиеся цели») воркер
 *    считает совпадения CSS-кандидатов целей и снимает страницу; сервер
 *    решает «нашлась ли цель» тем же `findInSnapshot`, что в бою, и
 *    считает устойчивость (`descriptorStability` с образцами). Модель плана
 *    (сухой прогон команд) — хвост.
 *
 * Без `BROWSER_WORKER_ENABLED` маршруты отвечают 409
 * `BROWSER_WORKER_DISABLED` (как до Ш3 — режима нет).
 */
import { HttpStatus, Injectable, OnModuleInit } from '@nestjs/common';
import { maskLabel, parseSnapshot } from '../assist-ui-core/snapshot';
import {
  descriptorCandidates,
  descriptorStability,
  findInSnapshot,
  parseVoiceMapContent,
  targetsForPage,
  type StabilitySample,
  type VoiceMapContent,
} from '../assist-ui-core/voice-map';
import { loadAssistSite } from '../assist-site-setup/widget-settings.service';
import { hostOrigin, lockHostName } from '../browser-jobs/browser-job-rules';
import {
  BrowserJobsService,
  type BrowserJobView,
} from '../browser-jobs/browser-jobs.service';
import {
  BrowserJobHandlers,
  type HandlerJob,
} from '../browser-jobs/job-handlers';
import {
  BROWSER_VIEWPORTS,
  WORKER_LIMITS,
  isSafeSelector,
  lockHostOf,
  type BrowserViewport,
  type DescriptorResolveResult,
  type UiSnapshotParams,
  type UiSnapshotResult,
} from '../browser-jobs/protocol';
import type { AccountMembership } from '../site-core/account/roles';
import {
  UiMapLimitError,
  ingestUiSnapshot,
} from '../site-core/ui-map/ui-map-store';
import { uiMapKey } from '../site-core/ui-map/ui-map';
import { voiceMapError } from './voice-map-errors';
import { VoiceMapService } from './voice-map.service';

export interface SnapshotElementView {
  ref: string;
  role: string;
  tag: string;
  text: string;
  assistId: string | null;
  href: string | null;
  toggle: boolean;
  submit: boolean;
  inForm: boolean;
  disabled: boolean;
  inView: boolean;
  box: { x: number; y: number; w: number; h: number } | null;
}

export interface SnapshotView {
  id: string;
  status: string;
  errorCode: string | null;
  url: string | null;
  title: string | null;
  viewport: { width: number; height: number } | null;
  elements: SnapshotElementView[];
  screenshot: {
    url: string;
    linkExpiresAt: Date;
    width: number | null;
    height: number | null;
  } | null;
  createdAt: Date;
  expiresAt: Date;
}

export interface WorkerCheckReport {
  version: number;
  pages: Array<{ path: string; ok: boolean; error: string | null }>;
  targets: Array<{
    key: string;
    samples: StabilitySample[];
    stability: 'strong' | 'medium' | 'fragile';
    lost: boolean;
  }>;
  lost: number;
  fragile: number;
}

const MAX_CHECK_PAGES = WORKER_LIMITS.descriptorPages;
const SAMPLES_PER_TEMPLATE = 3;

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

@Injectable()
export class VoiceMapWorkerService implements OnModuleInit {
  constructor(
    private readonly maps: VoiceMapService,
    private readonly jobs: BrowserJobsService,
    private readonly handlers: BrowserJobHandlers,
  ) {}

  onModuleInit(): void {
    this.handlers.register('voice-map-snapshot', {
      onDone: (j, r) => this.snapshotDone(j, r as UiSnapshotResult),
    });
    this.handlers.register('voice-map-check', {
      onDone: (j, r) => this.checkDone(j, r as DescriptorResolveResult),
    });
  }

  // ── «Снимок» ──────────────────────────────────────────────────────────

  async requestSnapshot(
    m: AccountMembership,
    siteId: string,
    body: unknown,
  ): Promise<{ snapshotId: string; status: string }> {
    this.jobs.assertEnabled();
    const db = this.maps.db(m.accountId);
    await loadAssistSite(db, m.accountId, siteId);
    if (
      !isObj(body) ||
      Object.keys(body).some((k) => k !== 'url' && k !== 'viewport')
    ) {
      throw voiceMapError(
        HttpStatus.BAD_REQUEST,
        'VOICE_MAP_INVALID',
        'Ожидается { url, viewport? }',
      );
    }
    const viewport = (body.viewport ?? 'mobile') as BrowserViewport;
    if (!(BROWSER_VIEWPORTS as readonly string[]).includes(viewport)) {
      throw voiceMapError(
        HttpStatus.BAD_REQUEST,
        'VOICE_MAP_INVALID',
        'viewport: mobile | desktop',
      );
    }
    let u: URL;
    try {
      u = new URL(String(body.url));
    } catch {
      throw voiceMapError(
        HttpStatus.BAD_REQUEST,
        'VOICE_MAP_INVALID',
        'Нужен адрес страницы',
      );
    }
    const hosts = await this.maps.siteHosts(db, siteId, new Date());
    const host = hosts.find(
      (h) =>
        lockHostName(h) === lockHostOf(u) &&
        `${h.scheme}:` === (u.protocol === 'http:' ? 'http:' : 'https:'),
    );
    if (
      !host ||
      u.username ||
      u.password ||
      u.href.length > WORKER_LIMITS.urlChars
    ) {
      throw voiceMapError(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'VOICE_MAP_INVALID',
        '«Снимок» — только публичная страница подтверждённого хоста этого сайта',
      );
    }
    u.hash = '';
    const params: UiSnapshotParams = {
      url: u.toString(),
      allowedHosts: [lockHostName(host)],
      viewport,
      screenshot: true,
      mapElements: true,
    };
    const job = await this.jobs.enqueue(m.accountId, {
      siteId,
      hostId: host.id,
      origin: 'voice-map-snapshot',
      params,
      requestedBy: `tg:${m.telegramId.toString()}`,
    });
    return { snapshotId: job.id, status: job.status };
  }

  /** Элементы, которые видел браузер воркера, — в общую карту Ш4 (`qa`). */
  private async snapshotDone(j: HandlerJob, r: UiSnapshotResult) {
    const key = uiMapKey(r.finalUrl);
    if (key && r.mapElements.length) {
      await ingestUiSnapshot(this.maps.db(j.accountId), {
        accountId: j.accountId,
        siteId: j.siteId,
        hostId: j.hostId,
        host: key.host,
        path: key.path,
        source: 'qa',
        viewport: (j.params as UiSnapshotParams).viewport,
        elements: r.mapElements,
      }).catch((e: unknown) => {
        // Потолок страниц карты — не повод терять сам снимок.
        if (!(e instanceof UiMapLimitError)) throw e;
      });
    }
    return r;
  }

  async snapshot(
    m: AccountMembership,
    siteId: string,
    sid: string,
  ): Promise<SnapshotView> {
    const db = this.maps.db(m.accountId);
    await loadAssistSite(db, m.accountId, siteId);
    const job = await this.jobs.view(m.accountId, sid, {
      siteId,
      origin: 'voice-map-snapshot',
    });
    if (!job) {
      throw voiceMapError(
        HttpStatus.NOT_FOUND,
        'VOICE_MAP_SNAPSHOT_NOT_FOUND',
        'Снимок не найден или истёк',
      );
    }
    const r = job.result as UiSnapshotResult | null;
    let screenshot: SnapshotView['screenshot'] = null;
    if (r && r.screenshot !== null) {
      const link = (await this.jobs.artifactLinks(m.accountId, job.id)).find(
        (a) => a.idx === r.screenshot,
      );
      if (link) {
        screenshot = {
          url: link.url,
          linkExpiresAt: link.linkExpiresAt,
          width: link.width,
          height: link.height,
        };
      }
    }
    return {
      id: job.id,
      status: job.status,
      errorCode: job.errorCode,
      url: r?.finalUrl ?? null,
      title: r ? maskLabel(r.snapshot.title) : null,
      viewport: r?.viewport ?? null,
      // Второй слой маски ПД: подписи уже маскировал воркер.
      elements: (r?.snapshot.elements ?? []).map((e) => ({
        ref: e.ref,
        role: e.role,
        tag: e.tag,
        text: maskLabel(e.text),
        assistId: e.assistId,
        href: e.href,
        toggle: e.toggle,
        submit: e.submit,
        inForm: e.inForm,
        disabled: e.disabled,
        inView: e.inView,
        box: e.box,
      })),
      screenshot,
      createdAt: job.createdAt,
      expiresAt: job.expiresAt,
    };
  }

  // ── сверка карты (`assist-voice-map-check`, Т-3) ──────────────────────

  private async versionContent(
    accountId: string,
    siteId: string,
    n: number,
  ): Promise<VoiceMapContent> {
    const v = await this.maps
      .db(accountId)
      .assistSiteVoiceMapVersion.findFirst({ where: { siteId, number: n } });
    if (!v) {
      throw voiceMapError(
        HttpStatus.NOT_FOUND,
        'VOICE_MAP_VERSION_NOT_FOUND',
        'Версия карты не найдена',
      );
    }
    return parseVoiceMapContent(v.content);
  }

  private versionNumber(n: string): number {
    const num = Number(n);
    if (!Number.isInteger(num) || num < 1) {
      throw voiceMapError(
        HttpStatus.NOT_FOUND,
        'VOICE_MAP_VERSION_NOT_FOUND',
        'Версия карты не найдена',
      );
    }
    return num;
  }

  /** Образцы страниц версии: шаблоны (до 3 образцов) + страницы целей. */
  static checkPaths(content: VoiceMapContent): string[] {
    const out = new Set<string>();
    for (const t of content.templates) {
      if (t.status !== 'active') continue;
      for (const p of t.samplePages.slice(0, SAMPLES_PER_TEMPLATE)) out.add(p);
    }
    for (const t of content.targets) {
      if (t.status === 'active' && t.scope === 'page' && t.pagePath) {
        out.add(t.pagePath);
      }
    }
    const list = [...out].filter((p) => p.startsWith('/') && !p.includes('*'));
    return (list.length ? list : ['/']).slice(0, MAX_CHECK_PAGES);
  }

  async requestCheck(
    m: AccountMembership,
    siteId: string,
    n: string,
  ): Promise<{ checkId: string; status: string }> {
    this.jobs.assertEnabled();
    const num = this.versionNumber(n);
    const db = this.maps.db(m.accountId);
    await loadAssistSite(db, m.accountId, siteId);
    const content = await this.versionContent(m.accountId, siteId, num);
    const hosts = await this.maps.siteHosts(db, siteId, new Date());
    const host = hosts[0];
    if (!host) {
      throw voiceMapError(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'VOICE_MAP_HOST_REQUIRED',
        'Нет подтверждённого публичного хоста сайта',
      );
    }
    const origin = hostOrigin(host);
    const targets = content.targets
      .filter((t) => t.status === 'active')
      .slice(0, WORKER_LIMITS.descriptorTargets)
      .map((t) => ({
        key: t.key,
        selectors: descriptorCandidates(t.descriptor)
          .map((c) => c.selector)
          .filter((s): s is string => isSafeSelector(s))
          .slice(0, WORKER_LIMITS.selectorsPerTarget),
      }));
    const job = await this.jobs.enqueue(m.accountId, {
      siteId,
      hostId: host.id,
      origin: 'voice-map-check',
      refId: `v${num}`,
      requestedBy: `tg:${m.telegramId.toString()}`,
      params: {
        pages: VoiceMapWorkerService.checkPaths(content).map(
          (p) => `${origin}${p}`,
        ),
        allowedHosts: [lockHostName(host)],
        viewport: 'desktop',
        targets,
      },
    });
    return { checkId: job.id, status: job.status };
  }

  private async checkDone(
    j: HandlerJob,
    r: DescriptorResolveResult,
  ): Promise<WorkerCheckReport> {
    const num = Number((j.refId ?? '').replace(/^v/, ''));
    const content = await this.versionContent(j.accountId, j.siteId, num);
    return VoiceMapWorkerService.report(num, content, r);
  }

  /**
   * Отчёт сверки: цель «нашлась» — по CSS-кандидатам (первый с
   * совпадениями — их число), без CSS — тем же `findInSnapshot`, что в
   * бою (разметка → путь ссылки → роль + видимый текст, только
   * единственное совпадение).
   */
  static report(
    version: number,
    content: VoiceMapContent,
    r: DescriptorResolveResult,
  ): WorkerCheckReport {
    const samples = new Map<string, StabilitySample[]>();
    const pages: WorkerCheckReport['pages'] = [];
    for (const pg of r.pages) {
      const path = new URL(pg.url).pathname;
      pages.push({ path, ok: pg.ok, error: pg.error });
      if (!pg.ok) continue;
      const snap = pg.snapshot ? parseSnapshot(pg.snapshot) : null;
      for (const t of targetsForPage(content, path)) {
        const counts = pg.counts[t.key] ?? [];
        let found: number;
        if (counts.length) {
          found = counts.find((c) => c > 0) ?? 0;
        } else {
          found = snap && findInSnapshot(t.descriptor, snap.elements) ? 1 : 0;
        }
        const list = samples.get(t.key) ?? [];
        list.push({ path, found });
        samples.set(t.key, list);
      }
    }
    const targets: WorkerCheckReport['targets'] = [];
    for (const t of content.targets) {
      const s = samples.get(t.key);
      if (!s?.length) continue;
      targets.push({
        key: t.key,
        samples: s,
        stability: descriptorStability(t.descriptor, s),
        lost: s.every((x) => x.found === 0),
      });
    }
    return {
      version,
      pages,
      targets,
      lost: targets.filter((t) => t.lost).length,
      fragile: targets.filter((t) => t.stability === 'fragile').length,
    };
  }

  async check(
    m: AccountMembership,
    siteId: string,
    n: string,
  ): Promise<BrowserJobView & { report: WorkerCheckReport | null }> {
    const num = this.versionNumber(n);
    const db = this.maps.db(m.accountId);
    await loadAssistSite(db, m.accountId, siteId);
    const job = await this.jobs.latest(m.accountId, {
      siteId,
      origin: 'voice-map-check',
      refId: `v${num}`,
    });
    if (!job) {
      throw voiceMapError(
        HttpStatus.NOT_FOUND,
        'VOICE_MAP_CHECK_NOT_FOUND',
        'Сверки этой версии не было',
      );
    }
    return {
      ...job,
      result: null,
      report: (job.result as WorkerCheckReport | null) ?? null,
    };
  }
}
