/**
 * AI Publisher (P-G1) — часть маршрутов P-C, нужная экранам P-G1
 * (`calendar` — F09, запись публикации на карточке материала): каналы,
 * действия распространения, публикации (контракт
 * `contracts/distribution-api.ts`). Площадки, закупки, бюджет — P-G2
 * (`distribution-api.ts`); каналы и публикации P-G2 может брать отсюда.
 */

import type { PublisherHttp, Query } from './common-api';
import { seg } from './common-api';
import {
  bool,
  int,
  iso,
  isoOrNull,
  itemsOf,
  listPage,
  obj,
  oneOf,
  oneOfOrNull,
  str,
  strOrNull,
  type ListPage,
} from './decode';
import {
  CHANNEL_KINDS,
  CHANNEL_STATUSES,
  DISTRIBUTION_BLOCK_REASONS,
  DISTRIBUTION_STATUSES,
  PUBLICATION_STAGES,
  PUBLICATION_REPORT_KINDS,
  PUBLICATION_STATUSES,
  PUBLICATION_VERIFY_STATUSES,
  type DistributionBlockReason,
  type DistributionStatus,
} from './states';

export interface ChannelView {
  id: string;
  code: string;
  title: string;
  kind: (typeof CHANNEL_KINDS)[number];
  utmSource: string;
  utmMedium: string;
  adsAllowed: boolean | null;
  rulesNote: string | null;
  status: (typeof CHANNEL_STATUSES)[number];
  revision: number;
}

export interface DistributionActionView {
  id: string;
  versionId: string;
  contentId: string;
  channelId: string;
  format: string;
  goal: string;
  plannedAt: string;
  ownerMemberId: string;
  ownerDisplayName: string;
  status: DistributionStatus;
  blockReason: DistributionBlockReason | null;
  measurableUrl: string;
  publicationId: string | null;
  doneUrl: string | null;
  revision: number;
}

export interface PublicationView {
  id: string;
  versionId: string;
  channelId: string;
  approvalId: string;
  stage: (typeof PUBLICATION_STAGES)[number];
  finalUrl: string;
  publishedAt: string | null;
  status: (typeof PUBLICATION_STATUSES)[number];
  verifyStatus: (typeof PUBLICATION_VERIFY_STATUSES)[number];
  /** P-R M2: `user_reported` — со слов пользователя, проверки не бывает. */
  reportKind: (typeof PUBLICATION_REPORT_KINDS)[number];
  evidenceUrl: string | null;
  lastVerifiedAt: string | null;
  verifiedBy: string | null;
  verifyResult: string | null;
  revision: number;
}

export function decodeChannel(v: unknown): ChannelView {
  const o = obj(v, 'channel');
  return {
    id: str(o.id),
    code: str(o.code),
    title: str(o.title),
    kind: oneOf(o.kind, CHANNEL_KINDS, 'channel.kind'),
    utmSource: str(o.utmSource),
    utmMedium: str(o.utmMedium),
    adsAllowed:
      o.adsAllowed === null || o.adsAllowed === undefined
        ? null
        : bool(o.adsAllowed),
    rulesNote: strOrNull(o.rulesNote),
    status: oneOf(o.status, CHANNEL_STATUSES, 'channel.status'),
    revision: int(o.revision),
  };
}

export function decodeAction(v: unknown): DistributionActionView {
  const o = obj(v, 'action');
  return {
    id: str(o.id),
    versionId: str(o.versionId),
    contentId: str(o.contentId),
    channelId: str(o.channelId),
    format: str(o.format),
    goal: str(o.goal),
    plannedAt: iso(o.plannedAt),
    ownerMemberId: str(o.ownerMemberId),
    ownerDisplayName: str(o.ownerDisplayName),
    status: oneOf(o.status, DISTRIBUTION_STATUSES, 'action.status'),
    blockReason: oneOfOrNull(
      o.blockReason,
      DISTRIBUTION_BLOCK_REASONS,
      'action.blockReason'
    ),
    measurableUrl: str(o.measurableUrl),
    publicationId: strOrNull(o.publicationId),
    doneUrl: strOrNull(o.doneUrl),
    revision: int(o.revision),
  };
}

