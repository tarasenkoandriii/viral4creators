import { PRODUCT_LINKS } from "../brand";
import { getDictionary } from "../lib/get-dictionary";
import type { Locale } from "../lib/i18n";
import { notifyConfig } from "../server/pilot-notify";
import { PilotForm, type PilotFormStrings } from "./PilotForm";

/** Never ask visitors to complete a form whose delivery is not configured. */
export function PilotContact({
  locale,
  strings,
  privacyHref,
}: {
  locale: Locale;
  strings: PilotFormStrings;
  privacyHref: string;
}) {
  if (notifyConfig())
    return (
      <PilotForm locale={locale} strings={strings} privacyHref={privacyHref} />
    );
  const c = getDictionary(locale).voiceLanding;
  return (
    <div className="card" data-pilot-contact="direct">
      <p>{c.contactUnavailable}</p>
      <a className="button" href={PRODUCT_LINKS.contact}>
        {c.contactDirect}
      </a>
    </div>
  );
}
