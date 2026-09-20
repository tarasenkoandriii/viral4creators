'use client';

import { useDictionary } from '../lib/dictionary-context';

export function PrintButton() {
  const { dict } = useDictionary();
  return (
    <button type="button" className="mp-cta" onClick={() => window.print()}>
      {dict.print.button}
    </button>
  );
}
