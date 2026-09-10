import { ArrayMaxSize, ArrayMinSize, IsArray, IsString } from 'class-validator';

/**
 * POST /sessions/:id/export — ярус A (доп. TODO §35,
 * `doc/MULTI-FORMAT-EXPORT-SPEC.md`, этап 75).
 *
 * `targets` — пресет из `PLATFORM_EXPORT_PRESETS` (`common/aspect-ratio.ts`)
 * ИЛИ голый формат «W:H»; сервис сам решает, что перед ним (`presetByKey`).
 * Все цели ОБЯЗАНЫ быть из того же семейства кадра, что уже отрендерен, —
 * иначе маршрут отвечает 400 с указанием, что для них нужен
 * `POST /export/rerender` (ярус B), а не эта дешёвая обрезка.
 */
export class StartExportRequestDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(6) // больше шести пресетов площадок пока не существует (§5 документа)
  @IsString({ each: true })
  targets!: string[];
}
