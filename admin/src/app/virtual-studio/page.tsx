'use client';

// Виртуальная студия (docs-tz/TZ-Virtualnaya-Studiya-i-AI-Vedushaya.md,
// Этап 1-3) — admin-only инструмент подготовки «ИИ-ведущей»: постоянный
// референс-кадр + видео/голос/анализ-фрагменты. По стилю — тот же
// подход, что и /actors: одна страница, минимум вложенности, поллинг
// статуса для асинхронных (видео) фрагментов.

import { useEffect, useRef, useState } from 'react';
import {
  createVirtualStudio,
  createVirtualStudioAnalysisFragment,
  createVirtualStudioVideoFragment,
  createVirtualStudioVoiceFragment,
  deleteVirtualStudio,
  deleteVirtualStudioFragment,
  deleteVirtualStudioVariant,
  generateVirtualStudioVariant,
  getVirtualStudioFragmentStatus,
  getVirtualStudioHedraEnabled,
  listVirtualStudioFragments,
  listVirtualStudios,
  listVirtualStudioVariants,
  listVirtualStudioVoices,
  selectVirtualStudioVariant,
} from '../../lib/endpoints';
import type {
  VirtualStudio,
  VirtualStudioFragment,
  VirtualStudioVariant,
  VirtualStudioVoiceOption,
} from '../../lib/types';
import { ApiRequestError } from '../../lib/admin-api';

const STATUS_LABEL: Record<VirtualStudioFragment['status'], string> = {
  pending: 'В очереди',
  processing: 'Готовится',
  complete: 'Готово',
  failed: 'Ошибка',
};

const STATUS_SEVERITY: Record<VirtualStudioFragment['status'], 'ok' | 'warning' | 'critical'> = {
  complete: 'ok',
  pending: 'warning',
  processing: 'warning',
  failed: 'critical',
};

const KIND_LABEL: Record<VirtualStudioFragment['kind'], string> = {
  VIDEO: 'Видео',
  VOICE: 'Голос',
  ANALYSIS: 'ИИ-анализ',
};

const POLL_INTERVAL_MS = 4000;

