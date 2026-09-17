/**
 * BrandSnapshotEditor — spec §12 "Правки перед конкретной генерацией":
 * the session's COPY of the Brand Manifest (style notes, filters, effects)
 * editable on the analysis step. Saves go to PATCH /sessions/:id/brand-
 * manifest; the manifest itself never changes from here (open question
 * §12.3 — "save back" would be a separate explicit action, not built).
 * Brand characters from the copy are used by CharacterCasting's «Бренд»
 * tab; their list is not edited here.
 */

import { forwardRef, useEffect, useImperativeHandle, useState } from 'react';
import { Check, ChevronDown, ChevronUp, Lock, Palette } from 'lucide-react';
import {
  Alert,
  Button,
  Card,
  CardHeader,
  Field,
  Pills,
  Textarea,
} from '../../components/ui';
import { JsonField } from '../brand/JsonField';
import {
  errorMessage,
  updateBrandSnapshot,
  updateBrandManifest,
} from '../../services/projects-api';
import { cameraMoveHint, cameraMoveOptions } from '../../lib/camera-move';
import {
  subtitleThemeHint,
  subtitleThemeOptions,
} from '../../lib/subtitle-theme';
import type {
  BrandManifestSnapshot,
  CameraMove,
  VoiceMode,
  SubtitlesMode,
  SubtitleTheme,
} from '../../types';
import { VoicePicker } from '../brand/VoicePicker';
import { voiceModeHint } from '../../lib/voice-mode';
import type { JsonObject } from '../../types/project';
import { useI18n } from '../../lib/i18n-context';
import { useFeature } from '../../lib/plan-context';

/**
 * Мастер зовёт `flush()` перед уходом с шага разбора: карточка при этом
 * размонтируется, и несохранённый выбор голоса раньше пропадал молча —
 * ролик озвучивался не тем голосом, который человек видел на экране.
 * `false` — сохранить не удалось (ошибка сервера или невалидный JSON в
 * фильтрах/эффектах), причина уже показана в карточке, шаг не меняем.
 */
export interface BrandSnapshotEditorHandle {
  flush: () => Promise<boolean>;
}

export const BrandSnapshotEditor = forwardRef<
  BrandSnapshotEditorHandle,
  {
    sessionId: string;
    snapshot: BrandManifestSnapshot;
    onSaved: (s: BrandManifestSnapshot) => void;
  }