export function decodePublication(v: unknown): PublicationView {
  const o = obj(v, 'publication');
  return {
    id: str(o.id),
    versionId: str(o.versionId),
    channelId: str(o.channelId),
    approvalId: str(o.approvalId),
    stage: oneOf(o.stage, PUBLICATION_STAGES, 'publication.stage'),
    finalUrl: str(o.finalUrl),
    publishedAt: isoOrNull(o.publishedAt),
    status: oneOf(o.status, PUBLICATION_STATUSES, 'publication.status'),
    verifyStatus: oneOf(
      o.verifyStatus,
      PUBLICATION_VERIFY_STATUSES,
      'publication.verifyStatus'
    ),
    reportKind: oneOf(
      o.reportKind,
      PUBLICATION_REPORT_KINDS,
      'publication.reportKind'
    ),
    evidenceUrl: strOrNull(o.evidenceUrl),
    lastVerifiedAt: isoOrNull(o.lastVerifiedAt),
    verifiedBy: strOrNull(o.verifiedBy),
    verifyResult: strOrNull(o.verifyResult),
    revision: int(o.revision),
  };
}

// Тела мутаций — зеркало `*Body` contracts/distribution-api.ts без
// `opKey` (сверка ключей — `scripts/publisher-bodies.test.ts`).
export type CreateActionIn = {
  versionId: string;
  channelId: string;
  format: string;
  goal: string;
  plannedAt: string;
  ownerMemberId: string;
  ownerDisplayName?: string;
  targetUrl?: string;
};
export type ActionTransitionIn = {
  expectedRevision: number;
  to: 'blocked' | 'done' | 'cancelled' | 'planned';
  reason?: DistributionBlockReason;
  publicationId?: string;
};
export type CreatePublicationIn = {
  versionId: string;
  channelId: string;
  finalUrl?: string;
  pending?: boolean;
};
export type VerifyPublicationIn = {
  expectedRevision: number;
  result: 'ok' | 'mismatch' | 'unreachable';
  evidenceUrl?: string;
  note?: string;
};

export type CreateChannelIn = {
  code: string;
  title: string;
  /** `site` создаётся вместе с продуктом, второй не заводится. */
  kind: Exclude<(typeof CHANNEL_KINDS)[number], 'site'>;
  utmSource: string;
  utmMedium: string;
  adsAllowed?: boolean | null;
  rulesNote?: string | null;
};
export type PatchChannelIn = {
  expectedRevision: number;
  title?: string;
  utmSource?: string;
  utmMedium?: string;
  adsAllowed?: boolean | null;
  rulesNote?: string | null;
  status?: (typeof CHANNEL_STATUSES)[number];
};
export type PublicationTransitionIn = {
  expectedRevision: number;
  to: 'published' | 'failed' | 'withdrawn';
  reason?: string;
};

export function createCalendarApi(http: PublisherHttp, pid: string) {
  const P = `products/${seg(pid)}`;
  return {
    channels: async () =>
      itemsOf(await http.get(`${P}/channels`), decodeChannel),
    createChannel: async (b: CreateChannelIn, opKey?: string) =>
      decodeChannel(await http.send('POST', `${P}/channels`, b, opKey)),
    patchChannel: async (id: string, b: PatchChannelIn, opKey?: string) =>
      decodeChannel(
        await http.send('PATCH', `${P}/channels/${seg(id)}`, b, opKey)
      ),
    actions: async (q: Query = {}): Promise<ListPage<DistributionActionView>> =>
      listPage(await http.get(`${P}/distribution/actions`, q), decodeAction),
    createAction: async (b: CreateActionIn, opKey?: string) =>
      decodeAction(
        await http.send('POST', `${P}/distribution/actions`, b, opKey)
      ),
    actionTransition: async (
      id: string,
      b: ActionTransitionIn,
      opKey?: string
    ) =>
      decodeAction(
        await http.send(
          'POST',
          `${P}/distribution/actions/${seg(id)}/transition`,
          b,
          opKey
        )
      ),
    aiPlan: async (contentId: string, opKey?: string) =>
      http.send('POST', `${P}/distribution/plan`, { contentId }, opKey),
    publications: async (q: Query = {}): Promise<ListPage<PublicationView>> =>
      listPage(await http.get(`${P}/publications`, q), decodePublication),
    createPublication: async (b: CreatePublicationIn, opKey?: string) =>
      decodePublication(await http.send('POST', `${P}/publications`, b, opKey)),
    verifyPublication: async (
      id: string,
      b: VerifyPublicationIn,
      opKey?: string
    ) =>
      decodePublication(
        await http.send('POST', `${P}/publications/${seg(id)}/verify`, b, opKey)
      ),
    publicationTransition: async (
      id: string,
      b: PublicationTransitionIn,
      opKey?: string
    ) =>
      decodePublication(
        await http.send(
          'POST',
          `${P}/publications/${seg(id)}/transition`,
          b,
          opKey
        )
      ),
  };
}
export type CalendarApi = ReturnType<typeof createCalendarApi>;
