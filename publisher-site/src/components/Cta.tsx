import Link from 'next/link';

/**
 * Основной CTA (§8.1, §8.2): обычная ссылка на форму. Клик считает трекер
 * по `data-cta` (без своего JS). На странице материала стоит ПОСЛЕ текста —
 * не перекрывает его (без «липких» панелей). Внутренняя ссылка — без UTM;
 * материал передаётся параметром `material` (для `contentSlug` заявки).
 */
export default function Cta({ label, id, material }: { label: string; id: string; material?: string }) {
  const href = material ? `/contact?material=${encodeURIComponent(material)}` : '/contact';
  return (
    <Link href={href} className="cta" data-cta={id}>
      {label}
    </Link>
  );
}
