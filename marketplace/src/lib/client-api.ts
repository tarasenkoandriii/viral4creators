/**
 * Клиентские вызовы к маршрутам маркетплейса, требующим identity
 * (TelegramIdentityGuard на бэкенде — cookie из lib/telegram-login.ts
 * идёт вместе с каждым запросом через credentials: 'include').
 *
 * ТЗ на маркетплейс §21 (бриф/подбор/совет по формату), §11.1 (лайки),
 * §21.8 (квиз исполнителя), §20 (публикация/шеринг).
 */

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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new ApiError(res.status, body?.message ?? `request failed: ${res.status}`);
  }
  if (res.status === 204) return undefined as T;
  return res.json();
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

export interface PortfolioItemView {
  id: string;
  creatorProfileId: string;
  sourceType: string;
  videoUrl: string;
  title: string;
  thumbnailUrl: string | null;
  status: 'PENDING' | 'PUBLISHED' | 'REJECTED';
  likeCount: number;
  viewCount: number;
  collectionTag: string | null;
  rejectionReason: string | null;
  likedByViewer: boolean;
  createdAt: string;
}

export interface CreatePortfolioItemInput {
  videoUrl: string;
  title: string;
  thumbnailUrl?: string;
  collectionTag?: string;
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

export function updatePortfolioItem(
  id: string,
  input: { collectionTag?: string | null },
): Promise<{ id: string; collectionTag: string | null }> {
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
  return request(`/creators/${id}/view`, { method: 'POST' }).catch(() => undefined);
}

export function recordPortfolioView(id: string): Promise<void> {
  return request(`/portfolio-items/${id}/view`, { method: 'POST' }).catch(() => undefined);
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
