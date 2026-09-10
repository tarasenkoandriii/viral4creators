/**
 * Brand Manifests — list (spec §12 "Экран — управление манифестом").
 * A manifest is надпроектная: it lives here, in its own section, and is
 * attached to projects from the project side.
 */

import { MapPin, Palette, Plus, Users } from 'lucide-react';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  LockedNote,
  Spinner,
} from '../../components/ui';
import { listBrandManifests } from '../../services/projects-api';
import { useAsync } from '../../lib/useAsync';
import { useFeature } from '../../lib/plan-context';
import { navigate, routes } from '../../lib/router';
import { useI18n } from '../../lib/i18n-context';
import type { Locale } from '../../lib/i18n';
import { LoadError, ScreenHeader } from '../projects/shared';

export function ManifestsListScreen() {
  const { dict, locale } = useI18n();
  const { data, loading, error, reload } = useAsync(listBrandManifests, []);
  /**
   * ТЗ §23: создание манифеста — возможность старших режимов. Уже
   * созданные манифесты остаются рабочими в любом режиме: отнимать у
   * человека то, что он уже описал, было бы наказанием за смену режима.
   */
  const brand = useFeature('brandManifest');

  return (
    <div className="animate-fadeIn">
      <ScreenHeader
        title={dict.manifestsListScreen.title}
        hint={dict.manifestsListScreen.hint}
        action={
          brand.allowed ? (
            <Button
              size="sm"
              icon={<Plus size={14} />}
              onClick={() => navigate(routes.manifestNew())}
            >
              {dict.manifestsListScreen.newButton}
            </Button>
          ) : undefined
        }
      />

      {!brand.allowed && !brand.loading && (
        <div className="mb-3">
          <LockedNote
            title={dict.manifestsListScreen.lockedTitle}
            lock={brand.lock}
          >
            {dict.manifestsListScreen.lockedBody}
          </LockedNote>
        </div>
      )}

      {loading && (
        <div className="flex justify-center py-12">
          <Spinner size={28} />
        </div>
      )}
      {!loading && error ? <LoadError error={error} onRetry={reload} /> : null}

      {!loading && !error && data && data.length === 0 && (
        <EmptyState
          icon={<Palette size={30} />}
          title={dict.manifestsListScreen.emptyTitle}
          hint={dict.manifestsListScreen.emptyHint}
          action={
            brand.allowed ? (
              <Button
                icon={<Plus size={14} />}
                onClick={() => navigate(routes.manifestNew())}
              >
                {dict.manifestsListScreen.createButton}
              </Button>
            ) : undefined
          }
        />
      )}

      {!loading && !error && data && data.length > 0 && (
        <div className="space-y-2">
          {data.map((m) => (
            <Card
              key={m.id}
              className="p-4 cursor-pointer transition-colors hover:border-accent/60"
              onClick={() => navigate(routes.manifest(m.id))}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <Palette size={14} className="shrink-0 text-accent" />
                    <h3 className="truncate font-semibold">{m.title}</h3>
                  </div>
                  <p className="mt-0.5 text-xs text-silver-400">
                    {m.projectCount === 0
                      ? dict.manifestsListScreen.notUsed
                      : pluralForm(
                          m.projectCount,
                          locale,
                          dict.manifestsListScreen.usedInProjects
                        )}
                  </p>
                </div>
                <div className="flex shrink-0 gap-1">
                  <Badge tone={m.characterCount > 0 ? 'accent' : 'neutral'}>
                    <Users size={10} /> {m.characterCount}
                  </Badge>
                  <Badge tone={(m.sceneCount ?? 0) > 0 ? 'accent' : 'neutral'}>
                    <MapPin size={10} /> {m.sceneCount ?? 0}
                  </Badge>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Числовые формы через `Intl.PluralRules` (этап 56) — вместо жёстко
 * зашитых русских окончаний: у каждого языка словаря свой набор форм
 * (ru/uk — one/few/many, en/de/es — one/other), а не только пара
 * «единственное/множественное».
 */
function pluralForm(
  n: number,
  locale: Locale,
  forms: Partial<Record<Intl.LDMLPluralRule, string>>
): string {
  const rule = new Intl.PluralRules(locale).select(n);
  const template = forms[rule] ?? forms.other ?? '';
  return template.replace('{{n}}', String(n));
}
