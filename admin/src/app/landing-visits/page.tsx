"use client";
import { useCallback, useEffect, useState } from 'react';
import { getLandingVisits, setLandingIpUniqueness, type LandingVisitsReport } from '../../lib/endpoints';
const names: Record<string,string> = { main: 'Основной', greeting: 'Поздравления', tutorial: 'Tutorial', assistant: 'AI‑помощник', publisher: 'AI Publisher', 'hands-free': 'Hands-free', qa: 'QA', 'story-tales': 'Story-Tales' };
const languages: Record<string,string> = { ru:'Русский', uk:'Українська', en:'English', de:'Deutsch', es:'Español' };
const sourceName = (value: string | null | undefined) => value === 'linkedin' ? 'LinkedIn (заявленная метка)' : value === 'unknown' ? 'Не указан / не распознан' : 'Без меток: история / старый клиент';
const trafficName = (value: string | null | undefined) => value === 'test' ? 'Помеченный тест' : value === 'unmarked' ? 'Без тестовой метки' : 'Режим неизвестен: без меток';
const targets: Record<string,string> = { main:'https://welcome.viral4creators.app/uk', greeting:'https://greeting.viral4creators.app/uk', tutorial:'https://tutorial.viral4creators.app/uk', assistant:'https://assist.viral4creators.app/uk', 'hands-free':'https://assist.viral4creators.app/uk/hands-free', qa:'https://assist.viral4creators.app/uk/qa', 'story-tales':'https://story-tales.viral4creators.app/uk', publisher:'https://ai-publisher.org/' };
export default function LandingVisitsPage() {
 const [days,setDays] = useState(7), [data,setData] = useState<LandingVisitsReport|null>(null),
 [error,setError] = useState(''), [busy,setBusy] = useState(false), [ipBusy,setIpBusy] = useState(false),
 [traffic,setTraffic] = useState('all'), [source,setSource] = useState('all'), [target,setTarget] = useState('hands-free');
 const load = useCallback(async () => {
  setBusy(true); setError('');
  try { setData(await getLandingVisits(days,traffic,source)); } catch(e) { setData(null); setError(e instanceof Error ? e.message : 'Не удалось загрузить статистику'); }
  finally { setBusy(false); }
 },[days,traffic,source]);
 useEffect(() => { void load(); },[load]);
 const langs = Object.entries(languages).map(([locale,label]) => ({locale,label,views: data?.rows.filter(r=>r.locale===locale).reduce((s,r)=>s+r.views,0) ?? 0}));
 const marked = data?.rows.filter(r=>r.traffic==='test').reduce((s,r)=>s+r.views,0) ?? 0;
 const legacy = data?.rows.filter(r=>r.traffic==null).reduce((s,r)=>s+r.views,0) ?? 0;
 const normal = new URL(targets[target]); const linkedin = new URL(normal); linkedin.searchParams.set('utm_source','linkedin');
 const test = new URL(normal); test.hash='v4c-test';
 return <div className="page">
  <h1>Посещения лендингов</h1>
  <p className="muted">Просмотры по языку контента. Язык не определяет страну. Сохраняется только допустимая заявленная метка источника, без полного URL, параметров и referrer.</p>
  <label>Период <select value={days} onChange={e=>setDays(Number(e.target.value))} disabled={busy}>
   <option value={1}>Сегодня</option><option value={7}>7 дней</option><option value={30}>30 дней</option><option value={90}>90 дней</option>
  </select></label>{' '}
  <label>Просмотры <select value={traffic} onChange={e=>setTraffic(e.target.value)} disabled={busy}>
   <option value="all">Все</option><option value="non-test">Без помеченных тестов</option><option value="test">Только помеченные тесты</option><option value="legacy">История / старый клиент</option>
  </select></label>{' '}
  <label>Источник <select value={source} onChange={e=>setSource(e.target.value)} disabled={busy}>
   <option value="all">Все</option><option value="linkedin">LinkedIn: заявленная метка</option><option value="unknown">Не указан / не распознан</option><option value="legacy">Без меток: история / старый клиент</option>
  </select></label>{' '}<button onClick={()=>void load()} disabled={busy}>{busy?'Загрузка…':'Обновить'}</button>
  {error && <p role="alert" style={{color:'var(--signal-critical)'}}>{error}</p>}
  {data && <>
   <p className="muted">Календарные дни: Киев. Обновлено {new Date(data.generatedAt).toLocaleString('ru',{timeZone:'Europe/Kyiv'})}. Все суммы и уникальность ниже относятся к выбранным фильтрам. Старые просмотры и проверки задним числом не размечаются.</p>
   <div className="stat-grid"><div className="stat-tile"><div className="muted">Просмотры</div><div className="value">{data.totals.views}</div></div>
    <div className="stat-tile"><div className="muted">Уникальные IP за период</div><div className="value">{data.totals.ipCountedViews ? data.totals.uniqueIps : '—'}</div></div>
    <div className="stat-tile"><div className="muted">Просмотры с подсчётом IP</div><div className="value">{data.totals.ipCountedViews} / {data.totals.views}</div></div></div>
   <p>В выбранных данных: помеченных тестов — {marked}; просмотров без меток с неизвестным режимом — {legacy}.</p>
   <p className="muted">Тест и источник — публичные метки, а не проверенная личность или доказательство перехода. «Без помеченных тестов» включает старые непомеченные проверки и не означает внешний спрос. Отсутствие метки LinkedIn не означает прямой заход. Источник относится только к текущему просмотру, без отслеживания цепочки переходов.</p>
   <section className="card"><h2>Языки</h2>{langs.map(l=><div key={l.locale} style={{marginBottom:12}}>
    <span>{l.label}: {l.views} ({data.totals.views ? Math.round(l.views/data.totals.views*100) : 0}%)</span>
    <progress style={{display:'block',width:'100%'}} max={Math.max(data.totals.views,1)} value={l.views} aria-label={l.label}/></div>)}</section>
   <section className="card"><h2>Лендинг × язык × метки</h2>{data.rows.length ? <div style={{overflowX:'auto'}}><table><thead><tr><th>Лендинг</th><th>Язык</th><th>Источник</th><th>Режим</th><th>Просмотры</th><th>Доля</th><th>Уникальные IP</th></tr></thead>
    <tbody>{data.rows.map(r=><tr key={[r.landing,r.locale,r.source,r.traffic].join(':')}><td>{names[r.landing]??r.landing}</td><td>{languages[r.locale]??r.locale}</td><td>{sourceName(r.source)}</td><td>{trafficName(r.traffic)}</td><td>{r.views}</td><td>{data.totals.views ? (r.views/data.totals.views*100).toFixed(1) : '0'}%</td><td>{r.ipCountedViews ? r.uniqueIps : '—'}</td></tr>)}</tbody></table></div>:<p>За выбранный период и фильтры просмотров пока нет.</p>}</section>
   <section className="card"><h2>По дням</h2>{data.timeline.map(r=><div key={r.day}>{r.day}: {r.views} просмотров</div>)}</section>
   <section className="card"><h2>Опциональная уникальность по IP</h2>
    <label><input type="checkbox" checked={data.settings.ipUniquenessEnabled} disabled={ipBusy || !data.settings.hashConfigured} onChange={async e=>{
      const enabled=e.target.checked; setIpBusy(true); setError('');
      try { await setLandingIpUniqueness(enabled); await load(); } catch(e) {setError(e instanceof Error?e.message:'Не удалось сохранить настройку');} finally {setIpBusy(false);}
    }}/> Считать уникальные IP у новых просмотров</label>
    <p className="muted">Сохраняется HMAC-хеш, исходный IP не сохраняется. Общий IP может объединить нескольких людей, смена IP — разделить одного. Это оценка, не число пользователей. Выключение останавливает новый подсчёт; уже собранные данные удаляются через 90 дней. IP строк нельзя складывать: один адрес мог открыть разные лендинги и языки.</p>
    {!data.settings.hashConfigured && <p>Для включения требуется серверный ключ хеширования.</p>}
   </section>
  </>}
  <section className="card"><h2>Ссылки для проверки и размещения</h2>
   <label>Лендинг <select value={target} onChange={e=>setTarget(e.target.value)}>{Object.keys(targets).map(k=><option key={k} value={k}>{names[k]}</option>)}</select></label>
   <ul><li>Обычный просмотр: <a href={normal.href} target="_blank" rel="noreferrer">{normal.href}</a></li>
   <li>Для LinkedIn: <a href={linkedin.href} target="_blank" rel="noreferrer">{linkedin.href}</a></li>
   <li>Наш тест: <a href={test.href} target="_blank" rel="noreferrer">{test.href}</a></li></ul>
   <p className="muted">Тест помечается только у явно открытой страницы с #v4c-test. Обычная ссылка и переход на другую страницу без фрагмента отключают режим; cookie и хранилище не используются. Тестовые ссылки не публиковать. Метка LinkedIn сохраняется только для просмотра, в адресе которого есть ровно один utm_source=linkedin; она не переносится на дальнейшие страницы.</p>
  </section>
 </div>;
}
