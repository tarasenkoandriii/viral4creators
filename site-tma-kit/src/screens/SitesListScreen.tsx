import { ChevronRight, Globe, Plus } from 'lucide-react';
import { useKit } from '../kit-context';
import { fmt } from '../i18n';
import { errorText } from '../errors';
import { canManage } from '../account-select';
import { useAsync } from '../use-async';
import { hostView } from '../verification';
import { Alert, Button, Card, ScreenTitle, Spinner } from '../ui';
import { StatusBadge } from '../ui/StatusBadge';

/** «Мои сайты» — сайты кабинета со статусами хостов. */
export function SitesListScreen({
  onOpenSite,
  onAddSite,
}: {
  onOpenSite: (siteId: string) => void;
  onAddSite: () => void;
}) {
  const { api, dict, account } = useKit();
  const manage = canManage(account.me.role);
  const sites = useAsync(() => api.listSites(), [api]);
  const now = new Date();

  return (
    <div>
      <ScreenTitle
        action={
          manage ? (
            <Button icon={<Plus size={16} />} onClick={onAddSite}>
              {dict.sites.add}
            </Button>
          ) : undefined
        }
      >
        {dict.sites.title}
      </ScreenTitle>

      {sites.loading && !sites.data && <Spinner label={dict.common.loading} />}
      {sites.error && (
        <Alert tone="danger" title={dict.common.error}>
          {errorText(sites.error, dict)}
          <div className="mt-2">
            <Button variant="outline" onClick={sites.reload}>
              {dict.common.retry}
            </Button>
          </div>
        </Alert>
      )}
      {sites.data && sites.data.length === 0 && (
        <Card className="text-center text-sm text-silver-500">
          <Globe className="mx-auto mb-2" size={28} />
          {dict.sites.empty}
        </Card>
      )}
      <div className="space-y-3">
        {sites.data?.map((site) => {
          const verified = site.hosts.filter(
            (h) => hostView(h, now) === 'verified'
          ).length;
          return (
            <button
              key={site.id}
              type="button"
              onClick={() => onOpenSite(site.id)}
              className="block w-full text-left"
            >
              <Card className="hover:border-accent transition-colors">
                <div className="flex items-center gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="font-semibold truncate">{site.name}</div>
                    <div className="text-xs text-silver-500">
                      {fmt(dict.sites.verifiedOf, {
                        v: verified,
                        n: site.hosts.length,
                      })}
                    </div>
                  </div>
                  <ChevronRight size={18} className="text-silver-400" />
                </div>
                <ul className="mt-2 space-y-1">
                  {site.hosts.map((h) => (
                    <li
                      key={h.id}
                      className="flex items-center justify-between gap-2 text-sm"
                    >
                      <span className="font-mono text-xs truncate">
                        {h.host}
                      </span>
                      <StatusBadge host={h} />
                    </li>
                  ))}
                </ul>
              </Card>
            </button>
          );
        })}
      </div>
    </div>
  );
}
