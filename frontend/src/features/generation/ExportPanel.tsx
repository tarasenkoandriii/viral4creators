/**
 * ExportPanel — автоэкспорт готового ролика под несколько площадок сразу
 * (TODO §III, «Уровень 6», п.35; `doc/MULTI-FORMAT-EXPORT-SPEC.md`, этап
 * 75). Показывается на экране готового ролика, там же, где
 * CatalogBatchPanel/AbTestPanel.
 *
 * ## Почему чекбоксы и «перерендерить» — разные виджеты, не один список
 *
 * Ярус A (дёшево, обрезка уже готового файла из ТОГО ЖЕ семейства кадра
 * — `aspectRatioFamily`) и ярус B (дорого, второй платный рендер Veo для
 * формата из ДРУГОГО семейства) — разные по цене и по риску действия
 * (§3 документа): отметить лишнюю галочку в общем списке не должно
 * заказывать платный повторный рендер случайно. Поэтому пресеты того же
 * семейства, что уже отрендерено, идут чекбоксами с одной кнопкой
 * «Экспортировать» (один batched-запрос, одно списание), а пресеты
 * другого семейства — отдельными кнопками «Перерендерить» каждый со
 * своей явной ценой.
 *
 * ## Свой опрос статуса, а не общий цикл экрана
 *
 * Автоэкспорт запрашивается ПОСЛЕ того, как общий опрос генерации/
 * постобработки (`useWorkflow.startVideoPolling`) уже остановился —
 * ролик готов, ждать основному циклу больше нечего. Заводить второй
 * канал в тот же `useWorkflow` ради необязательного, редко используемого
 * действия было бы лишней связностью; вместо этого панель опрашивает
 * `GET /export/status` сама, только пока есть хотя бы один вариант в
 * статусе `pending`, — тем же приёмом самопланирующегося `setTimeout`,
 * что `AbTestProgressScreen`/`CatalogBatchProgressScreen` (не
 * `setInterval`: ответ не должен наложиться на следующий тик, а сетевая
 * икота не должна останавливать опрос навсегда — Д-5.3 пятого аудита).
 */

import { useEffect, useRef, useState } from 'react';
import { Download, Loader2, Repeat, Sparkles, XCircle } from 'lucide-react';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardHeader,
  LockedNote,
} from '../../components/ui';
import {
  getExportStatus,
  startExportBatch,
  startExportRerender,
} from '../../services/export-api';
import { errorMessage } from '../../services/projects-api';
import { EXPORT_PRESETS, aspectRatioFamily } from '../../lib/aspect-ratio';
import { useFeature } from '../../lib/plan-context';
import { useI18n } from '../../lib/i18n-context';
import type { ExportVariant } from '../../types';
import type { GeneratedVideo } from '../../services/api';

const POLL_MS = 5000;

