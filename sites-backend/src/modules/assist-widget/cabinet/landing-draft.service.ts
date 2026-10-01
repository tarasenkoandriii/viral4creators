/**
 * Черновик вида с лендинга в кабинете («к Л3», интеграция Э2) — читатель
 * payload `wd_<id>`: TMA (LandingDraftScreen W4) берёт конфигурацию и
 * предлагает применить её к черновику вида выбранного сайта (запись —
 * обычным `PATCH …/widget/draft`, с правами manager).
 *
 * Таблица `assist_widget_drafts` вне тенанта (кабинета у анонимного
 * черновика нет) — читаем основной ролью (папка cabinet/ — исключение
 * правила графа `public-db`). Отдаём только существующий и не просроченный
 * черновик; конфигурацию повторно проверяем `parseWidgetConfig` (схема
 * могла измениться за 7 дней) и наружу — без `hosts` и без ссылок на
 * картинки (их у анонимного черновика быть не может; защита от старых строк).
 */
import { HttpException, Injectable } from '@nestjs/common';
import { SitesDb } from '../../../prisma/sites-db.service';
import { parseWidgetConfig } from '../../assist-site-setup/widget-config';

/** id из `wd_<id>`: start_param ≤ 64 символов [A-Za-z0-9_-]. */
const DRAFT_ID_RE = /^[A-Za-z0-9_-]{1,61}$/;

export interface LandingDraftView {
  config: Record<string, unknown>;
}

function notFound(): HttpException {
  return new HttpException(
    { error: 'NOT_FOUND', message: 'Черновик не найден или устарел' },
    404,
  );
}

@Injectable()
export class LandingDraftService {
  constructor(private readonly sites: SitesDb) {}

  async get(id: string, now = new Date()): Promise<LandingDraftView> {
    if (typeof id !== 'string' || !DRAFT_ID_RE.test(id)) throw notFound();
    const row = await this.sites
      .system('черновик вида с лендинга — вне кабинетов (wd_)')
      .assistWidgetDraft.findUnique({
        where: { id },
        select: { config: true, expiresAt: true },
      });
    if (!row || row.expiresAt.getTime() <= now.getTime()) throw notFound();
    const raw =
      row.config && typeof row.config === 'object' && !Array.isArray(row.config)
        ? (row.config as Record<string, unknown>)
        : null;
    if (!raw) throw notFound();
    const parsed = parseWidgetConfig({ ...raw, hosts: [] });
    if (!parsed.ok) throw notFound();
    const { hosts: _hosts, ...config } = parsed.config;
    const brand = config.brand;
    return {
      config: {
        ...config,
        brand: {
          ...brand,
          logoAssetId: null,
          avatar:
            brand.avatar.kind === 'asset'
              ? { kind: 'icon', icon: 'chat' }
              : brand.avatar,
        },
      },
    };
  }
}
