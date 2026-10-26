// Small text helpers used all over the window (they used to be copied into
// many files).

/** An error as text for a message ("Error: " and the like left out). */
export const errText = (e: unknown): string => (e instanceof Error ? e.message : typeof e === 'string' ? e : String(e));

/**
 * For comparing names regardless of case and accents (Turkish dotted/dotless
 * i included): "İstanbul", "istanbul" and "ıstanbul" all match.
 */
export function fold(x: string): string {
  return x.toLocaleLowerCase('tr').replace(/ı/g, 'i').normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
}
