/**
 * Клиентские вызовы к маршрутам маркетплейса, требующим identity.
 * Identity приходит одним из двух путей (backend/src/modules/
 * telegram-auth/telegram-identity.middleware.ts решает, какой сильнее):
 * initData внутри Telegram (TMA-режим, см. lib/telegram.ts) — заголовок
 * X-Telegram-Init-Data; либо cookie-логин вне Telegram (lib/telegram-
 * login.ts) — идёт сама через credentials: 'include', без участия кода
 * здесь.
 *
 * ТЗ на маркетплейс §21 (бриф/подбор/совет по формату), §11.1 (лайки),
 * §21.8 (квиз исполнителя), §20 (публикация/шеринг).
 */

import { getAuthHeaders } from './telegram';
import type { PublicAuctionListing, PublicAuctionLiveState } from './api';

const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:3000/api';

/**
 * Аудит-фикс: раньше все ошибки заворачивались в голый Error с текстом
 * от бэкенда, и все формы показывали один и тот же общий текст
 * («войдите через Telegram и попробуйте снова») независимо от причины —
 * включая 409 «уже есть профиль», где этот совет не помогает вообще.
 * ApiError несёт status, чтобы вызывающий код мог различать 401/403
 * (не вошли), 409 (конфликт) и остальное.
 */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * Аудит (найдено при построении живого плеера аукциона, при добавлении
 * клиентского опроса `/auctions/:id/state`) — HIGH, задевает ВСЕ ~29
 * экспортов этого файла, не только новый код.
 *
 * Бэкенд оборачивает КАЖДЫЙ успешный ответ в `{success:true, data, meta}`
 * глобальным `ResponseInterceptor` (`backend/src/main.ts`:
 * `app.useGlobalInterceptors(new ResponseInterceptor())` — без исключений
 * по маршруту) и КАЖДУЮ ошибку — в `{error:{code,message}, meta}`
 * (`backend/src/common/filters/http-exception.filter.ts`). Серверный
 * аналог этого файла, `lib/api.ts`'s `fetchJson`, эту распаковку уже
 * делает (`body?.success ? body.data : body`) — доккомментарий там прямо
 * говорит «единый конверт у всего API». Админка (`admin/src/lib/
 * admin-api.ts`) делает то же самое и для ошибок (`body.error?.message`).
 *
 * Здесь, в клиентском хелпере для 'use client'-компонентов маркетплейса
 * (бид-форма, лайки, чек-аут, брифы, квиз, my-bids — весь интерактив,
 * не только живой аукцион), обеих распаковок не было ВООБЩЕ: успешный
 * путь отдавал `res.json()` как есть (то есть саму обёртку `{success,
 * data, meta}`, а не `data`), а путь ошибки читал `body?.message`
 * вместо `body?.error?.message` (`message` на этом объекте не существует
 * никогда — ошибка всегда лежит в `error.message` либо `error`-строкой).
 *
 * Баг не шумел: JS не бросает исключение на обращение к
 * несуществующему полю — `fresh.highestBidAmount` на необёрнутой обёртке
 * молча становился `undefined`, а не падал с ошибкой, и в `AuctionBidForm.
 * tsx`'s поллинге (см. его собственный «Аудит-фикс (свежесть ставки)»)
 * это тихо сводило на нет весь смысл фикса — «текущая ставка» после
 * первого тика заменялась на `undefined`. То же для сообщений об ошибках
 * — `body?.message` всегда `undefined`, и throw всегда падал в дефолтный
 * `request failed: ${res.status}`, что бы бэкенд ни написал в
 * `error.message` конкретно для этого случая.
 */
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...getAuthHeaders(), ...init?.headers },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: { message?: string } | string } | null;
    const err = body?.error;
    const message = typeof err === 'string' ? err : err?.message;
    throw new ApiError(res.status, message ?? `request failed: ${res.status}`);
  }
  if (res.status === 204) return undefined as T;
  const body = (await res.json()) as { success?: boolean; data?: T } | T;
  return ((body as { success?: boolean }).success ? (body as { data: T }).data : body) as T;
}

// ── Бриф / подбор без тендера (§21) ─────────────────────────────────

