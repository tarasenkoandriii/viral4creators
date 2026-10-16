import { StoryGiftsScreen } from '../stories/StoryGiftsScreen';
import { Clapperboard, Palette, Zap } from 'lucide-react';
import { Button } from '../../components/ui';
import { useI18n } from '../../lib/i18n-context';
import { navigate, routes, type ProductArea } from '../../lib/router';
import { ProjectsListScreen } from '../projects/ProjectsListScreen';

export function ProductHub({ area }: { area: ProductArea }) {
  const { dict } = useI18n();
  return (
    <div className="space-y-5">
      {area === 'stories' ? (
        <StoryGiftsScreen />
      ) : (
        <>
          {area === 'commerce' && (
            <p className="text-sm text-silver-400">
              {dict.productAreas.commerceHint}
            </p>
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
