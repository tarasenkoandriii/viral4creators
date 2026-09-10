/** Кто видит запись — spec §21.1/§21.3. */
export type LibraryVisibility = 'PUBLIC' | 'PRIVATE' | 'HIDDEN';

/** GET /library/recommend row and GET /library/:id — spec §21. */
export interface LibraryEntryView {
  id: string;
  sourceType: 'youtube' | 'upload';
  sourceUrl: string | null;
  title: string | null;
  thumbnailUrl: string | null;
  category: string | null;
  audienceGender: string | null;
  audienceAgeRange: string | null;
  audienceInterests: string[];
  aspectRatio: string | null;
  sceneCount: number;
  characterCount: number;
  usageCount: number;
  visibility: LibraryVisibility;
  /** True when this entry is private and belongs to the caller's session owner. */
  own: boolean;
  createdAt: string;
}

/** Строка админского списка (spec §21.1) — с модерационными полями. */
export interface AdminLibraryEntryView extends LibraryEntryView {
  sourceKey: string;
  hiddenReason: string | null;
  moderatedAt: string | null;
  ownerId: string | null;
  sessionId: string | null;
  updatedAt: string;
}

export interface AdminLibraryPage {
  items: AdminLibraryEntryView[];
  total: number;
  page: number;
  pageSize: number;
}

export interface LibraryRecommendation extends LibraryEntryView {
  /** 0–100 from the local ranking (no AI call) — see common/library.ts. */
  score: number;
  /** Why it is here, in the user's words. */
  reasons: string[];
}
