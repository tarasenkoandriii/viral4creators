/**
 * AdminMusicCatalogService — каталог музыкальных тем поздравлений
 * (фича №4) на вкладке «Настройки».
 *
 * Тонкая обёртка над `PlatformSettingsService`, как и соседние
 * селекторы озвучки и разбора референса: настройка правится без
 * редеплоя, ключ один (`GREETING_MUSIC_SETTING_KEY`).
 *
 * Отличие от соседей — витрина. Там значение это одно слово из списка,
 * и показывать нечего; здесь оператор вставляет JSON, и главный вопрос
 * у него ровно один: «а что из этого приняли?». Разбор терпимый
 * (`parseMusicCatalog` молча пропускает негодные записи), и без ответа
 * на этот вопрос опечатка в ссылке выглядела бы как «сохранилось, но
 * темы не появилось».
 *
 * Поэтому `get`/`save` возвращают РАЗОБРАННЫЙ каталог рядом с сырым
 * текстом, а `save` вдобавок считает, сколько записей было в исходном
 * JSON и сколько из них выжило.
 */

import { BadRequestException, Injectable } from '@nestjs/common';
import { PlatformSettingsService } from '../../common/platform-settings.service';
import {
  GREETING_MUSIC_SETTING_KEY,
  MAX_MUSIC_THEMES,
  parseMusicCatalog,
} from '../../common/greeting-music';
import { GreetingMusicTheme } from '../../common/types/greeting.types';

/** Больше этого в настройку не пишем: это каталог, а не файлохранилище. */
const MAX_RAW_LENGTH = 64 * 1024;

export interface MusicCatalogView {
  /** Сырое значение настройки — то, что оператор редактирует. */
  raw: string;
  /** Что из него реально приняли. */
  themes: GreetingMusicTheme[];
  /** Сколько записей было в присланном JSON (если он вообще разобрался). */
  submitted: number | null;
  /** Сколько отброшено: `submitted - themes.length`. */
  rejected: number | null;
  maxThemes: number;
}

@Injectable()
export class AdminMusicCatalogService {
  constructor(private readonly settings: PlatformSettingsService) {}

  async get(): Promise<MusicCatalogView> {
    const raw = (await this.settings.get(GREETING_MUSIC_SETTING_KEY)) ?? '';
    return this.view(raw, raw);
  }

  /**
   * Пустая строка — осмысленное значение: это «выключить фичу», и
   * секция музыки в мастере пропадёт. Отказываем только в заведомо
   * бессмысленном: не-JSON и слишком большом тексте.
   */
  async save(raw: string, updatedBy?: string): Promise<MusicCatalogView> {
    const value = raw.trim();
    if (value.length > MAX_RAW_LENGTH) {
      throw new BadRequestException(
        `Слишком длинное значение: ${value.length} символов при пределе ${MAX_RAW_LENGTH}`,
      );
    }
    if (value && !this.isJson(value)) {
      // Терпимый разбор молча вернул бы пустой каталог, и оператор
      // решил бы, что дело в темах, а не в лишней запятой.
      throw new BadRequestException(
        'Это не JSON — проверьте кавычки и запятые',
      );
    }
    await this.settings.set(GREETING_MUSIC_SETTING_KEY, value, updatedBy);
    return this.view(value, value);
  }

  private view(raw: string, source: string): MusicCatalogView {
    const themes = parseMusicCatalog(raw);
    const submitted = this.countEntries(source);
    return {
      raw,
      themes,
      submitted,
      rejected: submitted === null ? null : submitted - themes.length,
      maxThemes: MAX_MUSIC_THEMES,
    };
  }

  private isJson(value: string): boolean {
    try {
      JSON.parse(value);
      return true;
    } catch {
      return false;
    }
  }

  /** Сколько записей было ДО фильтрации; `null` — разобрать не удалось. */
  private countEntries(value: string): number | null {
    if (!value.trim()) return 0;
    try {
      const parsed: unknown = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed.length;
      const themes = (parsed as { themes?: unknown })?.themes;
      return Array.isArray(themes) ? themes.length : null;
    } catch {
      return null;
    }
  }
}
