/**
 * DTO для `VirtualStudioController`
 * (docs-tz/TZ-Virtualnaya-Studiya-i-AI-Vedushaya.md §5, Этап 1-3).
 */
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/** POST /admin/virtual-studio */
export class CreateVirtualStudioDto {
  @IsString()
  @MaxLength(200)
  name!: string;

  @IsString()
  @MaxLength(4000)
  refPrompt!: string;
}

/** POST /admin/virtual-studio/:id/variants (§3.2, §5) */
export class GenerateVariantDto {
  /** По умолчанию — `studio.refPrompt`; оператор может поправить перед повторной генерацией. */
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  prompt?: string;
}

/** POST /admin/virtual-studio/:id/fragments/video (§3.3, §5) */
export class CreateVideoFragmentDto {
  /** Hedra видна в форме, только если включён флаг §3.5 — контроллер
   * перепроверяет это на сервере, не доверяя только скрытому пункту формы. */
  @IsIn(['grok', 'hedra'])
  provider!: 'grok' | 'hedra';

  @IsString()
  @MaxLength(2000)
  prompt!: string;

  /** По умолчанию 10-12 с (§3.3) — 12, середина диапазона, если не задано. */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(15)
  durationSec?: number;

  @IsOptional()
  @IsIn(['1:1', '4:3', '3:4', '16:9', '9:16', '9:21', '21:9'])
  aspectRatio?: string;

  @IsOptional()
  @IsIn(['480p', '540p', '720p', '1080p'])
  resolution?: string;

  /**
   * Только для `provider: 'hedra'` — id уже готового (`status: 'complete'`)
   * VOICE-фрагмента ЭТОЙ ЖЕ студии, чья озвучка ведёт лип-синк (§4.2:
   * «синтезировать аудио под лип-синк ДО вызова Hedra»). Ссылка на уже
   * существующий фрагмент, а не текст реплики заново — та же реплика,
   * что оператор уже наговорил и прослушал через «Озвучить» (§3.3),
   * не второй, рассинхронизированный синтез той же фразы.
   */
  @IsOptional()
  @IsString()
  voiceFragmentId?: string;
}

/** POST /admin/virtual-studio/:id/fragments/voice (§3.3, §4.3, §5) */
export class CreateVoiceFragmentDto {
  @IsIn(['resemble', 'elevenlabs'])
  provider!: 'resemble' | 'elevenlabs';

  @IsString()
  @MaxLength(200)
  voiceId!: string;

  @IsString()
  @MaxLength(4000)
  text!: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  language?: string;
}

/** POST /admin/virtual-studio/:id/fragments/analysis (§3.3, §4.4, §5) */
export class CreateAnalysisFragmentDto {
  @IsString()
  @MaxLength(2000)
  sourceVideoUrl!: string;

  @IsOptional()
  @IsString()
  brandManifestId?: string;
}
