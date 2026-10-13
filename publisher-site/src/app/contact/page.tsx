import type { Metadata } from 'next';
import AltContact from '@/components/AltContact';
import LeadForm from '@/components/LeadForm';
import { altContactOf, getSiteConfig, slaTextOf } from '@/lib/api';
import { dict, fmt } from '@/lib/dict';
import { pageMetadata } from '@/lib/page-meta';
import { publisherEnv } from '@/lib/server-env';

/**
 * Форма обращения (ТЗ §8.3, проектный документ §13.2): SSG, форма —
 * клиентский остров. Альтернативный контакт виден всегда; без JS
 * (`<noscript>`) — он вместо формы; `method="post"` — даже до гидратации
 * поля не уходят в адресную строку. Форма закрыта (режим/гейты) или нет
 * версии уведомления о данных — честное сообщение и альтернативный контакт.
 */
export const revalidate = 300;

export async function generateMetadata(): Promise<Metadata> {
  return pageMetadata('/contact', dict.meta.contactTitle, dict.meta.contactDescription);
}

export default async function Contact() {
  const cfg = await getSiteConfig();
  const env = publisherEnv();
  const f = dict.form;
  const c = dict.chrome;
  const alt = altContactOf(cfg.altContact);
  const notice = cfg.dataNotice?.version ?? null;
  const open = cfg.formOpen && Boolean(notice);
  const sla = slaTextOf(cfg.contactSla, f.sla);
  return (
    <article className="page contact">
      <h1>{dict.meta.contactTitle}</h1>
      <p className="lead">{fmt(f.lead, { sla })}</p>
      <AltContact value={alt} label={c.altContact} missing={c.altContactMissing} />
      {open ? (
        <>
          {/* Без JS — альтернативный контакт ВМЕСТО формы (§13.2): форма скрыта стилем внутри noscript. */}
          <noscript>
            <style>{'.lead-form{display:none}'}</style>
            <p className="form-status form-status-closed" data-testid="noscript">
              {f.noscript}
            </p>
          </noscript>
          <LeadForm
            apiOrigin={env.apiOrigin}
            publicKey={env.publicKey}
            dataNoticeVersion={notice as string}
            consentState={cfg.consentState}
            analyticsStorage={cfg.analyticsStorage}
            altContact={alt}
            formLimit={cfg.formLimit}
            sla={sla}
            t={f}
            chrome={{ altContact: c.altContact, altContactMissing: c.altContactMissing, newTab: c.newTab }}
          />
        </>
      ) : (
        <p className="form-status form-status-closed" data-testid="form-closed">
          {f.closed}
        </p>
      )}
    </article>
  );
}