>(function BrandSnapshotEditor({ sessionId, snapshot, onSaved }, ref) {
  const { dict } = useI18n();
  const dub = useFeature('voiceDub');
  const [styleNotes, setStyleNotes] = useState(snapshot.styleNotes ?? '');
  const [voiceNotes, setVoiceNotes] = useState(snapshot.voiceNotes ?? '');
  const [cameraMove, setCameraMove] = useState<CameraMove>(
    snapshot.cameraMove ?? 'none'
  );
  // Этап 52 (В-1.6): режим озвучки и голос — для ЭТОГО ролика. ТЗ §15.1
  // обещало правку «там же, где стиль», сервер её принимал (DTO снимка),
  // а контролов не было: один ролик серии с другим голосом означал
  // менять манифест для всех остальных. Цена ошибки денежная — свой
  // голос это платный синтез на каждый прогон.
  const [voiceMode, setVoiceMode] = useState<VoiceMode>(
    snapshot.voiceMode ?? 'veo'
  );
  const [ttsVoiceId, setTtsVoiceId] = useState(snapshot.ttsVoiceId ?? '');
  const [subtitlesMode, setSubtitlesMode] = useState<SubtitlesMode>(
    snapshot.subtitlesMode ?? 'off'
  );
  const [subtitleTheme, setSubtitleTheme] = useState<SubtitleTheme>(
    snapshot.subtitleTheme ?? 'classic'
  );
  const [filters, setFilters] = useState<JsonObject | null>(snapshot.filters);
  const [effects, setEffects] = useState<JsonObject | null>(snapshot.effects);
  const [valid, setValid] = useState({ filters: true, effects: true });
  const [advanced, setAdvanced] = useState(
    snapshot.filters !== null || snapshot.effects !== null
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  // Доп. запрос владельца продукта: сохранить выбранный здесь голос
  // ПОСТОЯННО в брендбук (`BrandManifest.ttsVoiceId`), не только в
  // снимок этой сессии — чтобы не выбирать его заново в каждой новой
  // сессии того же бренда.
  const [savingVoiceToBrand, setSavingVoiceToBrand] = useState(false);
  const [voiceToBrandNote, setVoiceToBrandNote] = useState<string | null>(null);

  const dirty =
    (styleNotes.trim() || null) !== (snapshot.styleNotes ?? null) ||
    (voiceNotes.trim() || null) !== (snapshot.voiceNotes ?? null) ||
    cameraMove !== (snapshot.cameraMove ?? 'none') ||
    voiceMode !== (snapshot.voiceMode ?? 'veo') ||
    (ttsVoiceId.trim() || null) !== (snapshot.ttsVoiceId ?? null) ||
    subtitlesMode !== (snapshot.subtitlesMode ?? 'off') ||
    subtitleTheme !== (snapshot.subtitleTheme ?? 'classic') ||
    JSON.stringify(filters) !== JSON.stringify(snapshot.filters) ||
    JSON.stringify(effects) !== JSON.stringify(snapshot.effects);
  const canSave = dirty && valid.filters && valid.effects;

  useEffect(() => {
    if (savedAt === null) return;
    const t = window.setTimeout(() => setSavedAt(null), 2000);
    return () => window.clearTimeout(t);
  }, [savedAt]);

  const save = async (): Promise<boolean> => {
    if (!dirty) return true;
    if (!canSave) {
      setError(dict.brandSnapshotEditor.unsavedInvalid);
      return false;
    }
    setSaving(true);
    setError(null);
    try {
      const next = await updateBrandSnapshot(sessionId, {
        styleNotes: styleNotes.trim() || null,
        voiceNotes: voiceNotes.trim() || null,
        cameraMove,
        voiceMode,
        ttsVoiceId: ttsVoiceId.trim() || null,
        subtitlesMode,
        subtitleTheme,
        filters,
        effects,
      });
      onSaved(next);
      setSavedAt(Date.now());
      return true;
    } catch (e) {
      setError(errorMessage(e));
      return false;
    } finally {
      setSaving(false);
    }
  };

  const onSave = () => {
    void save();
  };

  useImperativeHandle(ref, () => ({ flush: save }));

  // Доп. запрос владельца продукта: сохранить выбранный голос в
  // брендбук постоянно. `snapshot.brandManifestId` может указывать на
  // манифест, который с тех пор удалили («for display only, may be
  // deleted later» — её же доккомментарий) — сервер ответит понятной
  // ошибкой, не крашем, `errorMessage()` её покажет как есть.
  //
  // Голос сохраняется сразу в ОБА места: в эту сессию и в брендбук.
  // Раньше кнопка писала только в брендбук, ответ «Сохранено в брендбук»
  // читался как «голос применён», а ролик озвучивался старым голосом
  // из копии сессии.
  const saveVoiceToBrand = async () => {
    setSavingVoiceToBrand(true);
    setVoiceToBrandNote(null);
    const voice = ttsVoiceId.trim() || null;
    try {
      const next = await updateBrandSnapshot(sessionId, { ttsVoiceId: voice });
      onSaved(next);
    } catch (e) {
      setVoiceToBrandNote(errorMessage(e));
      setSavingVoiceToBrand(false);
      return;
    }
    try {
      await updateBrandManifest(snapshot.brandManifestId, {
        ttsVoiceId: voice,
      });
      setVoiceToBrandNote(dict.brandSnapshotEditor.voiceSavedToBrand);
    } catch (e) {
      setVoiceToBrandNote(
        `${dict.brandSnapshotEditor.voiceSavedSessionOnly} ${errorMessage(e)}`
      );
    } finally {
      setSavingVoiceToBrand(false);
    }
  };

  return (
    <Card className="p-5 animate-fadeIn">
      <CardHeader
        icon={<Palette size={18} className="text-accent" />}
        title={dict.brandSnapshotEditor.title.replace(
          '{{title}}',
          snapshot.title
        )}
        hint={
          snapshot.editedAt
            ? dict.brandSnapshotEditor.hintEdited
            : dict.brandSnapshotEditor.hintDefault
        }
      />
      <div className="space-y-3">
        <Field
          label={dict.brandSnapshotEditor.styleLabel}
          htmlFor="snap-style"
          counter={`${styleNotes.length}/4000`}
        >
          <Textarea
            id="snap-style"
            rows={4}
            value={styleNotes}
            onChange={(e) => setStyleNotes(e.target.value.slice(0, 4000))}
            disabled={saving}
            placeholder={dict.brandSnapshotEditor.stylePlaceholder}
          />
        </Field>
        <Field
          label={dict.brandSnapshotEditor.voiceLabel}
          htmlFor="snap-voice"
          hint={dict.brandSnapshotEditor.voiceHint}
          counter={`${voiceNotes.length}/2000`}
        >
          <Textarea
            id="snap-voice"
            rows={2}
            value={voiceNotes}
            onChange={(e) => setVoiceNotes(e.target.value.slice(0, 2000))}
            disabled={saving}
            placeholder={dict.brandSnapshotEditor.voicePlaceholder}
          />
        </Field>

        <Field
          label={dict.brandSnapshotEditor.voiceModeLabel}
          hint={voiceModeHint(voiceMode, dict.voiceMode.hints)}
        >
          <Pills
            value={voiceMode}
            onChange={setVoiceMode}
            disabled={saving}
            columns={3}
            options={[
              {
                value: 'veo' as VoiceMode,
                label: dict.brandSnapshotEditor.voiceModeOptions.veo,
              },
              {
                value: 'voiceover' as VoiceMode,
                label: dict.brandSnapshotEditor.voiceModeOptions.voiceover,
              },
              {
                value: 'dub' as VoiceMode,
                label: dub.allowed ? (
                  dict.brandSnapshotEditor.voiceModeOptions.dub
                ) : (
                  <span className="inline-flex items-center gap-1">
                    <Lock size={9} />{' '}
                    {dict.brandSnapshotEditor.voiceModeOptions.dub}
                  </span>
                ),
                disabled: !dub.allowed,
              },
            ]}
          />
        </Field>
        {voiceMode !== 'veo' && (
          <VoicePicker
            value={ttsVoiceId}
            onChange={setTtsVoiceId}
            disabled={saving}
            voiceProvider={snapshot.ttsProvider}
            sessionId={sessionId}
          />
        )}

        {voiceMode !== 'veo' && ttsVoiceId.trim() && (
          <div className="mt-1 flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              loading={savingVoiceToBrand}
              disabled={saving || savingVoiceToBrand}
              onClick={() => void saveVoiceToBrand()}
            >
              {dict.brandSnapshotEditor.saveVoiceToBrandButton}
            </Button>
            {voiceToBrandNote && (
              <span className="text-xs text-silver-500">
                {voiceToBrandNote}
              </span>
            )}
          </div>
        )}

        {/* §29: движение камеры правится и здесь — в отличие от голоса,
            оно ничего не стоит и осмысленно меняется от ролика к ролику:
            предметный кадр и говорящий человек просят разного. */}
        <Field
          label={dict.brandSnapshotEditor.cameraMoveLabel}
          hint={cameraMoveHint(cameraMove, dict.cameraMove.hints)}
        >
          <Pills
            value={cameraMove}
            onChange={setCameraMove}
            disabled={saving}
            columns={2}
            options={cameraMoveOptions(dict.cameraMove.options)}
          />
        </Field>

        {/* Этап 67: субтитры для ЭТОГО ролика — тот же довод, что и у
            движения камеры: ничего не стоит и осмысленно меняется от
            ролика к ролику. */}
        <Field label={dict.brandSnapshotEditor.subtitlesModeLabel}>
          <Pills
            value={subtitlesMode}
            onChange={setSubtitlesMode}
            disabled={saving}
            columns={2}
            options={[
              {
                value: 'off' as SubtitlesMode,
                label: dict.brandSnapshotEditor.subtitlesModeOptions.off,
              },
              {
                value: 'on' as SubtitlesMode,
                label: dict.brandSnapshotEditor.subtitlesModeOptions.on,
              },
            ]}
          />
        </Field>

        {subtitlesMode === 'on' && (
          <Field
            label={dict.brandSnapshotEditor.subtitleThemeLabel}
            hint={subtitleThemeHint(subtitleTheme, dict.subtitleTheme.hints)}
          >
            <Pills
              value={subtitleTheme}
              onChange={setSubtitleTheme}
              disabled={saving}
              columns={3}
              options={subtitleThemeOptions(dict.subtitleTheme.options)}
            />
          </Field>
        )}

        <button
          type="button"
          onClick={() => setAdvanced((v) => !v)}
          className="inline-flex min-h-[44px] items-center gap-1 text-xs font-medium text-silver-500 hover:text-accent"
        >
          {advanced ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          {dict.brandSnapshotEditor.advancedToggle}
        </button>

        {advanced && (
          <div className="grid gap-3 sm:grid-cols-2">
            <JsonField
              id="snap-filters"
              label={dict.brandSnapshotEditor.filtersLabel}
              value={filters}
              disabled={saving}
              onChange={(v, ok) => {
                setFilters(v);
                setValid((s) => ({ ...s, filters: ok }));
              }}
            />
            <JsonField
              id="snap-effects"
              label={dict.brandSnapshotEditor.effectsLabel}
              value={effects}
              disabled={saving}
              onChange={(v, ok) => {
                setEffects(v);
                setValid((s) => ({ ...s, effects: ok }));
              }}
            />
          </div>
        )}

        {error && <Alert tone="error">{error}</Alert>}

        <div className="flex items-center justify-between gap-3">
          <span className="text-xs text-silver-400">
            {savedAt !== null ? (
              <span className="inline-flex items-center gap-1 text-emerald-500">
                <Check size={12} /> {dict.brandSnapshotEditor.saved}
              </span>
            ) : dirty ? (
              dict.brandSnapshotEditor.unsaved
            ) : (
              `${dict.brandSnapshotEditor.charactersNote.replace('{{count}}', String(snapshot.characters.length))}${
                (snapshot.scenes?.length ?? 0) > 0
                  ? (snapshot.scenes!.length === 1
                      ? dict.brandSnapshotEditor.scenesSuffixOne
                      : dict.brandSnapshotEditor.scenesSuffixOther
                    ).replace('{{count}}', String(snapshot.scenes!.length))
                  : ''
              }`
            )}
          </span>
          <Button
            size="sm"
            onClick={onSave}
            disabled={!canSave}
            loading={saving}
          >
            {dict.brandSnapshotEditor.save}
          </Button>
        </div>
      </div>
    </Card>
  );
});