export default function VirtualStudioPage() {
  const [studios, setStudios] = useState<VirtualStudio[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [newName, setNewName] = useState('');
  const [newPrompt, setNewPrompt] = useState(
    'Профессиональная студия для видео-ведущей: нейтральный фон, мягкий свет, вертикальный кадр 9:16.',
  );
  const [creating, setCreating] = useState(false);

  const [selectedStudioId, setSelectedStudioId] = useState<string | null>(null);
  const [hedraEnabled, setHedraEnabled] = useState(false);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const [list, hedra] = await Promise.all([listVirtualStudios(), getVirtualStudioHedraEnabled()]);
      setStudios(list);
      setHedraEnabled(hedra.enabled);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Не удалось загрузить студии');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function handleCreate() {
    if (!newName.trim() || !newPrompt.trim()) return;
    setCreating(true);
    setError(null);
    try {
      await createVirtualStudio(newName.trim(), newPrompt.trim());
      setNewName('');
      await load();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Не удалось создать студию');
    } finally {
      setCreating(false);
    }
  }

  async function handleDelete(id: string) {
    if (!confirm('Удалить студию? (мягкое удаление, история фрагментов сохранится)')) return;
    try {
      await deleteVirtualStudio(id);
      if (selectedStudioId === id) setSelectedStudioId(null);
      await load();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Не удалось удалить студию');
    }
  }

  const selectedStudio = studios.find((s) => s.id === selectedStudioId) ?? null;

  return (
    <div className="page">
      <h1 style={{ fontSize: 20, marginBottom: 4 }}>Виртуальная студия</h1>
      <p className="muted" style={{ marginBottom: 20 }}>
        Референс-кадр (Grok Imagine) + видео/голос/анализ-фрагменты (docs-tz/
        TZ-Virtualnaya-Studiya-i-AI-Vedushaya.md, Этап 1-3). Hedra для видео-фрагментов:{' '}
        {hedraEnabled ? 'включена' : 'выключена'} (переключается в /settings).
      </p>

      {error && (
        <p className="critical" style={{ marginBottom: 16 }}>
          {error}
        </p>
      )}

      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 520 }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13 }}>
            Название студии
            <input
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="например: Основная студия"
            />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13 }}>
            Промпт референс-кадра (можно поправить перед каждой генерацией варианта)
            <textarea
              value={newPrompt}
              onChange={(e) => setNewPrompt(e.target.value)}
              rows={2}
            />
          </label>
          <div>
            <button type="button" disabled={creating} onClick={() => void handleCreate()}>
              {creating ? 'Создаётся…' : 'Новая студия'}
            </button>
          </div>
        </div>
      </div>

      {loading && <p className="muted">Загрузка…</p>}

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(260px, 320px) 1fr', gap: 16 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {studios.map((s) => (
            <div
              key={s.id}
              className="card"
              style={{
                cursor: 'pointer',
                border: s.id === selectedStudioId ? '2px solid var(--accent, #4a7)' : undefined,
              }}
              onClick={() => setSelectedStudioId(s.id)}
            >
              {s.variants?.find((v) => v.id === s.selectedVariantId)?.imageUrl && (
                <img
                  src={s.variants.find((v) => v.id === s.selectedVariantId)!.imageUrl}
                  alt={s.name}
                  style={{ width: '100%', borderRadius: 6, marginBottom: 8, aspectRatio: '9/16', objectFit: 'cover' }}
                />
              )}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <p style={{ fontWeight: 600 }}>{s.name}</p>
                <span
                  className={`badge-status badge-status-${
                    s.status === 'READY' ? 'ok' : s.status === 'ARCHIVED' ? 'critical' : 'warning'
                  }`}
                >
                  {s.status}
                </span>
              </div>
              <p className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                {new Date(s.createdAt).toLocaleString('ru-RU')}
              </p>
              <button
                type="button"
                style={{ marginTop: 8 }}
                onClick={(e) => {
                  e.stopPropagation();
                  void handleDelete(s.id);
                }}
              >
                Удалить
              </button>
            </div>
          ))}
          {!loading && studios.length === 0 && <p className="muted">Студий пока нет.</p>}
        </div>

        <div>
          {selectedStudio ? (
            <StudioDetail
              key={selectedStudio.id}
              studio={selectedStudio}
              hedraEnabled={hedraEnabled}
              onChanged={load}
            />
          ) : (
            <p className="muted">Выберите студию слева.</p>
          )}
        </div>
      </div>
    </div>
  );
}

