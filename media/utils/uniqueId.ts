/**
 * Counter for generating unique IDs
 */
let counter = 0;

/**
 * Generate a unique ID with an optional prefix
 *
 * @param prefix - Optional prefix for the ID
 * @returns Unique ID string
 */
export function uniqueId(prefix = ''): string {
  counter += 1;
  return `${prefix}${counter}`;
}

/**
 * Reset the counter (useful for testing)
 */
export function resetUniqueIdCounter(): void {
  counter = 0;
}
