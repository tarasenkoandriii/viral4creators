/**
 * AdminAnalysisSettingsService — «Разбор референса по умолчанию» на
 * вкладке /settings (доп. запрос владельца продукта: тот же ручной
 * селектор, что уже есть для озвучки, ТЗ
 * VEO-MODEL-VERSION-CHOICE-SPEC.md §17).
 *
 * Тонкая обёртка над `PlatformSettingsService`, один в один по
 * структуре с `AdminVoiceoverSettingsService` — вся логика «что
 * считается активным, если ничего не задано» в чистой функции
 * `resolveDefaultAnalysisProvider`.
 */
import { BadRequestException, Injectable } from '@nestjs/common';
import { PlatformSettingsService } from '../../common/platform-settings.service';
import { loadConfiguration } from '../../config/configuration';
import {
  AnalysisProviderKey,
  DEFAULT_ANALYSIS_PROVIDER_SETTING_KEY,
  isAnalysisProviderKey,
  resolveDefaultAnalysisProvider,
} from '../analysis/default-analysis-provider';

export interface AnalysisProviderOptionView {
  key: AnalysisProviderKey;
  configured: boolean;
  /**
   * По прямому запросу владельца продукта: сам разбор через Grok ещё
   * не реализован (§17.3 ТЗ — извлечение кадров/вызов Image
   * Understanding/разбор в схему `VideoAnalysis`, отдельный объём
   * работы) — пункт показывается в интерфейсе, но выбрать его нельзя,
   * чтобы оператор не переключил разбор на путь, которого физически
   * ещё нет, а не просто «не настроен».
   */
  available: boolean;
  /** Почему `available: false` — показывается рядом с пунктом в интерфейсе. */
  unavailableReason?: string;
}

export interface AnalysisProviderSettingsView {
  active: AnalysisProviderKey;
  /** `admin` — задано явно из этого экрана; `env-default` — стенд ни
   * разу не трогал селектор, используется `gemini` по умолчанию. */
  source: 'admin' | 'env-default';
  options: AnalysisProviderOptionView[];
}

@Injectable()
export class AdminAnalysisSettingsService {
  constructor(private readonly settings: PlatformSettingsService) {}

  private options(): AnalysisProviderOptionView[] {
    return [
      // Gemini уже настроен всегда — это единственный путь, который
      // реально работал до этой фичи (см. GEMINI_API_KEY, тот же ключ,
      // что уже требует AnalysisService/GenerationService).
      { key: 'gemini', configured: true, available: true },
      {
        key: 'grok',
        configured: loadConfiguration().grok.apiKey.length > 0,
        // Ключ может быть настроен, а сам разбор — ещё нет: это два
        // разных вопроса, не сводим один к другому.
        available: false,
        unavailableReason:
          'Разбор видео через Grok ещё не реализован — доступен только Gemini',
      },
    ];
  }

  async get(): Promise<AnalysisProviderSettingsView> {
    const stored = await this.settings.get(
      DEFAULT_ANALYSIS_PROVIDER_SETTING_KEY,
    );
    return {
      active: resolveDefaultAnalysisProvider(stored),
      source: isAnalysisProviderKey(stored) ? 'admin' : 'env-default',
      options: this.options(),
    };
  }

  async setDefault(
    key: string,
    updatedBy: string,
  ): Promise<AnalysisProviderSettingsView> {
    if (!isAnalysisProviderKey(key)) {
      throw new BadRequestException(`Неизвестная модель разбора: ${key}`);
    }
    const option = this.options().find((o) => o.key === key);
    if (!option?.available) {
      throw new BadRequestException(
        option?.unavailableReason ?? `Модель разбора «${key}» недоступна`,
      );
    }
    await this.settings.set(
      DEFAULT_ANALYSIS_PROVIDER_SETTING_KEY,
      key,
      updatedBy,
    );
    return this.get();
  }
}
