/**
 * Capability-layer types.
 *
 * A "capability" is a function the extension can perform on the user's
 * workspace (create file, delete file, etc.). Each capability returns a
 * `CapabilityResult` that describes what happened, including absolute paths
 * of affected files (ADR 0004 B-pattern).
 *
 * Tool-result formatters read `filesAffected` and append the
 * "Files touched (absolute paths)" section so the model sees ground truth
 * about where files actually landed.
 */

export type FileAction = 'created' | 'modified' | 'deleted';

export interface FileAffected {
  absolutePath: string;
  relativePath: string;
  action: FileAction;
}

export type CapabilityStatus = 'success' | 'failure' | 'rejected';

export interface CapabilityResult {
  status: CapabilityStatus;
  error?: string;
  filesAffected: FileAffected[];
}

/**
 * Format the absolute-path ground-truth section that gets appended to
 * tool-result strings. See ADR 0004.
 */
export function formatFilesAffected(filesAffected: FileAffected[]): string {
  if (filesAffected.length === 0) { return ''; }
  const lines = ['', '--- Files touched by this operation (absolute paths) ---'];
  for (const f of filesAffected) {
    const verb = f.action === 'created' ? 'Created'
               : f.action === 'deleted' ? 'Deleted'
               : 'Modified';
    lines.push(`${verb}: ${f.absolutePath}`);
  }
  return lines.join('\n') + '\n';
}
