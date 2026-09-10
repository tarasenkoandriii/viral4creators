import type {
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from 'react';

/**
 * Form field primitives. All three controls share the `.input` recipe from
 * index.css (SilverFinance's input look); `Field` adds label / hint /
 * error / char-counter around them.
 */
export function Field({
  label,
  hint,
  error,
  counter,
  htmlFor,
  children,
}: {
  label?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  counter?: ReactNode;
  htmlFor?: string;
  children: ReactNode;
}) {
  return (
    <div>
      {label && (
        <label htmlFor={htmlFor} className="label">
          {label}
        </label>
      )}
      {children}
      {(hint || error || counter) && (
        <div className="mt-1 flex items-start justify-between gap-3">
          <span
            className={`text-xs ${error ? 'text-rose-500' : 'text-silver-400'}`}
          >
            {error || hint}
          </span>
          {counter && (
            <span className="text-xs text-silver-400 tabular shrink-0">
              {counter}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

export function Input({
  invalid,
  className = '',
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }) {
  return (
    <input
      className={`input ${invalid ? 'input-error' : ''} ${className}`}
      {...rest}
    />
  );
}

export function Textarea({
  invalid,
  className = '',
  ...rest
}: TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean }) {
  return (
    <textarea
      className={`input resize-none leading-relaxed ${invalid ? 'input-error' : ''} ${className}`}
      {...rest}
    />
  );
}

export function Select({
  className = '',
  children,
  ...rest
}: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={`input appearance-none ${className}`} {...rest}>
      {children}
    </select>
  );
}
