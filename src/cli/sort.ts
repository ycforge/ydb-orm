/**
 * Deterministic string comparison for sorting (code-point order): unlike
 * localeCompare it does not depend on the runtime locale, so repeating a
 * run in any environment yields byte-identical output.
 */
export function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
