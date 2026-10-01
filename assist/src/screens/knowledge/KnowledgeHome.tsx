import { BookOpen, Briefcase, MessageSquare } from 'lucide-react';
import { useAsync, useKit } from '../../kit';
import { Alert, Button, Card, ScreenTitle, Spinner } from '../../kit/ui';
import { useAssist } from '../../lib/assist-context';
import { canAdminKnowledge, canSiteKnowledge } from '../../lib/knowledge-view';
import { navigate } from '../../lib/router';
import { LoadError } from './parts';

/**
 * Раздел «Знания» из нижней навигации: выбор сайта и режима. Две базы —
 * две отдельные кнопки (§3.4: «два раздельных экрана, а не один с
 * флажком»); «для сотрудников» видна только владельцу «Админки».
 */
export function KnowledgeHome() {
  const { api, account, dict } = useKit();
  const { appDict } = useAssist();
  const t = appDict.knowledge;
  const siteOk = canSiteKnowledge(account.me);
  const adminOk = canAdminKnowledge(account.me);
  const sites = useAsync(
    () => (siteOk || adminOk ? api.listSites() : Promise.resolve([])),
    [api, siteOk, adminOk]
  );

  if (!siteOk && !adminOk) {
    return (
      <div className="space-y-4">
        <ScreenTitle>{t.homeTitle}</ScreenTitle>
        <Alert tone="warning">{t.noAccess}</Alert>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <ScreenTitle>{t.homeTitle}</ScreenTitle>
      <p className="text-sm text-silver-500">{t.homeIntro}</p>
      {sites.loading && !sites.data ? (
        <Spinner label={dict.common.loading} />
      ) : !sites.data ? (
        <LoadError error={sites.error} onRetry={sites.reload} />
      ) : sites.data.length === 0 ? (
        <Card className="space-y-2 text-sm">
          <div>{t.noSites}</div>
          <Button onClick={() => navigate({ name: 'onboarding-url' })}>
            {appDict.welcome.connect}
          </Button>
        </Card>
      ) : (
        sites.data.map((s) => (
          <Card key={s.id} className="space-y-2">
            <div className="font-semibold truncate">{s.name}</div>
            <div className="flex flex-wrap gap-2">
              {siteOk && (
                <>
                  <Button
                    variant="outline"
                    icon={<BookOpen size={16} />}
                    onClick={() =>
                      navigate({
                        name: 'knowledge',
                        siteId: s.id,
                        mode: 'site',
                        tab: 'overview',
                      })
                    }
                  >
                    {t.siteMode}
                  </Button>
                  <Button
                    variant="ghost"
                    icon={<MessageSquare size={16} />}
                    onClick={() => navigate({ name: 'sandbox', siteId: s.id })}
                  >
                    {t.sandbox}
                  </Button>
                </>
              )}
              {adminOk && (
                <Button
                  variant="outline"
                  icon={<Briefcase size={16} />}
                  onClick={() =>
                    navigate({
                      name: 'knowledge',
                      siteId: s.id,
                      mode: 'admin',
                      tab: 'overview',
                    })
                  }
                >
                  {t.adminMode}
                </Button>
              )}
            </div>
          </Card>
        ))
      )}
    </div>
  );
}

/**
 * Карточка «Помощник» над экраном сайта (экран сайта — общий с QA, в ките;
 * знания — только помощника, поэтому карточка здесь, а не в ките).
 */
export function SiteAssistCard({ siteId }: { siteId: string }) {
  const { account } = useKit();
  const { appDict } = useAssist();
  const t = appDict.siteCard;
  const siteOk = canSiteKnowledge(account.me);
  const adminOk = canAdminKnowledge(account.me);
  if (!siteOk && !adminOk) return null;
  return (
    <Card className="mb-4 space-y-2">
      <div className="font-semibold">{t.title}</div>
      <div className="flex flex-wrap gap-2">
        {siteOk && (
          <>
            <Button
              variant="outline"
              icon={<MessageSquare size={16} />}
              onClick={() => navigate({ name: 'sandbox', siteId })}
            >
              {t.sandbox}
            </Button>
            <Button
              variant="outline"
              icon={<BookOpen size={16} />}
              onClick={() =>
                navigate({
                  name: 'knowledge',
                  siteId,
                  mode: 'site',
                  tab: 'overview',
                })
              }
            >
              {t.siteKnowledge}
            </Button>
          </>
        )}
        {adminOk && (
          <Button
            variant="outline"
            icon={<Briefcase size={16} />}
            onClick={() =>
              navigate({
                name: 'knowledge',
                siteId,
                mode: 'admin',
                tab: 'overview',
              })
            }
          >
            {t.adminKnowledge}
          </Button>
        )}
      </div>
    </Card>
  );
}
