"use client";
import { useCallback, useEffect, useState } from 'react';
import { getLandingVisits, setLandingIpUniqueness, type LandingVisitsReport } from '../../lib/endpoints';
const names: Record<string,string> = { main: 'Основной', greeting: 'Поздравления', tutorial: 'Tutorial', assistant: 'AI‑помощник', publisher: 'AI Publisher' };
const languages: Record<string,string> = { ru:'Русский', uk:'Українська', en:'English', de:'Deutsch', es:'Español' };
export default function LandingVisitsPage() {
 const [days,setDays] = useState(7), [data,setData] = useState<LandingVisitsReport|null>(null),
 [error,setError] = useState(''), [busy,setBusy] = useState(false), [ipBusy,setIpBusy] = useState(false);
 const load = useCallback(async () => {
  setBusy(true); setError('');
  try { setData(await getLandingVisits(days)); } catch(e) { setData(null); setError(e instanceof Error ? e.message : 'Не удалось загрузить статистику'); }
  finally { setBusy(false); }
 },[days]);
 useEffect(() => { void load(); },[load]);
 const langs = Object.entries(languages).map(([locale,label]) => ({locale,label,views: data?.rows.filter(r=>r.locale===locale).reduce((s,r)=>s+r.views,0) ?? 0}));
 return <div className="page">
  <h1>Посещения лендингов</h1>
  <p className="muted">Просмотры страниц по языку контента. Это не страна и не язык браузера. Источники переходов не собираются.</p>
  <label>Период <select value={days} onChange={e=>setDays(Number(e.target.value))} disabled={busy}>
   <option value={1}>Сегодня</option><option value={7}>7 дней</option><option value={30}>30 дней</option><option value={90}>90 дней</option>
  </select></label> <button onClick={()=>void load()} disabled={busy}>{busy?'Загрузка…':'Обновить'}</button>
  {error && <p role="alert" style={{color:'var(--signal-critical)'}}>{error}</p>}
  {data && <>
   <p className="muted">Календарные дни: Киев. Обновлено {new Date(data.generatedAt).toLocaleString('ru',{timeZone:'Europe/Kyiv'})}. Данные появятся только после установки счётчика; прежние просмотры не восстановлены.</p>
   <div className="stat-grid"><div className="stat-tile"><div className="muted">Просмотры</div><div className="value">{data.totals.views}</div></div>
    <div className="stat-tile"><div className="muted">Уникальные IP за период</div><div className="value">{data.totals.ipCountedViews ? data.totals.uniqueIps : '—'}</div></div>
    <div className="stat-tile"><div className="muted">Просмотры с подсчётом IP</div><div className="value">{data.totals.ipCountedViews} / {data.totals.views}</div></div></div>
   <section className="card"><h2>Языки</h2>{langs.map(l=><div key={l.locale} style={{marginBottom:12}}>
    <span>{l.label}: {l.views} ({data.totals.views ? Math.round(l.views/data.totals.views*100) : 0}%)</span>
    <progress style={{display:'block',width:'100%'}} max={Math.max(data.totals.views,1)} value={l.views} aria-label={l.label}/></div>)}</section>
   <section className="card"><h2>Лендинг × язык</h2>{data.rows.length ? <div style={{overflowX:'auto'}}><table><thead><tr><th>Лендинг</th><th>Язык</th><th>Просмотры</th><th>Доля</th><th>Уникальные IP</th></tr></thead>
    <tbody>{data.rows.map(r=><tr key={r.landing+':'+r.locale}><td>{names[r.landing]??r.landing}</td><td>{languages[r.locale]??r.locale}</td><td>{r.views}</td><td>{data.totals.views ? (r.views/data.totals.views*100).toFixed(1) : '0'}%</td><td>{r.ipCountedViews ? r.uniqueIps : '—'}</td></tr>)}</tbody></table></div>:<p>За выбранный период просмотров пока нет.</p>}</section>
   <section className="card"><h2>По дням</h2>{data.timeline.map(r=><div key={r.day}>{r.day}: {r.views} просмотров</div>)}</section>
   <section className="card"><h2>Опциональная уникальность по IP</h2>
    <label><input type="checkbox" checked={data.settings.ipUniquenessEnabled} disabled={ipBusy || !data.settings.hashConfigured} onChange={async e=>{
      const enabled=e.target.checked; setIpBusy(true); setError('');
      try { await setLandingIpUniqueness(enabled); await load(); } catch(e) {setError(e instanceof Error?e.message:'Не удалось сохранить настройку');} finally {setIpBusy(false);}
    }}/> Считать уникальные IP у новых просмотров</label>
    <p className="muted">По умолчанию выключено. Сохраняется HMAC-хеш, исходный IP не сохраняется. Общий IP может объединить нескольких людей, смена IP — разделить одного. Это оценка, не число пользователей. Выключение останавливает новый подсчёт; уже собранные данные удаляются через 90 дней. Уникальные IP строк нельзя складывать: один адрес мог открыть разные лендинги и языки.</p>
    {!data.settings.hashConfigured && <p>Для включения требуется серверный ключ хеширования.</p>}
   </section>
  </>}
 </div>;
}
