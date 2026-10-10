/**
 * Раздел «Голос» экрана характера (Э5, ТЗ §3.5: «выбор голоса из пресетов
 * текущего TTS-провайдера, прослушать пример»; §4.10). Сохраняется ОТДЕЛЬНО
 * от персоны и действует сразу (голос не меняет ответов модели — без
 * ворот публикации и без сброса кэша ответов).
 */
import { useEffect, useRef, useState } from 'react';
import { Play, Save } from 'lucide-react';
import { fmt, useAsync, useKit } from '../../kit';
import { Alert, Button, Card, Spinner, inputClass } from '../../kit/ui';
import { useAssist } from '../../lib/assist-context';
import { useSetupErrorText } from '../../lib/use-error-text';
import {
  usd,
  voiceErrorCode,
  type VoiceConfig,
  type VoiceSettingsView,
} from '../../lib/voice-api';
import { LoadError, NoticeBar, type Notice } from '../knowledge/parts';
import { Field, Toggle } from './controls';
import { SamplePlayer } from './sample-player';

export function VoiceSection({
  siteId,
  lang,
}: {
  siteId: string;
  lang: 'uk' | 'ru' | 'en';
}) {
  // Изоляция загрузки, несохранённых настроек и проигрывателя по сайту.
  return <VoiceSectionForSite key={siteId} siteId={siteId} lang={lang} />;
}

function VoiceSectionForSite({
  siteId,
  lang,
}: {
  siteId: string;
  lang: 'uk' | 'ru' | 'en';
}) {
  const { dict } = useKit();
  const { voice } = useAssist();
  const loaded = useAsync(() => voice.get(siteId), [voice, siteId]);
  if (loaded.loading && !loaded.data)
    return <Spinner label={dict.common.loading} />;
  if (!loaded.data)
    return <LoadError error={loaded.error} onRetry={loaded.reload} />;
  return <VoiceForm siteId={siteId} lang={lang} initial={loaded.data} />;
}

function VoiceForm({
  siteId,
  lang,
  initial,
}: {
  siteId: string;
  lang: 'uk' | 'ru' | 'en';
  initial: VoiceSettingsView;
}) {
  const { appDict, voice } = useAssist();
  const t = appDict.setup.persona.voice;
  const errText = useSetupErrorText();
  const [view, setView] = useState(initial);
  const [cfg, setCfg] = useState<VoiceConfig>(initial.config);
  const [busy, setBusy] = useState<'save' | 'listen' | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  // Р-З10-3 (в): один элемент звука на раздел (sample-player.ts) —
  // создаётся в эффекте (StrictMode пересоздаст), при уходе с экрана звук
  // гаснет и URL отзывается.
  const player = useRef<SamplePlayer | null>(null);
  useEffect(() => {
    const p = new SamplePlayer({
      createAudio: () => new Audio(),
      createUrl: (b) => URL.createObjectURL(b),
      revokeUrl: (u) => URL.revokeObjectURL(u),
    });
    player.current = p;
    return () => {
      p.dispose();
      if (player.current === p) player.current = null;
    };
  }, []);
  const fail = (e: unknown) => {
    const code = voiceErrorCode(e);
    setNotice({ tone: 'danger', text: code ? t.errors[code] : errText(e) });
  };
  const save = async () => {
    setBusy('save');
    setNotice(null);
    try {
      const v = await voice.save(siteId, cfg);
      setView(v);
      setCfg(v.config);
      setNotice({ tone: 'success', text: t.saved });
    } catch (e) {
      fail(e);
    } finally {
      setBusy(null);
    }
  };
  const listen = async () => {
    const p = player.current;
    if (!p) return;
    const key = `${cfg.voiceId ?? ''}|${lang}`;
    setNotice(null);
    // Пример уже в памяти (браузер отказал в прошлый раз или повтор) —
    // play() синхронно в этом нажатии, без нового запроса.
    if (p.has(key)) {
      void p.replay().catch(fail);
      return;
    }
    // До первого await: разблокировать звук в жесте пользователя.
    p.prime();
    setBusy('listen');
    try {
      const s = await voice.sample(siteId, cfg.voiceId, lang);
      // 'blocked' — пример сохранён, следующее нажатие проиграет его.
      await p.load(key, new Blob([s.bytes], { type: s.mime }));
    } catch (e) {
      fail(e);
    } finally {
      setBusy(null);
    }
  };
  const blocked = !view.available;
  return (
    <Card className="space-y-3">
      <div className="font-semibold text-sm">{t.title}</div>
      <p className="text-xs text-silver-500">{t.intro}</p>
      {view.reason && view.reason !== 'owner_off' && (
        <Alert tone="neutral">{t.reasons[view.reason]}</Alert>
      )}
      <NoticeBar notice={notice} />
      <Toggle
        checked={cfg.input}
        disabled={blocked && !cfg.input}
        label={t.input}
        onChange={(input) => setCfg((c) => ({ ...c, input }))}
      />
      <Toggle
        checked={cfg.output}
        disabled={blocked && !cfg.output}
        label={t.output}
        onChange={(output) => setCfg((c) => ({ ...c, output }))}
      />
      <Field label={t.voice} htmlFor="v-voice">
        <select
          id="v-voice"
          className={inputClass}
          value={cfg.voiceId ?? ''}
          onChange={(e) =>
            setCfg((c) => ({ ...c, voiceId: e.target.value || null }))
          }
        >
          <option value="">
            {fmt(t.defaultVoice, { name: view.defaultVoice || '—' })}
          </option>
          {view.voices.map((v) => (
            <option key={v.id} value={v.id}>
              {v.gender ? `${v.id} (${v.gender})` : v.id}
            </option>
          ))}
        </select>
      </Field>
      <p className="text-xs text-silver-500">{t.privacy}</p>
      {view.dailyCapMicroUsd > 0 && (
        <div className="text-xs text-silver-500">
          {fmt(t.spent, {
            spent: usd(view.todaySpentMicroUsd),
            cap: usd(view.dailyCapMicroUsd),
          })}
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          icon={<Play size={16} />}
          loading={busy === 'listen'}
          disabled={blocked || busy !== null}
          onClick={() => void listen()}
        >
          {t.listen}
        </Button>
        <Button
          icon={<Save size={16} />}
          loading={busy === 'save'}
          disabled={busy !== null}
          onClick={() => void save()}
        >
          {t.save}
        </Button>
      </div>
    </Card>
  );
}