function StudioDetail({
  studio,
  hedraEnabled,
  onChanged,
}: {
  studio: VirtualStudio;
  hedraEnabled: boolean;
  onChanged: () => void;
}) {
  const [variants, setVariants] = useState<VirtualStudioVariant[]>([]);
  const [fragments, setFragments] = useState<VirtualStudioFragment[]>([]);
  const [variantPrompt, setVariantPrompt] = useState(studio.refPrompt);
  const [generatingVariant, setGeneratingVariant] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pollTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  async function loadVariantsAndFragments() {
    try {
      const [v, f] = await Promise.all([
        listVirtualStudioVariants(studio.id),
        listVirtualStudioFragments(studio.id),
      ]);
      setVariants(v);
      setFragments(f);
      f.forEach((fr) => {
        if (fr.kind === 'VIDEO' && (fr.status === 'pending' || fr.status === 'processing')) {
          schedulePoll(fr.id);
        }
      });
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Не удалось загрузить данные студии');
    }
  }

  useEffect(() => {
    void loadVariantsAndFragments();
    return () => {
      Object.values(pollTimers.current).forEach(clearTimeout);
      pollTimers.current = {};
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [studio.id]);

  function schedulePoll(fragmentId: string) {
    if (pollTimers.current[fragmentId]) clearTimeout(pollTimers.current[fragmentId]);
    pollTimers.current[fragmentId] = setTimeout(() => void pollFragment(fragmentId), POLL_INTERVAL_MS);
  }

  async function pollFragment(fragmentId: string) {
    try {
      const updated = await getVirtualStudioFragmentStatus(studio.id, fragmentId);
      setFragments((prev) => prev.map((f) => (f.id === fragmentId ? updated : f)));
      if (updated.status === 'pending' || updated.status === 'processing') {
        schedulePoll(fragmentId);
      }
    } catch {
      // сетевая икота — следующий цикл поллинга сам не запустится, но
      // ручное обновление страницы это исправит; не шумим ошибкой каждые 4с.
    }
  }

  async function handleGenerateVariant() {
    setGeneratingVariant(true);
    setError(null);
    try {
      await generateVirtualStudioVariant(studio.id, variantPrompt.trim() || undefined);
      await loadVariantsAndFragments();
      onChanged();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Не удалось сгенерировать вариант');
    } finally {
      setGeneratingVariant(false);
    }
  }

  async function handleSelectVariant(variantId: string) {
    try {
      await selectVirtualStudioVariant(studio.id, variantId);
      onChanged();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Не удалось выбрать вариант');
    }
  }

  async function handleDeleteVariant(variantId: string) {
    if (!confirm('Удалить вариант референс-кадра?')) return;
    try {
      await deleteVirtualStudioVariant(studio.id, variantId);
      await loadVariantsAndFragments();
      onChanged();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Не удалось удалить вариант');
    }
  }

  async function handleDeleteFragment(fragmentId: string) {
    if (pollTimers.current[fragmentId]) clearTimeout(pollTimers.current[fragmentId]);
    try {
      await deleteVirtualStudioFragment(studio.id, fragmentId);
      setFragments((prev) => prev.filter((f) => f.id !== fragmentId));
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Не удалось удалить фрагмент');
    }
  }

  const readyVoiceFragments = fragments.filter((f) => f.kind === 'VOICE' && f.status === 'complete');
  const lastAnalysis = fragments.find((f) => f.kind === 'ANALYSIS' && f.status === 'complete');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {error && <p className="critical">{error}</p>}

      <div className="card">
        <p style={{ fontWeight: 600, marginBottom: 8 }}>Варианты референс-кадра</p>
        <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
          <input
            type="text"
            style={{ flex: 1 }}
            value={variantPrompt}
            onChange={(e) => setVariantPrompt(e.target.value)}
          />
          <button type="button" disabled={generatingVariant} onClick={() => void handleGenerateVariant()}>
            {generatingVariant ? 'Генерируется…' : 'Сгенерировать ещё вариант'}
          </button>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 12 }}>
          {variants.map((v) => (
            <div key={v.id} style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 8 }}>
              <img src={v.imageUrl} alt="" style={{ width: '100%', borderRadius: 4, aspectRatio: '9/16', objectFit: 'cover' }} />
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, marginTop: 6 }}>
                <input
                  type="radio"
                  checked={studio.selectedVariantId === v.id}
                  onChange={() => void handleSelectVariant(v.id)}
                />
                Выбрать
              </label>
              <button type="button" style={{ marginTop: 6, fontSize: 12 }} onClick={() => void handleDeleteVariant(v.id)}>
                🗑 Удалить
              </button>
            </div>
          ))}
          {variants.length === 0 && <p className="muted">Вариантов пока нет.</p>}
        </div>
      </div>

      <VideoFragmentForm
        studioId={studio.id}
        hasSelectedVariant={!!studio.selectedVariantId}
        hedraEnabled={hedraEnabled}
        readyVoiceFragments={readyVoiceFragments}
        onCreated={loadVariantsAndFragments}
      />

      <VoiceFragmentForm
        studioId={studio.id}
        defaultText={lastAnalysis?.resultText ?? ''}
        onCreated={loadVariantsAndFragments}
      />

      <AnalysisFragmentForm studioId={studio.id} onCreated={loadVariantsAndFragments} />

      <div className="card">
        <p style={{ fontWeight: 600, marginBottom: 8 }}>Фрагменты</p>
        {fragments.length === 0 && <p className="muted">Фрагментов пока нет.</p>}
        {fragments.map((f) => (
          <div key={f.id} style={{ borderTop: '1px solid var(--border)', paddingTop: 8, marginTop: 8 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <p style={{ fontSize: 13 }}>
                <strong>{KIND_LABEL[f.kind]}</strong> · {f.provider}
              </p>
              <span className={`badge-status badge-status-${STATUS_SEVERITY[f.status]}`}>{STATUS_LABEL[f.status]}</span>
            </div>
            {f.text && <p className="muted" style={{ fontSize: 12, marginTop: 4 }}>{f.text}</p>}
            {f.status === 'failed' && f.errorMessage && (
              <p className="critical" style={{ fontSize: 12, marginTop: 4 }}>
                {f.errorMessage}
              </p>
            )}
            {f.kind === 'VIDEO' && f.status === 'complete' && f.resultUrl && (
              <video src={f.resultUrl} controls style={{ width: 220, marginTop: 6, borderRadius: 6 }} />
            )}
            {f.kind === 'VOICE' && f.status === 'complete' && f.resultUrl && (
              <audio src={f.resultUrl} controls style={{ marginTop: 6, width: '100%' }} />
            )}
            {f.kind === 'ANALYSIS' && f.resultText && (
              <p style={{ fontSize: 13, marginTop: 6, whiteSpace: 'pre-wrap' }}>{f.resultText}</p>
            )}
            <button type="button" style={{ marginTop: 6, fontSize: 12 }} onClick={() => void handleDeleteFragment(f.id)}>
              Удалить
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

function VideoFragmentForm({
  studioId,
  hasSelectedVariant,
  hedraEnabled,
  readyVoiceFragments,
  onCreated,
}: {
  studioId: string;
  hasSelectedVariant: boolean;
  hedraEnabled: boolean;
  readyVoiceFragments: VirtualStudioFragment[];
  onCreated: () => void;
}) {
  const [provider, setProvider] = useState<'grok' | 'hedra'>('grok');
  const [prompt, setPrompt] = useState('');
  const [durationSec, setDurationSec] = useState(12);
  const [voiceFragmentId, setVoiceFragmentId] = useState('');
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!hasSelectedVariant) {
    return (
      <div className="card">
        <p className="muted">Сначала выберите (или сгенерируйте) вариант референс-кадра выше — только тогда можно создать видео-фрагмент.</p>
      </div>
    );
  }

  async function run() {
    if (!prompt.trim()) return;
    if (provider === 'hedra' && !voiceFragmentId) {
      setError('Для Hedra выберите готовый голосовой фрагмент — он ведёт лип-синк');
      return;
    }
    setRunning(true);
    setError(null);
    try {
      await createVirtualStudioVideoFragment(studioId, {
        provider,
        prompt: prompt.trim(),
        durationSec,
        voiceFragmentId: provider === 'hedra' ? voiceFragmentId : undefined,
      });
      setPrompt('');
      onCreated();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Не удалось запустить генерацию видео');
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="card">
      <p style={{ fontWeight: 600, marginBottom: 8 }}>Создать видео-фрагмент</p>
      {error && <p className="critical" style={{ fontSize: 13, marginBottom: 8 }}>{error}</p>}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 480 }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13 }}>
          Провайдер
          <select value={provider} onChange={(e) => setProvider(e.target.value as 'grok' | 'hedra')}>
            <option value="grok">Grok Imagine (image-to-video)</option>
            {hedraEnabled && <option value="hedra">Hedra (говорящая голова)</option>}
          </select>
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13 }}>
          Промпт движения
          <input type="text" value={prompt} onChange={(e) => setPrompt(e.target.value)} />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13 }}>
          Длительность, сек
          <input
            type="number"
            min={1}
            max={15}
            value={durationSec}
            onChange={(e) => setDurationSec(Number(e.target.value) || 12)}
          />
        </label>
        {provider === 'hedra' && (
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13 }}>
            Голосовой фрагмент (лип-синк)
            <select value={voiceFragmentId} onChange={(e) => setVoiceFragmentId(e.target.value)}>
              <option value="">— выберите —</option>
              {readyVoiceFragments.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.text?.slice(0, 60) ?? f.id}
                </option>
              ))}
            </select>
          </label>
        )}
        <div>
          <button type="button" disabled={running} onClick={() => void run()}>
            {running ? 'Запускается…' : 'Создать видео-фрагмент'}
          </button>
        </div>
      </div>
    </div>
  );
}

