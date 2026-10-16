'use client';
import { useEffect, useRef, useState } from 'react';
import { apiGet, apiPost, ApiRequestError } from '../../lib/admin-api';

type Criterion = 'naturalness' | 'gestures' | 'lipSync';
const LABEL: Record<Criterion,string> = {naturalness:'Естественность',gestures:'Жестикуляция',lipSync:'Липсинк'};
interface Assessment {
  durationSeconds:number; summary:string;
  scores:Record<Criterion,{score:number|null;reason:string}>;
  evidence:Array<{start:number;end:number;criterion:Criterion;severity:'positive'|'minor'|'major';confidence:'low'|'medium'|'high';observation:string;recommendation:string}>;
  limitations:string[];
}
interface Report {model:string;status:'running'|'complete'|'failed';startedAt:string;completedAt?:string;error?:string;assessment?:Assessment;inputTokens?:number;outputTokens?:number;contentSha256?:string;elapsedMs?:number;}
interface Video {sessionId:string;title:string;videoUrl:string;createdAt:string;reports:Report[];}
interface View {models:string[];fps:number;version:string;videos:Video[];}
const PATH='/admin/ui-snapshot/greeting-evaluation';
const time=(s:number)=>`${Math.floor(s/60)}:${(s%60).toFixed(1).padStart(4,'0')}`;
const message=(e:unknown)=>e instanceof ApiRequestError ? e.message : 'Нет ответа сервера. Обновите результаты перед повтором.';

