/**
 * «Транспорт Grok для одиночных роликов» — админская настройка
 * (доп. запрос владельца продукта, 14.09.2026). Тот же паттерн, что у
 * `AdminVideoProviderSettingsService`: значение в `PlatformSetting`,
 * чтение через чистый резолвер, смена действует сразу.
 */
import { BadRequestException, Injectable } from '@nestjs/common';
import { PlatformSettingsService } from '../../common/platform-settings.service';
import {
  GrokVideoTransportKey,
  GROK_VIDEO_TRANSPORT_SETTING_KEY,
  isGrokVideoTransportKey,
  resolveGrokVideoTransport,
} from '../generation/grok-video-transport';

export interface GrokTransportOptionView {
  key: GrokVideoTransportKey;
}

export interface GrokTransportSettingsView {
  active: GrokVideoTransportKey;
  source: 'admin' | 'env-default';
  options: GrokTransportOptionView[];
}

@Injectable()
export class AdminGrokTransportSettingsService {
  constructor(private readonly settings: PlatformSettingsService) {}

  private options(): GrokTransportOptionView[] {
    return [{ key: 'sync' }, { key: 'batch' }];
  }

  async get(): Promise<GrokTransportSettingsView> {
    const stored = await this.settings.get(GROK_VIDEO_TRANSPORT_SETTING_KEY);
    return {
      active: resolveGrokVideoTransport(stored),
      source: isGrokVideoTransportKey(stored) ? 'admin' : 'env-default',
      options: this.options(),
    };
  }

  async set(
    key: string,
    updatedBy: string,
  ): Promise<GrokTransportSettingsView> {
    if (!isGrokVideoTransportKey(key)) {
      throw new BadRequestException(`Неизвестный транспорт Grok: ${key}`);
    }
    await this.settings.set(GROK_VIDEO_TRANSPORT_SETTING_KEY, key, updatedBy);
    return this.get();
  }
}
