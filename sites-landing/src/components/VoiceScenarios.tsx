type Item = { title: string; question: string; answer: string; badge: string };

export function VoiceScenarios({ title, note, items }: { title: string; note: string; items: Item[] }) {
  return <section className="section wrap voice-scenarios">
    <h2>{title}</h2>
    <p className="voice-example-note">{note}</p>
    <div className="grid">
      {items.map((item, index) => <article className="card" key={item.title}>
        <svg className="voice-scenario-art" viewBox="0 0 320 180" aria-hidden="true" focusable="false">
          <rect x="18" y="18" width="284" height="144" rx="18" fill="var(--surface)" stroke="var(--border)" />
          <rect x="38" y="40" width="156" height="30" rx="12" fill="var(--accent)" opacity=".24" />
          <path d="M48 88h190M48 102h150M48 116h174" stroke="var(--muted)" strokeWidth="5" strokeLinecap="round" opacity=".6" />
          <circle cx="260" cy="130" r="22" fill="var(--accent)" />
          {index === 2 ? <rect x="252" y="122" width="16" height="16" rx="2" fill="var(--bg)" /> : index === 1 ? <path d="m250 130 7 7 13-15" fill="none" stroke="var(--bg)" strokeWidth="4" strokeLinecap="round" /> : <path d="M260 117v17m-7-9v5a7 7 0 0 0 14 0v-5m-7 12v5" fill="none" stroke="var(--bg)" strokeWidth="3" strokeLinecap="round" />}
        </svg>
        <p className="eyebrow">{item.badge}</p>
        <h3>{item.title}</h3>
        <blockquote>{item.question}</blockquote>
        <p>{item.answer}</p>
      </article>)}
    </div>
  </section>;
}