function VoiceFragmentForm({
  studioId,
  defaultText,
  onCreated,
}: {
  studioId: string;
  defaultText: string;
  onCreated: () => void;
}) {
  const [provider, setProvider] = useState<'resemble' | 'elevenlabs'>('resemble');
  const [voices, setVoices] = useState<VirtualStudioVoiceOption[]>([]);
  const [voiceId, setVoiceId] = useState('');
  const [text, setText] = useState(defaultText);
  const [loadingVoices, setLoadingVoices] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoadingVoices(true);
    listVirtualStudioVoices(provider)
      .then((res) => {
        setVoices(res.voices);
        setVoiceId(res.voices[0]?.voiceId ?? '');
      })
      .catch(() => setVoices([]))
      .finally(() => setLoadingVoices(false));
  }, [provider]);

  async function run() {
    if (!voiceId || !text.trim()) return;
    setRunning(true);
    setError(null);
    try {
      await createVirtualStudioVoiceFragment(studioId, { provider, voiceId, text: text.trim() });
      onCreated();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Не удалось озвучить');
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="card">
      <p style={{ fontWeight: 600, marginBottom: 8 }}>Озвучка</p>
      {error && <p className="critical" style={{ fontSize: 13, marginBottom: 8 }}>{error}</p>}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 480 }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13 }}>
          Провайдер
          <select value={provider} onChange={(e) => setProvider(e.target.value as 'resemble' | 'elevenlabs')}>
            <option value="resemble">Resemble (по умолчанию)</option>
            <option value="elevenlabs">ElevenLabs</option>
          </select>
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13 }}>
          Голос
          <select value={voiceId} onChange={(e) => setVoiceId(e.target.value)} disabled={loadingVoices}>
            {voices.map((v) => (
              <option key={v.voiceId} value={v.voiceId}>
                {v.name}
              </option>
            ))}
          </select>
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13 }}>
          Текст реплики
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} />
        </label>
        <div>
          <button type="button" disabled={running || !voiceId} onClick={() => void run()}>
            {running ? 'Озвучиваем…' : 'Озвучить'}
          </button>
        </div>
      </div>
    </div>
  );
}

