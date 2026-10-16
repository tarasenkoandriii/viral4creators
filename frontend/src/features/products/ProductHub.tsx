import { BookOpen, Clapperboard, Palette, Zap } from 'lucide-react';
import { Button, Card } from '../../components/ui';
import { useI18n } from '../../lib/i18n-context';
import { navigate, routes, type ProductArea } from '../../lib/router';
import { ProjectsListScreen } from '../projects/ProjectsListScreen';

export function ProductHub({ area }: { area: ProductArea }) {
  const { dict } = useI18n();
  const t = dict.productAreas;
  return (
    <div className="space-y-5">
      {area === 'stories' ? (
        <Card className="p-5 space-y-4">
          <BookOpen size={28} className="text-accent" />
          <h1 className="text-xl font-semibold">{t.stories}</h1>
          <p className="text-sm text-silver-400">{t.storiesHint}</p>
          <p className="text-sm">{t.ready}</p>
          <Button onClick={() => navigate(routes.manifests())}>
            {t.narrator}
          </Button>
        </Card>
      ) : (
        <>
          {area === 'commerce' && (
            <p className="text-sm text-silver-400">{t.commerceHint}</p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="ghost"
              icon={<Palette size={14} />}
              onClick={() => navigate(routes.manifests())}
            >
              {dict.nav.brand}
            </Button>
            {area === 'commerce' && (
              <Button
                size="sm"
                variant="ghost"
                icon={<Zap size={14} />}
                onClick={() => navigate(routes.generate())}
              >
                {dict.nav.generate}
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              icon={<Clapperboard size={14} />}
              onClick={() => navigate(routes.postprod())}
            >
              {dict.nav.postprod}
            </Button>
          </div>
          <ProjectsListScreen key={area} area={area} />
        </>
      )}
    </div>
  );
}
