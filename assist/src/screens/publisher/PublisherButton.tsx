import { Newspaper } from 'lucide-react';
import { useKit } from '../../kit';
import { Button } from '../../kit/ui';
import { navigate } from '../../lib/router';
import { publisherEntryVisible } from '../../lib/publisher/permissions';

/**
 * AI Publisher (§14.1): вход из карточки сайта рядом с кнопками QA —
 * владельцу кабинета или участнику с `productRoles.publisher ≠ none`.
 * Остальным кнопки нет (сервер всё равно ответил бы 403). Название —
 * имя продукта, одно на всех языках; словари раздела сюда не тянутся
 * (раздел — отдельный чанк, `App.tsx`).
 */
export function PublisherButton({ siteId }: { siteId: string }) {
  const { account } = useKit();
  if (!publisherEntryVisible(account.me)) return null;
  return (
    <div className="flex flex-wrap gap-2">
      <Button
        variant="outline"
        icon={<Newspaper size={16} />}
        onClick={() =>
          navigate({ name: 'publisher', siteId, section: null, id: null })
        }
      >
        Publisher
      </Button>
    </div>
  );
}