export interface CreateInquiryInput {
  productDescription: string;
  isProductLine?: boolean;
  goal?: string;
  targetPlatform: 'instagram_reels' | 'tiktok' | 'youtube_shorts' | 'youtube_long' | 'other';
  budgetHint?: number;
  brandManifestId?: string;
}

export interface InquiryView {
  id: string;
  status: string;
  targetPlatform: string;
  productDescription: string;
  contactedCreatorId?: string | null;
  brandManifestId?: string | null;
  createdAt?: string;
}

export function createInquiry(input: CreateInquiryInput): Promise<InquiryView> {
  return request('/creator-inquiries', { method: 'POST', body: JSON.stringify(input) });
}

/** «Мои брифы» (аудит-фикс — раньше нигде не вызывалось, listMine на бэкенде простаивал). */
export function getMyInquiries(): Promise<InquiryView[]> {
  return request('/creator-inquiries/mine');
}

/** Одна карточка брифа — нужна, чтобы восстановить contactedCreatorId при заходе на /brief/[id] заново. */
export function getInquiry(id: string): Promise<InquiryView> {
  return request(`/creator-inquiries/${id}`);
}

export interface InquiryMatchView {
  creatorProfileId: string;
  displayName: string | null;
  niches: string[];
  priceRangeMin: number | null;
  priceRangeMax: number | null;
  contactHandle: string | null;
  matchScore: number;
}

export function getInquiryMatches(id: string): Promise<InquiryMatchView[]> {
  return request(`/creator-inquiries/${id}/matches`);
}

export function contactCreator(inquiryId: string, creatorProfileId: string): Promise<InquiryView> {
  return request(`/creator-inquiries/${inquiryId}/contact`, {
    method: 'POST',
    body: JSON.stringify({ creatorProfileId }),
  });
}

export interface FormatAdviceView {
  targetPlatform: string;
  aspectRatio: string;
  quality: 'fast' | 'standard';
  note: string;
}

export function getFormatAdvice(inquiryId: string): Promise<FormatAdviceView> {
  return request(`/creator-inquiries/${inquiryId}/format-advice`);
}

// ── Лайки (§11.1) ────────────────────────────────────────────────────

export function likePortfolioItem(id: string): Promise<{ likeCount: number; likedByViewer: boolean }> {
  return request(`/portfolio-items/${id}/like`, { method: 'POST' });
}

export function unlikePortfolioItem(id: string): Promise<{ likeCount: number; likedByViewer: boolean }> {
  return request(`/portfolio-items/${id}/like`, { method: 'DELETE' });
}

/**
 * Аудит-фикс: серверный рендер (lib/api.ts) не прокидывает cookie
 * посетителя и кеширует ответ на всех сразу (next: { revalidate }), так
 * что likedByViewer с сервера ВСЕГДА false — даже для того, кто уже
 * лайкал. Этот клиентский запрос идёт с credentials: 'include' и без
 * общего кеша, поэтому даёт настоящее состояние для конкретного
 * посетителя; LikeButton дергает его один раз при монтировании и
 * перезаписывает то, что пришло с сервера.
 */
export function getPortfolioItemLikeState(
  id: string,
): Promise<{ likeCount: number; likedByViewer: boolean }> {
  return request(`/portfolio-items/${id}`);
}

// ── Портфолио: self-upload (§9, §11) ────────────────────────────────
// Аудит-фикс: этих трёх функций не было вообще — бэкенд POST /portfolio-
// items работал, но ни одна страница маркетплейса его не вызывала.

export type WatermarkModeValue = 'SITE_NAME' | 'CUSTOM' | 'NONE';
export type WatermarkIntensityValue = 'SLIGHT' | 'STANDARD' | 'STRONG';
export type WatermarkStatusValue = 'PENDING' | 'PROCESSING' | 'READY' | 'FAILED' | 'SKIPPED';

