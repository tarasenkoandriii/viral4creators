import { useState, type ReactNode } from 'react';
import { VoiceCommandRegistry, VoiceCommandsContext } from './voice-commands';

/**
 * Один реестр голосовых обработчиков на мастер (см. `voice-commands.ts`).
 * Реестр живёт всё время мастера, даже при выключенном голосе: карточки
 * регистрируются дёшево, а включение «голосом» посреди брифа не должно
 * требовать перемонтирования полей.
 */
export function VoiceCommandsProvider({ children }: { children: ReactNode }) {
  const [registry] = useState(() => new VoiceCommandRegistry());
  return (
    <VoiceCommandsContext.Provider value={registry}>
      {children}
    </VoiceCommandsContext.Provider>
  );
}
