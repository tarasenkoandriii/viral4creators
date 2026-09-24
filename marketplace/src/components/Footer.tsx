import { CLAUDE_REFERRAL_URL, LANDING_URL } from '../lib/content';
import type { Dictionary } from '../lib/get-dictionary';

/**
 * Футер маркетплейса.
 *
 * До этого футера у приложения не было вовсе: страница заканчивалась
 * последним блоком контента. Для сайта, где люди размещают брифы и
 * делают ставки на аукционах, это хуже, чем на витрине, — оферта и
 * условия использования должны быть достижимы с любой страницы
 * (та же причина, по которой футер завели на `/how-it-works` лендинга).
 *
 * Ссылки на документы — абсолютные, на главный лендинг: редакция у них
 * одна на все хосты, и дубль по второму адресу нам не нужен. Тот же
 * приём, что у футеров поддоменов лендинга.
 */
export function Footer({ dict }: { dict: Dictionary }) {
  return (
    <footer className="mp-footer">
      <div className="wrap mp-footer-inner">
        <span>© {new Date().getFullYear()} viral4creators</span>
        <nav className="mp-footer-links">
          <a href={`${LANDING_URL}/legal/offer`}>{dict.footer.offer}</a>
          <a href={`${LANDING_URL}/legal/terms-of-use`}>{dict.footer.terms}</a>
          <a href={CLAUDE_REFERRAL_URL} target="_blank" rel="noreferrer">
            {dict.footer.madeWithClaude}
          </a>
        </nav>
      </div>
    </footer>
  );
}
