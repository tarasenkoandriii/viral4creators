/**
 * Движение камеры (§29, этап 46) человеческими словами.
 *
 * Копия текстов живёт отдельно от экранов, потому что выбор делается в
 * двух местах — в манифесте бренда и в копии для конкретного ролика, — а
 * два разных объяснения одной настройки читаются как две разные
 * настройки.
 *
 * Этап 56: сами тексты переехали в словарь (dict.cameraMove) — здесь
 * остаётся только стабильный порядок вариантов и подстановка перевода
 * по значению, чтобы состав списка не зависел от языка интерфейса.
 */
import type { CameraMove } from '../types';

const CAMERA_MOVE_VALUES: CameraMove[] = ['none', 'push-in'];

export function cameraMoveOptions(
  t: Record<CameraMove, string>
): { value: CameraMove; label: string }[] {
  return CAMERA_MOVE_VALUES.map((value) => ({ value, label: t[value] }));
}

/**
 * Подсказка объясняет не механику, а разницу в результате: «наезд» сам
 * по себе звучит технической деталью, ради которой никто не полезет
 * менять настройку.
 */
export function cameraMoveHint(
  move: CameraMove,
  t: Record<CameraMove, string>
): string {
  return t[move];
}
