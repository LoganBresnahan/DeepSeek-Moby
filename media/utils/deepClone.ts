/**
 * Deep clone a value
 * Handles primitives, objects, arrays, null, undefined, Date, RegExp
 */
export function deepClone<T>(value: T): T {
  // Handle null and undefined
  if (value === null || value === undefined) return value;

  // Handle primitives
  if (typeof value !== 'object') return value;

  // Handle Date
  if (value instanceof Date) {
    return new Date(value.getTime()) as T;
  }

  // Handle RegExp
  if (value instanceof RegExp) {
    return new RegExp(value.source, value.flags) as T;
  }

  // Handle Array
  if (Array.isArray(value)) {
    return value.map(item => deepClone(item)) as T;
  }

  // Handle plain objects
  const cloned: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    cloned[key] = deepClone((value as Record<string, unknown>)[key]);
  }

  return cloned as T;
}