export interface PortfolioItemView {
  id: string;
  creatorProfileId: string;
  sourceType: string;
  videoUrl: string;
  title: string;
  thumbnailUrl: string | null;
  // Аудит-фикс: не включало SOLD, хотя оно есть с самого Этапа 1
  // аукциона (та же неточность, что была и на бэкенде) — «Продано»
  // на /my-portfolio без этого не типизировалось верно.
  status: 'PENDING' | 'PUBLISHED' | 'REJECTED' | 'SOLD';
  likeCount: number;
  viewCount: number;
  collectionTag: string | null;
  rejectionReason: string | null;
  likedByViewer: boolean;
  createdAt: string;
  /** Водяной знак на публичном превью (§9/§22, защита от пиратства). */
  watermarkMode: WatermarkModeValue;
  watermarkText: string | null;
  watermarkIntensity: WatermarkIntensityValue;
  watermarkStatus: WatermarkStatusValue;
  /** Аудит-фикс — были обещаны для карточки «Продано», но не отдавались API. */
  soldAt: string | null;
  soldPrice: number | null;
}

export interface CreatePortfolioItemInput {
  videoUrl: string;
  title: string;
  thumbnailUrl?: string;
  collectionTag?: string;
  watermarkMode?: WatermarkModeValue;
  watermarkText?: string;
  watermarkIntensity?: WatermarkIntensityValue;
}

export function createPortfolioItem(input: CreatePortfolioItemInput): Promise<PortfolioItemView> {
  return request('/portfolio-items', { method: 'POST', body: JSON.stringify(input) });
}

export function getMyPortfolioItems(): Promise<PortfolioItemView[]> {
  return request('/portfolio-items/mine');
}

export function withdrawPortfolioItem(id: string): Promise<void> {
  return request(`/portfolio-items/${id}`, { method: 'DELETE' });
}

export interface UpdatePortfolioItemInput {
  collectionTag?: string | null;
  watermarkMode?: WatermarkModeValue;
  watermarkText?: string | null;
  watermarkIntensity?: WatermarkIntensityValue;
}

export function updatePortfolioItem(id: string, input: UpdatePortfolioItemInput): Promise<PortfolioItemView> {
  return request(`/portfolio-items/${id}`, { method: 'PATCH', body: JSON.stringify(input) });
}

// ── Квиз исполнителя (§21.8) ─────────────────────────────────────────

export interface CreatorQuizInput {
  niches: string[];
  priceRangeMin?: number;
  priceRangeMax?: number;
  bio?: string;
  contactHandle?: string;
  slug?: string;
  socialLinks: { platform: 'instagram' | 'tiktok' | 'youtube' | 'other'; url: string }[];
  consent: boolean;
}

export interface CreatorProfileFullView {
  id: string;
  userId: string;
  displayName: string | null;
  slug: string | null;
  niches: string[];
  priceRangeMin: number | null;
  priceRangeMax: number | null;
  bio: string | null;
  isAcceptingOrders: boolean;
  contactHandle: string | null;
  socialLinks: { id: string; platform: string; url: string }[];
  viewCount: number;
  isFeatured: boolean;
  createdAt: string;
}

export function submitCreatorQuiz(input: CreatorQuizInput): Promise<CreatorProfileFullView> {
  return request('/creator-profiles/quiz', { method: 'POST', body: JSON.stringify(input) });
}

// ── Профиль: свои данные и редактирование (§21.8 — обещанная обратимость) ──
// Аудит-фикс: PATCH /creator-profiles/me существовал только на бэкенде —
// ни toggle isAcceptingOrders, ни редактирование ниш/bio/slug никогда не
// вызывались ни с одной страницы.

export function getMyCreatorProfile(): Promise<CreatorProfileFullView> {
  return request('/creator-profiles/me');
}

export interface UpdateCreatorProfileInput {
  isAcceptingOrders?: boolean;
  niches?: string[];
  priceRangeMin?: number | null;
  priceRangeMax?: number | null;
  bio?: string | null;
  contactHandle?: string | null;
  slug?: string | null;
  socialLinks?: { platform: 'instagram' | 'tiktok' | 'youtube' | 'other'; url: string }[];
}

export function updateMyCreatorProfile(input: UpdateCreatorProfileInput): Promise<CreatorProfileFullView> {
  return request('/creator-profiles/me', { method: 'PATCH', body: JSON.stringify(input) });
}