export default function GreetingModelComparison() {
  const [view,setView]=useState<View|null>(null);
  const [selected,setSelected]=useState('');
  const [busy,setBusy]=useState<string|null>(null);
  const [error,setError]=useState<string|null>(null);
  const [notice,setNotice]=useState<string|null>(null);
  const [mediaDuration,setMediaDuration]=useState<number|null>(null);
  const player=useRef<HTMLVideoElement>(null);
  const requestLock=useRef(false);
  const load=async()=>{
    try {const data=await apiGet<View>(PATH);setView(data);setSelected(old=>data.videos.some(v=>v.sessionId===old)?old:data.videos[0]?.sessionId ?? '');setError(null);}
    catch(e){setError(message(e));}
  };
  useEffect(()=>{void load();},[]);
  const video=view?.videos.find(v=>v.sessionId===selected);
  const run=async(models:string[],retry=false)=>{
    if(!video || requestLock.current) return;
    requestLock.current=true;
    setError(null);
    try {
      for(const model of models){
        setBusy(model);
        const report=await apiPost<Report>(PATH,{sessionId:video.sessionId,model,retry});
        setView(old=>old ? {...old,videos:old.videos.map(v=>v.sessionId===video.sessionId?{...v,reports:[...v.reports.filter(r=>r.model!==model),report]}:v)}:old);
      }
    } catch(e){setError(message(e));}
    finally {setBusy(null);requestLock.current=false;}
  };
  const benchmark=async()=>{
    if(!video || requestLock.current || !window.confirm('Платный тест Kling Avatar v2 Pro, примерно $1.05 для 9 секунд. Использует готовую дорожку Nova без повторного TTS. Один тест на исходный ролик; повтор не создаёт дубль. Продолжить?')) return;
    requestLock.current=true;setBusy('Kling Avatar v2 Pro');setError(null);setNotice(null);
    try { const result=await apiPost<{sessionId:string;state:string}>(PATH+'/benchmark',{sessionId:video.sessionId});
      setNotice('Тест '+result.sessionId+': '+result.state+'. Опросите его в разделе «Ролик фикстуры», затем обновите оценки.');
    } catch(e){setError(message(e));} finally{setBusy(null);requestLock.current=false;}
  };
  const missing=view?.models.filter(m=>!video?.reports.some(r=>r.model===m)) ?? [];
  const completed=video?.reports.filter(r=>r.status==='complete' && r.assessment) ?? [];
  const comparable=completed.length===2 && !!completed[0].contentSha256 && completed[0].contentSha256===completed[1].contentSha256;
  return <section className="card" style={{marginTop:20}}>
    <h2>Сравнение Gemini: качество готовых поздравлений</h2>
    <p className="muted">Gemini 3.6 Flash и 4 Argon оценивают один файл по одинаковой инструкции: 1 — грубые дефекты, 5 — естественно.
      Анализ со звуком, {view?.fps ?? 8} кадров/с. Липсинк оценивается качественно, без измерения задержки в миллисекундах.
      Это мнения моделей, а не подтверждённая экспертиза. Ролики и голос не меняются.</p>
    {notice && <p role="status">{notice}</p>}
    <button type="button" disabled={!!busy || !video || video.sessionId.startsWith('benchmark-kling-')} onClick={()=>void benchmark()}>Тест Kling Avatar Pro на той же Nova (платно)</button>
    <p className="muted">Только готовые поздравления тестовых аккаунтов. Каждый запуск модели платный; расход — в журнале «Аудит».
      Повторное открытие использует сохранённый результат. Сбой другой моделью не заменяется.</p>
    {error && <p className="critical" role="alert">{error}</p>}
    <div style={{display:'flex',gap:12,flexWrap:'wrap',alignItems:'center',margin:'16px 0'}}>
      <label>Готовое поздравление{' '}<select aria-label="Поздравление для сравнения" value={selected} disabled={!!busy}
        onChange={e=>{setSelected(e.target.value);setMediaDuration(null);}}>
        {view?.videos.map(v=><option key={v.sessionId} value={v.sessionId}>{v.title} · {new Date(v.createdAt).toLocaleString('ru-RU')} · {v.sessionId.slice(-8)}</option>)}
      </select></label>
      <button type="button" disabled={!!busy} onClick={()=>void load()}>Обновить оценки</button>
      {notice && <p role="status">{notice}</p>}
    <button type="button" disabled={!!busy || !video || !missing.length} onClick={()=>void run(missing)}>
        {busy?`Оценивает ${busy}…`:'Сравнить на этом ролике'}
      </button>
    </div>
    {view && !view.videos.length && <p>Готовых тестовых поздравлений с завершённой постобработкой пока нет.</p>}
    {!view && !error && <p>Загрузка…</p>}
    {video && <>
      <video key={video.videoUrl} ref={player} src={video.videoUrl} onLoadedMetadata={e=>setMediaDuration(Number.isFinite(e.currentTarget.duration)?e.currentTarget.duration:null)} controls preload="metadata" style={{width:'100%',maxWidth:640,maxHeight:360,background:'black'}} />
      <p className="muted">Длительность файла по плееру: {mediaDuration===null?'определяется':`${mediaDuration.toFixed(2)} с`}. Проверка {view?.version}. На одном ролике нельзя установить, какая модель точнее в целом. Выводы с низкой уверенностью проверяются вручную.</p>
      {comparable && <div style={{margin:'12px 0'}}>
        <strong>Расхождения оценок (4 Argon минус 3.6 Flash)</strong>
        <p>{(['naturalness','gestures','lipSync'] as const).map(k=>{
          const a=completed.find(r=>r.model==='gemini-3.6-flash')?.assessment?.scores[k].score;
          const b=completed.find(r=>r.model==='gemini-4-argon')?.assessment?.scores[k].score;
          return `${LABEL[k]}: ${a==null || b==null?'нет сопоставимой оценки':`${b-a>0?'+':''}${b-a}`}`;
        }).join(' · ')}</p>
        <p className="muted">Более высокий балл не означает, что модель лучше оценивает видео. Проверены одинаковые SHA-256 исходных байтов.</p>
      </div>}
      {completed.length===2 && !comparable && <p className="critical">Хеши файлов различаются или отсутствуют — прямое сравнение некорректно.</p>}
      <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(min(100%,360px),1fr))',gap:20,marginTop:16}}>
        {view?.models.map(model=>{const report=video.reports.find(r=>r.model===model);return <article key={model} style={{borderTop:'1px solid var(--border-color, #555)',paddingTop:12}}>
          <h3>{model}</h3>
          {!report && <p className="muted">Оценка ещё не запускалась.</p>}
          {report?.status==='running' && <p>Запуск от {new Date(report.startedAt).toLocaleString('ru-RU')}. Обновите оценки. Если запрос был прерван, автоматический повтор заблокирован во избежание двойного расхода.</p>}
          {report?.status==='failed' && <><p className="critical">{report.error}</p><button type="button" disabled={!!busy} onClick={()=>void run([model],true)}>Повторить {model} (платно)</button></>}
          {report?.assessment && <>
            <p>{report.assessment.summary}</p>
            <p className="muted">Длительность по ответу модели: {report.assessment.durationSeconds.toFixed(2)} с.</p>
            {mediaDuration!==null && Math.abs(mediaDuration-report.assessment.durationSeconds)>1 && <p className="critical" role="note">
              Длительность по модели расходится с файлом. Выводы о финале и полном охвате требуют проверки;
              изображение и звук могут иметь разную длительность. Это не доказательство обрыва звука.
            </p>}
            <dl>{(['naturalness','gestures','lipSync'] as const).map(k=><div key={k} style={{marginBottom:10}}><dt><strong>{LABEL[k]}: {report.assessment!.scores[k].score ?? 'нельзя оценить'}{report.assessment!.scores[k].score!==null?' / 5':''}</strong></dt><dd style={{marginLeft:0}}>{report.assessment!.scores[k].reason}</dd></div>)}</dl>
            {report.assessment.evidence.map((e,i)=><div key={i} style={{margin:'14px 0',paddingLeft:12,borderLeft:'2px solid var(--border-color, #555)'}}>
              <button type="button" aria-label={`Перейти к ${time(e.start)} ${model}`} onClick={()=>{if(player.current) {player.current.currentTime=e.start;player.current.scrollIntoView({block:'center',behavior:'smooth'});}}}>{time(e.start)}–{time(e.end)}</button>
              <span> · {LABEL[e.criterion]} · {{positive:'удачно',minor:'небольшой дефект',major:'существенный дефект'}[e.severity]}</span>
              <p>{e.observation}</p><p><strong>Действие:</strong> {e.recommendation}</p><small className="muted">Уверенность: {{low:'низкая',medium:'средняя',high:'высокая'}[e.confidence]}</small>
            </div>)}
            <ul className="muted">{report.assessment.limitations.map((l,i)=><li key={i}>{l}</li>)}</ul>
          </>}
          {report?.completedAt && <p className="muted" style={{fontSize:12}}>Готово {new Date(report.completedAt).toLocaleString('ru-RU')} · {((report.elapsedMs ?? 0)/1000).toFixed(1)} с · вход {report.inputTokens ?? '—'}, выход {report.outputTokens ?? '—'} токенов. Неизвестная стоимость не равна нулю.</p>}
        </article>;})}
      </div>
    </>}
  </section>;
}
