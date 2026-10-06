import { IsNumber, Max, Min } from 'class-validator';
import {
  TEMPO_FACTOR_MAX,
  TEMPO_FACTOR_MIN,
} from '../../tutorial-runner/tutorial-tempo';

/**
 * POST …/versions — «Сохранить» с выбранным темпом (темп обучалок в
 * постпродакшене, 06.10.2026). Множитель ПАУЗЫ: пресеты 1.5 / 1 / 0.4,
 * ползунок 0…2; сервер приводит его к шагу 0.05 (`normalizeTempoFactor`),
 * так что 0.4 и 0.4000001 — одна и та же версия.
 */
export class TutorialTempoRequestDto {
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(TEMPO_FACTOR_MIN)
  @Max(TEMPO_FACTOR_MAX)
  factor!: number;
}