// ── Брендбук (§21.7) — переиспользует существующий backend/src/modules/
// brand-manifest как есть, независимый от Project (BrandManifest.userId).
// Фото персонажей/сцен НЕ подключены в этом проходе (отдельный presigned-
// Blob флоу upload-url → PUT → confirm) — текстовые label/description
// работают полностью, это осознанное сужение объёма, не заглушка.

const VOICE_MODES = ['veo', 'voiceover', 'dub'] as const;
export type VoiceMode = (typeof VOICE_MODES)[number];

export interface BrandManifestInput {
  title: string;
  styleNotes?: string;
  voiceNotes?: string;
  voiceMode?: VoiceMode;
}

export interface BrandManifestView {
  id: string;
  title: string;
  styleNotes: string | null;
  voiceNotes: string | null;
}

export function createBrandManifest(input: BrandManifestInput): Promise<BrandManifestView> {
  return request('/brand-manifests', { method: 'POST', body: JSON.stringify(input) });
}

export interface BrandCharacterInput {
  label: string;
  description?: string;
}

export interface BrandCharacterView {
  id: string;
  label: string | null;
  description: string | null;
}

export function addBrandCharacter(
  manifestId: string,
  input: BrandCharacterInput,
): Promise<BrandCharacterView> {
  return request(`/brand-manifests/${manifestId}/characters`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function addBrandScene(
  manifestId: string,
  input: BrandCharacterInput,
): Promise<BrandCharacterView> {
  return request(`/brand-manifests/${manifestId}/scenes`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

// ── §20 — публикация/шеринг: счётчики просмотров и аналитика для creator ──

/** Best-effort, намеренно проглатывает ошибки — счётчик не должен ронять страницу. */
export function recordCreatorView(id: string): Promise<void> {
  return request<void>(`/creators/${id}/view`, { method: 'POST' }).catch(() => undefined);
}

export function recordPortfolioView(id: string): Promise<void> {
  return request<void>(`/portfolio-items/${id}/view`, { method: 'POST' }).catch(() => undefined);
}

export interface CreatorStatsView {
  profileViewCount: number;
  totalPortfolioViews: number;
  totalLikes: number;
  itemCount: number;
}

export function getOwnStats(): Promise<CreatorStatsView> {
  return request('/creator-profiles/me/stats');
}

// ── Аукцион готовых видео (ТЗ на маркетплейс §22, Этап 2) ────────────
// Развязка от тендера: свой AuctionPayment/чек-аут через billing
// (WayForPay), не Contract/Escrow «Сейф 5%» — см. §22, начало раздела.

export type AuctionTypeValue = 'BLITZ' | 'STANDARD';
export type AuctionCurrencyValue = 'UAH' | 'USD' | 'EUR';
export type AuctionListingStatusValue =
  | 'PENDING_MODERATION'
  | 'QUEUED'
  | 'ACTIVE'
  | 'WON'
  | 'EXPIRED'
  | 'REJECTED'
  | 'WITHDRAWN';

/** Полная карточка — видна только владельцу через GET /auctions/mine. */
export interface AuctionListingView {
  id: string;
  creatorProfileId: string;
  portfolioItemId: string;
  brandManifestId: string | null;
  includeBrandManifest: boolean;
  auctionType: AuctionTypeValue;
  payoutCurrency: AuctionCurrencyValue;
  rightsConfirmedAt: string;
  expiresAt: string | null;
  aiAssessment: string | null;
  brandManifestAiAudit: string | null;
  startingPrice: number;
  reservePrice: number | null;
  buyNowPrice: number | null;
  status: AuctionListingStatusValue;
  rejectionReason?: string | null;
  highestBidAmount: number | null;
  bidCount: number;
  createdAt: string;
  /** Антиснайпер (§7.3) — явный чекбокс продавца при подаче заявки, не поведение по умолчанию. */
  antiSnipeEnabled: boolean;
  /** Сколько раз уже продлевались торги. */
  extensions: number;
}

export interface BidView {
  id: string;
  listingId: string;
  amount: number;
  createdAt: string;
}

export interface CreateAuctionListingInput {
  portfolioItemId: string;
  /** §22.6 — обязано быть true, сервер отклонит иначе. */
  rightsConfirmed: boolean;
  includeBrandManifest?: boolean;
  brandManifestId?: string;
  auctionType?: AuctionTypeValue;
  payoutCurrency?: AuctionCurrencyValue;
  /** Антиснайпер (§7.3) — явный чекбокс, не задан/false = торги без продления. */
  antiSnipeEnabled?: boolean;
  startingPrice: number;
  reservePrice?: number;
  buyNowPrice?: number;
}

/** Исполнитель ставит в очередь кандидата — сколько угодно, без ограничения на подачу (§22.1). */
export function createAuctionListing(input: CreateAuctionListingInput): Promise<AuctionListingView> {
  return request('/auctions', { method: 'POST', body: JSON.stringify(input) });
}

export function getMyAuctionListings(): Promise<AuctionListingView[]> {
  return request('/auctions/mine');
}

/** В любом статусе до WON (§22.1). */
export function withdrawAuctionListing(id: string): Promise<AuctionListingView> {
  return request(`/auctions/${id}`, { method: 'DELETE' });
}

/** Настоящие торги — резерв не проверяется здесь, только то, что ставка выше текущей лучшей (§22.1). */
export function placeBid(id: string, amount: number): Promise<BidView> {
  return request(`/auctions/${id}/bids`, { method: 'POST', body: JSON.stringify({ amount }) });
}

export interface AuctionCheckoutResult {
  wayforpayFormUrl?: string;
  wayforpayFields?: Record<string, string>;
}

/** Только победивший покупатель — сервер проверяет buyerId выигравшей ставки (§22.5). */
export function startAuctionCheckout(id: string): Promise<AuctionCheckoutResult> {
  return request(`/auctions/${id}/checkout`, { method: 'POST' });
}

/**
 * Закрывает реальный пробел: победитель обычных торгов (не «купить
 * сейчас») иначе никак не узнаёт, что выиграл — /auctions/:id к тому
 * моменту уже 404-ится (§22). По одной строке на лот, где есть хотя бы
 * одна своя ставка — не вся история ставок.
 */
export interface MyBidView {
  listingId: string;
  title: string;
  thumbnailUrl: string | null;
  myBidAmount: number;
  listingStatus: AuctionListingStatusValue;
  isWinner: boolean;
  paymentPaid: boolean;
}

export function getMyBids(): Promise<MyBidView[]> {
  return request('/auctions/my-bids');
}

/**
 * Живой опрос лота с клиента (не lib/api.ts — та версия для серверных
 * компонентов, читает API_BASE_URL без NEXT_PUBLIC_ и кеш Next.js).
 * Используется для того, чтобы «текущая ставка» на странице лота не
 * застревала на значении с момента серверного рендера — без этого
 * зритель не видел бы чужую ставку, пока сам не обновит страницу.
 * 404 (лот больше не ACTIVE — §22, «не должна оставлять мёртвые
 * публичные ссылки») превращается в null, не в исключение: это
 * ожидаемый исход опроса, не ошибка.
 */
export function getAuctionListingLive(id: string): Promise<PublicAuctionListing | null> {
  return request<PublicAuctionListing>(`/auctions/${id}`).catch((e) => {
    if (e instanceof ApiError && e.status === 404) return null;
    throw e;
  });
}

/**
 * Живой аукцион (Этап 5/6/7, §7.8) — клиентский опрос состояния эфира
 * (плейлист готовых подсказок + флаги) для LiveAuctionStream. Тот же
 * приём 404→null, что у getAuctionListingLive выше — хотя `/state` не
 * ограничивает себя статусом ACTIVE на бэкенде (в отличие от `/auctions/
 * :id`), сам лот теоретически может исчезнуть (см. доккомментарий
 * AuctionService.getLiveState).
 */
export function getAuctionLiveState(id: string): Promise<PublicAuctionLiveState | null> {
  return request<PublicAuctionLiveState>(`/auctions/${id}/state`).catch((e) => {
    if (e instanceof ApiError && e.status === 404) return null;
    throw e;
  });
}
