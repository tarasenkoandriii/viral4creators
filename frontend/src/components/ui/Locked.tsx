/**
 * Locked — как выглядит возможность, недоступная в текущем режиме
 * (ТЗ §23, этап 29).
 *
 * Возможность НЕ прячется, а показывается закрытой. Спрятанная функция
 * ничего не сообщает: пользователь просто не узнаёт, что она есть, и
 * решает, что сервис её не умеет. Закрытая — объясняет, что именно
 * закрыто, каким режимом открывается и куда нажать.
 *
 * Замок здесь только рисуется. Запрещает сервер: `PlanService.assert*`
 * отвечает 403 даже если этот компонент кто-то обойдёт.
 */

import type { ReactNode } from 'react';
import { Lock } from 'lucide-react';
import { Button } from './Button';
import { Card } from './Card';
import { navigate, routes } from '../../lib/router';
import { useI18n } from '../../lib/i18n-context';

export function LockedNote({
  title,
  lock,
  children,
  compact = false,
}: {
  /** Что закрыто — человеческим языком, как в карточке режима. */
  title: ReactNode;
  /** Подпись замка: «Доступно в Standard» (lib/plan.ts → lockLabel). */
  lock: string;
  /** Зачем эта возможность нужна — одна-две строки. */
  children?: ReactNode;
  /** Внутри уже существующей карточки — без своей рамки. */
  compact?: boolean;
}) {
  const { dict } = useI18n();
  const body = (
    <>
      <div className="flex items-start gap-2">
        <Lock size={14} className="mt-0.5 shrink-0 text-silver-400" />
        <div className="min-w-0">
          <p className="text-sm font-semibold">{title}</p>
          <p className="mt-0.5 text-[11px] font-medium text-accent">{lock}</p>
          {children && (
            <p className="mt-1.5 text-xs leading-relaxed text-silver-400">
              {children}
            </p>
          )}
        </div>
      </div>
      <Button
        size="sm"
        variant="outline"
        className="mt-3"
        block={compact}
        onClick={() => navigate(routes.plan())}
      >
        {dict.common.comparePlans}
      </Button>
    </>
  );

  if (compact) {
    return (
      <div className="rounded-xl border border-dashed border-silver-300 p-3 dark:border-silver-700">
        {body}
      </div>
    );
  }
  return <Card className="p-5 animate-fadeIn">{body}</Card>;
}
