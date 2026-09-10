/**
 * AnalysisInsights — the structured half of the Gemini analysis (spec §18,
 * Stage 23), shown above the scene-breakdown text:
 *  - a strip of scene thumbnails with timecodes (frames grabbed in the
 *    browser from the uploaded file — §18.1; YouTube links get numbered
 *    placeholders and an honest note);
 *  - who the reference speaks to and what it sells (§18.2) — the two
 *    facts the relevance check compares with the product.
 */

import { Clapperboard, Film, ShoppingBag, Users } from 'lucide-react';
import { Badge, Card, CardHeader, Spinner } from '../../components/ui';
import { AudienceChips } from '../../components/AudienceCard';
import type { VideoAnalysis } from '../../types';
import { formatTime } from '../../lib/audience';
import { useI18n } from '../../lib/i18n-context';

export function AnalysisInsights({
  analysis,
  previewsStatus,
}: {
  /** Only the structured fields are read — any VideoAnalysis flavour fits. */
  analysis: Pick<VideoAnalysis, 'scenes' | 'audience' | 'promotedProduct'>;
  previewsStatus: 'idle' | 'capturing' | 'done' | 'unavailable';
}) {
  const { dict } = useI18n();
  const TIER_LABEL: Record<string, string> = dict.analysisInsights.tierLabels;
  const scenes = analysis.scenes ?? [];
  const hasPreviews = scenes.some((s) => s.previewUrl);
  const audience = analysis.audience;
  const promoted = analysis.promotedProduct;
  if (scenes.length === 0 && !audience && !promoted) return null;

  return (
    <Card className="p-5 animate-fadeIn">
      <CardHeader
        icon={<Clapperboard size={18} className="text-accent" />}
        title={dict.analysisInsights.title}
        hint={dict.analysisInsights.hint}
      />

      {scenes.length > 0 && (
        <div className="mb-4">
          <div className="mb-1.5 flex items-center gap-2">
            <span className="label !mb-0">
              {dict.analysisInsights.scenesCount.replace(
                '{{count}}',
                String(scenes.length)
              )}
            </span>
            {previewsStatus === 'capturing' && (
              <span className="inline-flex items-center gap-1 text-[11px] text-silver-400">
                <Spinner size={10} /> {dict.analysisInsights.capturingFrames}
              </span>
            )}
            {!hasPreviews && previewsStatus === 'unavailable' && (
              <span className="text-[11px] text-silver-400">
                {dict.analysisInsights.previewsUnavailable}
              </span>
            )}
          </div>
          <ul className="-mx-1 flex snap-x gap-2 overflow-x-auto px-1 pb-1">
            {scenes.map((s) => (
              <li
                key={s.id}
                className="w-32 shrink-0 snap-start overflow-hidden rounded-xl border border-silver-200/70 dark:border-silver-800"
              >
                <div className="relative aspect-video bg-silver-200/60 dark:bg-silver-800/60">
                  {s.previewUrl ? (
                    <img
                      src={s.previewUrl}
                      alt=""
                      className="h-full w-full object-cover"
                    />
                  ) : (
                    <div className="grid h-full place-items-center text-silver-400">
                      <Film size={18} />
                    </div>
                  )}
                  <span className="absolute bottom-1 left-1 rounded-md bg-silver-950/70 px-1.5 py-0.5 font-mono text-[11px] text-white tabular">
                    {formatTime(s.start)}–{formatTime(s.end)}
                  </span>
                </div>
                {/* padding on the wrapper, clamp on the inner block — Chrome
                    lets clamped text bleed into a padded box's padding */}
                <div className="p-1.5">
                  <p className="line-clamp-2 text-[11px] leading-snug">
                    {s.title}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {(audience || promoted) && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {audience && (
            <div className="rounded-xl border border-silver-200/70 p-3 dark:border-silver-800">
              <div className="mb-2 flex items-center gap-2">
                <Users size={14} className="text-accent" />
                <span className="label !mb-0">
                  {dict.analysisInsights.audienceTitle}
                </span>
              </div>
              <AudienceChips audience={audience} tone="accent" />
              {audience.summary && (
                <p className="mt-2 text-xs leading-relaxed text-silver-500 dark:text-silver-400">
                  {audience.summary}
                </p>
              )}
            </div>
          )}
          {promoted && (
            <div className="rounded-xl border border-silver-200/70 p-3 dark:border-silver-800">
              <div className="mb-2 flex items-center gap-2">
                <ShoppingBag size={14} className="text-accent" />
                <span className="label !mb-0">
                  {dict.analysisInsights.productTitle}
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-1">
                <Badge tone="accent">
                  {promoted.category ?? dict.analysisInsights.notAd}
                </Badge>
                {promoted.priceTier && (
                  <Badge>
                    {TIER_LABEL[promoted.priceTier] ?? promoted.priceTier}
                  </Badge>
                )}
              </div>
              {promoted.description && (
                <p className="mt-2 text-xs leading-relaxed text-silver-500 dark:text-silver-400">
                  {promoted.description}
                </p>
              )}
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
