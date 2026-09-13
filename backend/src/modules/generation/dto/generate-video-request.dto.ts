import { IsIn, IsOptional, Matches } from 'class-validator';
import { VideoQuality } from '../../../common/types/generation.types';

/**
 * Request DTO for starting video generation.
 *
 * `quality` is the Fast/Standard switch: 'fast' (default) renders with
 * Veo 3.1 Lite — quicker and cheaper; 'standard' renders with full Veo 3.1
 * for a more "cinematic" result. See GenerationService.VEO_MODELS.
 *
 * `provider`/`resolution` — доп. запрос владельца продукта: Grok как
 * второй провайдер видео (ТЗ VEO-MODEL-VERSION-CHOICE-SPEC.md §10–11).
 * `resolution` имеет смысл только при `provider === 'grok'` — Veo
 * разрешение не запрашивает явно (§10.1 ТЗ); сервис игнорирует его для
 * `provider === 'veo'` (или отсутствующего — дефолт `'veo'`).
 */
export class GenerateVideoRequestDto {
  @IsOptional()
  @IsIn(['fast', 'standard'])
  quality?: VideoQuality;

  /**
   * Target picture format of the ad (spec §16): a standard ratio
   * ("9:16", "16:9", "3:4", "4:3", "1:1", "4:5") or a custom "W:H".
   * Defaults to the reference video's detected frame. Anything Veo
   * cannot render natively is rendered in the nearest 16:9 / 9:16 frame
   * with composition guidance for a later center-crop.
   */
  @IsOptional()
  @Matches(/^\d{1,5}:\d{1,5}$/, {
    message: 'aspectRatio must look like "9:16"',
  })
  aspectRatio?: string;

  @IsOptional()
  @IsIn(['veo', 'grok'])
  provider?: 'veo' | 'grok';

  @IsOptional()
  @IsIn(['480p', '720p', '1080p'])
  resolution?: '480p' | '720p' | '1080p';
}
