/**
 * Каналы выгрузки — ТЗ §14 (этап 61). Mirrored in frontend/src/types и
 * admin/src/lib/types.ts. НИКОГДА не включает токены — ни здесь, ни в
 * ответах API (см. PublishingChannelService.toView).
 */

import { PublicationPlatform } from './publication.types';

export type ChannelStatus = 'ACTIVE' | 'REVOKED' | 'EXPIRED';

export interface PublishingChannelView {
  id: string;
  platform: PublicationPlatform;
  externalId: string;
  title: string;
  avatarUrl: string | null;
  status: ChannelStatus;
  createdAt: string;
  /**
   * Разрешил ли владелец канала грузить субтитры (скоуп
   * `youtube.force-ssl`, этап 137). У каналов, подключённых до этапа,
   * — `false`: право выдаётся только новым согласием, задним числом
   * добавить его нельзя. Экран по этому полю показывает «подключить
   * расширенно», а не молчит до отказа площадки.
   */
  captionsAllowed: boolean;
}
