/**
 * Match a key against a pattern that may contain wildcards
 *
 * Patterns:
 * - "streaming.active" - exact match
 * - "streaming.*" - matches streaming.active, streaming.content, etc.
 * - "*.active" - matches streaming.active, session.active, etc.
 * - "*" - matches everything
 *
 * @param key - The key to test
 * @param pattern - The pattern to match against (may contain * wildcards)
 * @returns true if the key matches the pattern
 */
export function wildcardMatch(key: string, pattern: string): boolean {
  // Exact match (fast path)
  if (pattern === key) return true;

  // No wildcards - must be exact match
  if (!pattern.includes('*')) return false;

  // Match everything
  if (pattern === '*') return true;

  // Convert pattern to regex:
  // 1. Escape dots (they're literal in our keys)
  // 2. Replace * with .* (match any characters)
  const regexPattern = pattern
    .replace(/\./g, '\\.')
    .replace(/\*/g, '.*');

  const regex = new RegExp(`^${regexPattern}$`);
  return regex.test(key);
}