export function ExportPanel({
  sessionId,
  video,
}: {
  sessionId: string;
  video: GeneratedVideo;
}) {
  const { dict } = useI18n();
  const feature = useFeature('customAspectRatio');
  // Ярус B — второй платный рендер ТЕМ ЖЕ качеством, что у исходного
  // ролика (Ж-1, этап 123). Если режим с тех пор понизили, полная
  // модель этому человеку уже закрыта, и сервер ответит 403 — а экран
  // об этом не предупреждал ничем. Понижать качество молча нельзя: это
  // другой ролик, а не тот, который человек заказывает.
  const fullQuality = useFeature('fullQualityVideo');
  const rerenderLocked =
    video.quality === 'standard' &&
    !fullQuality.loading &&
    !fullQuality.allowed;
  const [variants, setVariants] = useState<ExportVariant[]>(
    video.exportVariants ?? []
  );
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [batchBusy, setBatchBusy] = useState(false);
  const [rerenderBusy, setRerenderBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<number | undefined>(undefined);

  const schedulePoll = () => {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(async () => {
      try {
        const updated = await getExportStatus(sessionId);
        setVariants(updated.exportVariants ?? []);
        if (
          (updated.exportVariants ?? []).some((v) => v.status === 'pending')
        ) {
          schedulePoll();
        }
      } catch {
        // Сетевая икота не должна останавливать опрос навсегда — тот же
        // урок, что Д-5.3 пятого аудита: следующий тик всё равно
        // планируем, как только сеть отойдёт, опрос сам восстановится.
        schedulePoll();
      }
    }, POLL_MS);
  };

  useEffect(() => {
    if (variants.some((v) => v.status === 'pending')) schedulePoll();
    return () => {
      if (timer.current) window.clearTimeout(timer.current);
    };
    // Только на монтирование — реагировать на каждое изменение variants
    // не нужно: после ручного запуска опрос планируется явно ниже.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (feature.loading) return null;

  // Автоэкспорт режет файл, который отдаёт основная постобработка —
  // пока она не завершилась (озвучка/субтитры/кроп ещё в работе),
  // резать нечего: `downloadUrl` в этот момент ещё может указывать на
  // необработанный ролик Veo.
  if (video.postStatus === 'pending') return null;

  if (!feature.allowed) {
    return (
      <LockedNote title={dict.exportPanel.panelTitle} lock={feature.lock}>
        {dict.exportPanel.panelLockedBody}
      </LockedNote>
    );
  }

  const renderedFamily = aspectRatioFamily(
    video.renderedAspectRatio ?? video.aspectRatio ?? '9:16'
  );

  const variantFor = (format: string) =>
    variants.find((v) => v.format === format);

  const toggle = (key: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const onExportSelected = async () => {
    if (selected.size === 0) return;
    setBatchBusy(true);
    setError(null);
    try {
      const updated = await startExportBatch(sessionId, Array.from(selected));
      setVariants(updated.exportVariants ?? []);
      setSelected(new Set());
      schedulePoll();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBatchBusy(false);
    }
  };

  const onRerender = async (format: string, preset: string) => {
    if (rerenderLocked) return;
    setRerenderBusy(format);
    setError(null);
    try {
      const result = await startExportRerender(
        sessionId,
        format,
        preset,
        video.quality
      );
      setVariants(result.video.exportVariants ?? []);
      schedulePoll();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setRerenderBusy(null);
    }
  };

  const presetLabel = (key: string) =>
    dict.exportPanel.presets[key as keyof typeof dict.exportPanel.presets] ??
    key;

  const tierARows: { key: string; format: string; existing?: ExportVariant }[] =
    [];
  const tierBRows: { key: string; format: string; existing?: ExportVariant }[] =
    [];

  for (const preset of EXPORT_PRESETS) {
    if (preset.format === video.aspectRatio) continue; // уже этот формат — экспортировать некуда
    const existing = variantFor(preset.format);
    const row = { key: preset.key, format: preset.format, existing };
    if (aspectRatioFamily(preset.format) === renderedFamily)
      tierARows.push(row);
    else tierBRows.push(row);
  }

  const selectableA = tierARows.filter((r) => !r.existing);

  return (
    <Card className="p-5 animate-fadeIn">
      <CardHeader
        icon={<Sparkles size={18} className="text-accent" />}
        title={dict.exportPanel.panelTitle}
        hint={dict.exportPanel.panelHint}
      />

      {error && (
        <Alert tone="error" className="mb-3" onDismiss={() => setError(null)}>
          {error}
        </Alert>
      )}

      {tierARows.length > 0 && (
        <div className="mb-4">
          <p className="mb-2 text-xs font-medium text-silver-500">
            {dict.exportPanel.tierALabel}
          </p>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {tierARows.map((row) =>
              row.existing ? (
                <VariantStatus
                  key={row.key}
                  label={presetLabel(row.key)}
                  variant={row.existing}
                />
              ) : (
                <Button
                  key={row.key}
                  variant="outline"
                  size="sm"
                  active={selected.has(row.key)}
                  onClick={() => toggle(row.key)}
                >
                  {presetLabel(row.key)}
                </Button>
              )
            )}
          </div>
          {selectableA.length > 0 && (
            <>
              <Button
                block
                className="mt-3"
                variant="solid"
                loading={batchBusy}
                disabled={selected.size === 0}
                icon={<Download size={14} />}
                onClick={() => void onExportSelected()}
              >
                {dict.exportPanel.exportCta}
              </Button>
              <p className="mt-1 text-xs text-silver-400">
                {dict.exportPanel.tierACreditsNote}
              </p>
            </>
          )}
        </div>
      )}

      {tierBRows.length > 0 && (
        <div>
          <p className="mb-2 text-xs font-medium text-silver-500">
            {dict.exportPanel.tierBLabel}
          </p>
          <div className="space-y-2">
            {tierBRows.map((row) =>
              row.existing ? (
                <VariantStatus
                  key={row.key}
                  label={presetLabel(row.key)}
                  variant={row.existing}
                />
              ) : (
                <div
                  key={row.key}
                  className="flex items-center justify-between gap-2 rounded-xl border border-silver-300 px-3 py-2 dark:border-silver-700"
                >
                  <span className="text-sm">{presetLabel(row.key)}</span>
                  <Button
                    variant="outline"
                    size="sm"
                    icon={<Repeat size={14} />}
                    loading={rerenderBusy === row.format}
                    disabled={rerenderLocked}
                    onClick={() => void onRerender(row.format, row.key)}
                  >
                    {dict.exportPanel.rerenderCta}
                  </Button>
                </div>
              )
            )}
          </div>
          <p className="mt-2 text-xs text-silver-400">
            {dict.exportPanel.tierBNote}
          </p>
          {rerenderLocked && (
            <div className="mt-2">
              <LockedNote
                title={dict.generationWizard.qualityLockedTitle}
                lock={fullQuality.lock}
                compact
              >
                {dict.exportPanel.rerenderQualityLockedBody}
              </LockedNote>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

/** Готовый/ожидающий/упавший вариант — статус вместо действия. */
function VariantStatus({
  label,
  variant,
}: {
  label: string;
  variant: ExportVariant;
}) {
  const { dict } = useI18n();
  return (
    <div className="flex items-center justify-between gap-2 rounded-xl border border-silver-300 px-3 py-2 text-sm dark:border-silver-700">
      <span className="truncate">{label}</span>
      {variant.status === 'pending' && (
        <Badge tone="warning">
          <Loader2 size={11} className="animate-spin" />
          {dict.exportPanel.statusPending}
        </Badge>
      )}
      {variant.status === 'failed' && (
        <span title={variant.error} className="shrink-0">
          <Badge tone="danger">
            <XCircle size={11} />
            {dict.exportPanel.statusFailed}
          </Badge>
        </span>
      )}
      {variant.status === 'complete' && variant.url && (
        <a
          href={variant.url}
          target="_blank"
          rel="noreferrer"
          className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-accent hover:underline"
        >
          <Download size={12} />
          {dict.exportPanel.statusComplete}
        </a>
      )}
    </div>
  );
}
