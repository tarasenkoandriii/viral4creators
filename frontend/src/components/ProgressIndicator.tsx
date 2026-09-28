import { Stepper } from './ui';

interface ProgressIndicatorProps {
  currentStep: number;
  steps: string[];
  /** Пройденные шаги кликабельны (этап 52, В-1.5). */
  onSelect?: (index: number) => void;
  selectable?: boolean[];
  /** Явная завершённость шагов («Тонкая красная линия», §4.2). */
  done?: boolean[];
  /** Хуки `data-qa` позиций — см. `Stepper`. */
  qa?: readonly string[];
}

/**
 * ProgressIndicator Component — workflow progress across steps. Thin
 * wrapper over the design-system Stepper (kept so App.tsx's contract is
 * unchanged).
 */
export function ProgressIndicator({
  currentStep,
  steps,
  onSelect,
  selectable,
  done,
  qa,
}: ProgressIndicatorProps) {
  return (
    <Stepper
      steps={steps}
      current={currentStep}
      onSelect={onSelect}
      selectable={selectable}
      done={done}
      qa={qa}
    />
  );
}
