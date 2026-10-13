import { dict } from '@/lib/dict';
import { statusPage } from '@/lib/status-page';

/**
 * 410 для снятого материала (§13.3, аудит P3-22): сюда переписывает
 * middleware. Route handler не проходит через layout — своя простая
 * страница с `noindex`.
 */
export const dynamic = 'force-dynamic';

export function GET() {
  return statusPage(410, dict.meta.goneTitle, dict.errors.gone);
}
