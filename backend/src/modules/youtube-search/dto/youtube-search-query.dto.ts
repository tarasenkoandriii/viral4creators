import { IsOptional, IsString, Length, Matches } from 'class-validator';

/**
 * Query string of GET /youtube-search. `regionCode` / `language` come from
 * the project's country (spec §9.1 — search is scoped to the item, and
 * the item's market decides which YouTube results are relevant); both are
 * optional so the anonymous quick path can search too.
 */
export class YoutubeSearchQueryDto {
  @IsString()
  @Length(1, 200, { message: 'q must be between 1 and 200 characters' })
  q!: string;

  /** ISO 3166-1 alpha-2, e.g. UA. */
  @IsOptional()
  @Matches(/^[A-Za-z]{2}$/, { message: 'regionCode must be 2 letters' })
  regionCode?: string;

  /** ISO 639-1, e.g. uk — YouTube's relevanceLanguage. */
  @IsOptional()
  @Matches(/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})?$/, {
    message: 'language must look like "uk" or "pt-BR"',
  })
  language?: string;
}
