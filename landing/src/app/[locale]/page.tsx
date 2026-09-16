import { Header } from '../../components/Header';
import { Faq } from '../../components/Faq';
import { HowItWorks } from '../../components/HowItWorks';
import { IllustrationIcon } from '../../components/IllustrationIcon';
import { AssistantWidget } from '../../components/AssistantWidget';
import { getDictionary } from '../../lib/get-dictionary';
import { isLocale, locales, type Locale } from '../../lib/i18n';
import {
  CLAUDE_REFERRAL_URL,
  DEMO_YOUTUBE_EMBED_URL,
  DEMO_YOUTUBE_URL,
  GITHUB_REPO_URL,
  SPEC_KIT_URL,
  TMA_URL,
} from '../../lib/content';

export function generateStaticParams() {
  return locales.map((locale) => ({ locale }));
}

export default function LandingPage({ params }: { params: { locale: string } }) {
  // Валидность локали уже проверена в app/[locale]/layout.tsx (notFound()
  // там же) — здесь просто безопасно сужаем тип для getDictionary().
  const locale: Locale = isLocale(params.locale) ? params.locale : 'ru';
  const dict = getDictionary(locale);
  const year = new Date().getFullYear();

  return (
    <>
      <Header />

      <main id="top">
        <section className="hero">
          <div className="wrap">
            <span className="badge">{dict.hero.badge}</span>
            <h1>{dict.hero.title}</h1>
            <p>{dict.hero.subtitle}</p>
            <div className="hero-actions">
              <a className="cta" href={TMA_URL}>
                {dict.hero.ctaPrimary}
              </a>
              <a className="cta cta-ghost" href="#demo">
                {dict.hero.ctaDemo}
              </a>
            </div>
            <p className="hero-note">{dict.hero.note}</p>
          </div>
        </section>

        <section className="demo" id="demo">
          <div className="wrap">
            <h2>{dict.demo.title}</h2>
            <p className="section-lead">{dict.demo.lead}</p>
            <div className="demo-frame">
              <iframe
                src={DEMO_YOUTUBE_EMBED_URL}
                title={dict.demo.iframeTitle}
                loading="lazy"
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                allowFullScreen
              />
            </div>
            <p className="demo-link">
              {dict.demo.noVideo}{' '}
              <a href={DEMO_YOUTUBE_URL} target="_blank" rel="noreferrer">
                {dict.demo.openYoutube}
              </a>
            </p>
          </div>
        </section>

        <section className="features" id="features">
          <div className="wrap">
            <h2>{dict.features.title}</h2>
            <div className="features-grid">
              {dict.features.items.map((feature, index) => (
                <div className="feature" key={feature.title}>
                  <div className="feature-icon" aria-hidden="true">
                    {/* Фаза 2 ТЗ (doc/LANDING-ILLUSTRATIONS-BRIEF.md §2) —
                        line-art SVG вместо глифа-заглушки; тот же
                        компонент и та же по позиции файловая раскладка
                        (feature-1.svg…feature-9.svg), что у #how. */}
                    <IllustrationIcon name={`feature-${index + 1}`} size={20} />
                  </div>
                  <h3>{feature.title}</h3>
                  <p>{feature.text}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="steps" id="how">
          <div className="wrap">
            <h2>{dict.steps.title}</h2>
            <p className="section-lead">{dict.steps.lead}</p>
            <HowItWorks steps={dict.steps} variant="teaser" hrefBase={`/${locale}/how-it-works`} />
          </div>
        </section>

        {/* Найдено аудитом (доделываем обучалку + аудит с исправлениями,
            2026-09-16): `dict.plans.freeNote`/`priceFree` — статичный
            текст «сейчас всё бесплатно», без какой-либо связи с флагом
            `PLANS_BILLING_ENABLED` (backend/.env.example,
            backend/scripts/build-assistant-knowledge.ts уже ветвится по
            нему для базы знаний консультанта, и офертa §6.2/§13.5,
            landing/src/lib/legal-content.ts, тоже завязана на этот флаг).
            Сейчас (флаг выключен) текст верен. Но здесь НЕТ кода,
            который заметит включение оплаты — если владелец продукта
            когда-нибудь выставит `PLANS_BILLING_ENABLED=true` на бэкенде,
            эта секция лендинга так и продолжит молча утверждать
            «бесплатно», пока кто-то не вспомнит вручную переписать текст
            в пяти словарях. Не исправлено сейчас: реальных цен на
            лендинге взять неоткуда (`common/billing-pricing.ts` —
            backend-only, у лендинга нет доступа), поэтому «просто
            показать цену» невозможно без отдельной фичи (например,
            публичного `GET /billing/plans` или аналогичного). Зафиксировано
            как риск для следующего этапа, когда оплату будут включать. */}
        <section className="plans" id="plans">
          <div className="wrap">
            <h2>{dict.plans.title}</h2>
            <p className="section-lead">{dict.plans.freeNote}</p>
            <div className="plans-grid">
              {dict.plans.items.map((plan) => (
                <div
                  className={`plan${'highlight' in plan && plan.highlight ? ' plan-highlight' : ''}`}
                  key={plan.id}
                  data-plan-id={plan.id}
                >
                  <div className="plan-head">
                    <h3>{plan.title}</h3>
                    <span className="plan-price">{dict.plans.priceFree}</span>
                  </div>
                  <p className="plan-summary">{plan.summary}</p>
                  <ul className="plan-list">
                    {plan.included.map((line) => (
                      <li key={line} className="plan-yes">
                        {line}
                      </li>
                    ))}
                    {plan.excluded.map((line) => (
                      <li key={line} className="plan-no">
                        {line}
                      </li>
                    ))}
                  </ul>
                  {plan.note && <p className="plan-note">{plan.note}</p>}
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="details" id="details">
          <div className="wrap">
            <h2>{dict.details.title}</h2>
            <p className="section-lead">{dict.details.lead}</p>
            <div className="details-grid">
              {dict.details.items.map((block) => (
                <article className="detail" key={block.title}>
                  <h3>{block.title}</h3>
                  <p>{block.text}</p>
                </article>
              ))}
            </div>
          </div>
        </section>

        {/* Дорожная карта — горизонтами, без дат: продукт зависит от чужих
            моделей, и любая дата здесь протухнет к их следующему релизу.
            Источник — doc/TODO.md §IV. */}
        <section className="roadmap" id="roadmap">
          <div className="wrap">
            <h2>{dict.roadmap.title}</h2>
            <p className="section-lead">{dict.roadmap.lead}</p>
            <ol className="roadmap-list">
              {dict.roadmap.items.map((h, i) => (
                <li className="roadmap-item" key={h.title}>
                  <div className="roadmap-mark" aria-hidden="true">
                    {i + 1}
                  </div>
                  <div className="roadmap-body">
                    <h3>{h.title}</h3>
                    <p className="roadmap-outcome">{h.outcome}</p>
                    <ul>
                      {h.items.map((item) => (
                        <li key={item}>{item}</li>
                      ))}
                    </ul>
                  </div>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section className="faq" id="faq">
          <div className="wrap">
            <h2>{dict.faq.title}</h2>
            <Faq />
          </div>
        </section>

        <section className="final-cta">
          <div className="wrap">
            <h2>{dict.finalCta.title}</h2>
            <p>{dict.finalCta.text}</p>
            <a className="cta" href={TMA_URL}>
              {dict.finalCta.cta}
            </a>
          </div>
        </section>
      </main>

      <footer>
        <div className="wrap footer-inner">
          <span>© {year} viral4creators</span>
          <nav className="footer-links">
            <a href={DEMO_YOUTUBE_URL} target="_blank" rel="noreferrer">
              {dict.footer.demo}
            </a>
            <a href={GITHUB_REPO_URL} target="_blank" rel="noreferrer">
              {dict.footer.github}
            </a>
            <a href="/legal/offer">{dict.footer.offer}</a>
            <a href="/legal/terms-of-use">{dict.footer.terms}</a>
            <a href={SPEC_KIT_URL} target="_blank" rel="noreferrer">
              {dict.footer.builtWith}
            </a>
            {/* Доп. запрос владельца продукта: та же реферальная ссылка
                Claude, что уже в футере TMA (frontend/src/App.tsx) — тот
                же текст словаря переиспользован, а не переведён заново. */}
            <a href={CLAUDE_REFERRAL_URL} target="_blank" rel="noreferrer">
              {dict.footer.madeWithClaude}
            </a>
          </nav>
          {/* Юридические документы намеренно одноязычные (см. middleware.ts,
              lib/i18n.ts) — на неродной для них локали честно об этом
              предупреждаем прямо у ссылок, а не молчим. */}
          {locale !== 'ru' && <p className="legal-notice">{dict.footer.legalNoticeOtherLocale}</p>}
        </div>
      </footer>

      {/* Плавающая кнопка + панель ИИ-консультанта (§4.1, §6 ТЗ) — вне
          <main>, фиксированное позиционирование через CSS. */}
      <AssistantWidget locale={locale} dict={dict.assistant} page="home" variant="floating" />
    </>
  );
}