function AnalysisFragmentForm({ studioId, onCreated }: { studioId: string; onCreated: () => void }) {
  const [sourceVideoUrl, setSourceVideoUrl] = useState('');
  const [brandManifestId, setBrandManifestId] = useState('');
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    if (!sourceVideoUrl.trim()) return;
    setRunning(true);
    setError(null);
    try {
      await createVirtualStudioAnalysisFragment(studioId, {
        sourceVideoUrl: sourceVideoUrl.trim(),
        brandManifestId: brandManifestId.trim() || undefined,
      });
      setSourceVideoUrl('');
      onCreated();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Не удалось запустить анализ');
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="card">
      <p style={{ fontWeight: 600, marginBottom: 8 }}>ИИ-анализ</p>
      {error && <p className="critical" style={{ fontSize: 13, marginBottom: 8 }}>{error}</p>}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 480 }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13 }}>
          URL видео (свой видео-фрагмент или ролик из портфолио)
          <input type="text" value={sourceVideoUrl} onChange={(e) => setSourceVideoUrl(e.target.value)} />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13 }}>
          Брендбук (необязательно) — id BrandManifest
          <input type="text" value={brandManifestId} onChange={(e) => setBrandManifestId(e.target.value)} />
        </label>
        <div>
          <button type="button" disabled={running} onClick={() => void run()}>
            {running ? 'Анализируем…' : 'Проанализировать'}
          </button>
        </div>
      </div>
    </div>
  );
}
