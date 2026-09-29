import { IsString, Length } from 'class-validator';

/**
 * PATCH /sessions/:sessionId/greeting-script — этап C ТЗ
 * docs-tz/TZ-Greeting-2.0-Adaptive-Persona-Landing.md §3.6 п.3.
 *
 * Только реплика: сцену сервер пересобирает сам из неё
 * (`buildSceneDescription`), чтобы сцена и озвучка не разошлись.
 * Потолок — тот же, что у `personalMessage` в брифе.
 */
export class UpdateGreetingScriptDto {
  @IsString()
  @Length(1, 2000)
  speech!: string;
}
