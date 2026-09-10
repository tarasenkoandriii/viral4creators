import { Stepper } from './ui';

interface ProgressIndicatorProps {
  currentStep: number;
  steps: string[];
  /** Пройденные шаги кликабельны (этап 52, В-1.5). */
  onSelect?: (index: number) => void;
  selectable?: boolean[];
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
}: ProgressIndicatorProps) {
  return (
    <Stepper
      steps={steps}
      current={currentStep}
      onSelect={onSelect}
      selectable={selectable}
    />
  );
}
