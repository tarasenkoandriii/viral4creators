/* СГЕНЕРИРОВАНО scripts/sync-site-tma-kit.mjs — не править. Источник: site-tma-kit/src/ui/StatusBadge.tsx */
import { useKit } from '../kit-context';
import { hostView, type HostView } from '../verification';
import type { SiteHost } from '../types';
import { Badge, type Tone } from './index';

const TONE: Record<HostView, Tone> = {
  pending: 'neutral',
  verified: 'success',
  failed: 'warning',
  expired: 'warning',
  revoked: 'danger',
};

export function StatusBadge({ host }: { host: SiteHost }) {
  const { dict } = useKit();
  const view = hostView(host, new Date());
  return <Badge tone={TONE[view]}>{dict.status[view]}</Badge>;
}
