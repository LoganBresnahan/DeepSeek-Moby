/**
 * TurnProjector — Projects a TurnEventLog into a ViewSegment array (the "view model").
 *
 * Two modes:
 * - projectFull(): Reads the entire event log and produces a complete view model.
 *   Used for: history restore, scroll-into-view reconstruction, causal re-ordering.
 *
 * - projectIncremental(): Given a single new event, returns minimal view mutations.
 *   Used for: live streaming (avoids full re-projection on every token).
 *
 * The view model is an ordered array of ViewSegments. Each segment maps to one
 * UI element rendered by MessageTurnActor (text block, shell dropdown, thinking
 * dropdown, approval widget, pending file, tool batch, etc.).
 */

import {
  TurnEvent,
  TurnEventLog,
  ShellCommand,
  ShellResultData,
  ToolCallData,
} from './TurnEventLog';

// ── View Segment Types ──

export type ViewSegment =
  | TextSegment
  | ThinkingSegment
  | ShellSegment
  | ApprovalSegment
  | FileModifiedSegment
  | ToolBatchSegment
  | CodeBlockSegment
  | DrawingSegment;

export interface TextSegment {
  type: 'text';
  content: string;
  complete: boolean;
  continuation: boolean;
  iteration: number;
}

export interface ThinkingSegment {
  type: 'thinking';
  content: string;
  iteration: number;
  complete: boolean;
}

export interface ShellSegment {
  type: 'shell';
  id: string;
  commands: ShellCommand[];
  results?: ShellResultData[];
  complete: boolean;
}

export interface ApprovalSegment {
  type: 'approval';
  id: string;
  command: string;
  prefix: string;
  shellId: string;
  status: 'pending' | 'allowed' | 'blocked';
  persistent?: boolean;
}

export interface FileModifiedSegment {
  type: 'file-modified';
  path: string;
  status: string;
  editMode?: string;
}

export interface ToolBatchSegment {
  type: 'tool-batch';
  tools: Array<ToolCallData & { status?: string }>;
  complete: boolean;
}

export interface CodeBlockSegment {
  type: 'code-block';
  language: string;
  content: string;
  file?: string;
}

export interface DrawingSegment {
  type: 'drawing';
  imageDataUrl: string;
}

// ── View Mutations (for incremental projection) ──

export type ViewMutation =
  | { op: 'append'; segment: ViewSegment }
  | { op: 'update'; segmentIndex: number; segment: ViewSegment }
  | { op: 'insert'; afterIndex: number; segment: ViewSegment };

// ── TurnProjector ──

export class TurnProjector {

  /**
   * Full projection: read entire event log, produce complete view model.
   *
   * Iterates all events in order and builds the segment array from scratch.
   * Handles causal ordering naturally — events are already in the correct
   * position in the log (TurnEventLog.insertCausal ensures this).
   */
  projectFull(log: TurnEventLog): ViewSegment[] {
    const segments: ViewSegment[] = [];
    let currentText: TextSegment | null = null;
    let hasHadText = false; // Track if any text segment has ever been created

    for (const event of log.getAll()) {
      switch (event.type) {
        case 'text-append': {
          if (!currentText || currentText.complete) {
            // Start a new text segment
            currentText = {
              type: 'text',
              content: event.content,
              complete: false,
              continuation: hasHadText, // continuation if any previous text existed
              iteration: event.iteration,
            };
            segments.push(currentText);
            hasHadText = true;
          } else {
            // Append to current open text segment
            currentText.content += event.content;
          }
          break;
        }

        case 'text-finalize': {
          if (currentText && !currentText.complete) {
            currentText.complete = true;
          }
          break;
        }

        case 'thinking-start': {
          // Break text flow
          if (currentText && !currentText.complete) {
            currentText.complete = true;
          }
          currentText = null;

          segments.push({
            type: 'thinking',
            content: '',
            iteration: event.iteration,
            complete: false,
          });
          break;
        }

        case 'thinking-content': {
          const thinking = this.findLastIncomplete<ThinkingSegment>(segments, 'thinking');
          if (thinking) {
            thinking.content += event.content;
          }
          break;
        }

        case 'thinking-complete': {
          const thinking = this.findLastIncomplete<ThinkingSegment>(segments, 'thinking');
          if (thinking) {
            thinking.complete = true;
          }
          break;
        }

        case 'shell-start': {
          // Break text flow
          if (currentText && !currentText.complete) {
            currentText.complete = true;
          }
          currentText = null;

          segments.push({
            type: 'shell',
            id: event.id,
            commands: event.commands,
            complete: false,
          });
          break;
        }

        case 'shell-complete': {
          const shell = this.findById<ShellSegment>(segments, 'shell', event.id);
          if (shell) {
            shell.results = event.results;
            shell.complete = true;
          }
          break;
        }

        case 'approval-created': {
          segments.push({
            type: 'approval',
            id: event.id,
            command: event.command,
            prefix: event.prefix,
            shellId: event.shellId,
            status: 'pending',
          });
          break;
        }

        case 'approval-resolved': {
          const approval = this.findById<ApprovalSegment>(segments, 'approval', event.id);
          if (approval) {
            approval.status = event.decision;
            approval.persistent = event.persistent;
          }
          break;
        }

        case 'file-modified': {
          // Causal insertion already handled by TurnEventLog.insertCausal —
          // by the time we see it here, it's in the correct position.
          segments.push({
            type: 'file-modified',
            path: event.path,
            status: event.status,
            editMode: event.editMode,
          });
          break;
        }

        case 'tool-batch-start': {
          segments.push({
            type: 'tool-batch',
            tools: event.tools.map(t => ({ ...t })),
            complete: false,
          });
          break;
        }

        case 'tool-batch-update': {
          const batch = this.findLastIncomplete<ToolBatchSegment>(segments, 'tool-batch');
          if (batch) {
            batch.tools = event.tools.map(t => ({ ...t }));
          }
          break;
        }

        case 'tool-update': {
          const batch = this.findLastIncomplete<ToolBatchSegment>(segments, 'tool-batch');
          if (batch && event.index < batch.tools.length) {
            batch.tools[event.index].status = event.status;
          }
          break;
        }

        case 'tool-batch-complete': {
          const batch = this.findLastIncomplete<ToolBatchSegment>(segments, 'tool-batch');
          if (batch) {
            batch.complete = true;
          }
          break;
        }

        case 'code-block': {
          // Break text flow
          if (currentText && !currentText.complete) {
            currentText.complete = true;
          }
          currentText = null;

          segments.push({
            type: 'code-block',
            language: event.language,
            content: event.content,
            file: event.file,
          });
          break;
        }

        case 'drawing': {
          segments.push({
            type: 'drawing',
            imageDataUrl: event.imageDataUrl,
          });
          break;
        }
      }
    }

    return segments;
  }

  /**
   * Incremental projection: given a new event appended or inserted,
   * return the minimal set of view mutations to apply.
   *
   * For most events, this returns a single 'append' or 'update' mutation.
   * For causal insertions (file-modified), a full re-projection is recommended
   * instead (the caller should use projectFull + reconcile).
   *
   * @param segments - The current view model (modified in place for state tracking)
   * @param event - The new event
   * @param index - The position in the event log where it was inserted
   * @param isInsert - True if this was a causal insertion (not an append)
   */
  projectIncremental(
    segments: ViewSegment[],
    event: TurnEvent,
    index: number,
    isInsert: boolean = false
  ): ViewMutation[] {

    // For causal insertions, return empty — caller should do full re-projection
    if (isInsert) {
      return [];
    }

    switch (event.type) {
      case 'text-append': {
        // Find the last incomplete text segment — may not be the last segment overall.
        // e.g., file-modified can be appended mid-stream without closing text flow,
        // matching projectFull behavior where currentText persists across non-breaking events.
        const openText = this.findLastIncomplete<TextSegment>(segments, 'text');
        if (openText) {
          openText.content += event.content;
          const idx = segments.indexOf(openText);
          return [{ op: 'update', segmentIndex: idx, segment: openText }];
        } else {
          // No open text segment — create new one
          const newSeg: TextSegment = {
            type: 'text',
            content: event.content,
            complete: false,
            continuation: segments.some(s => s.type === 'text'),
            iteration: event.iteration,
          };
          segments.push(newSeg);
          return [{ op: 'append', segment: newSeg }];
        }
      }

      case 'text-finalize': {
        const lastText = this.findLastOfType<TextSegment>(segments, 'text');
        if (lastText && !lastText.complete) {
          lastText.complete = true;
          const idx = segments.lastIndexOf(lastText);
          return [{ op: 'update', segmentIndex: idx, segment: lastText }];
        }
        return [];
      }

      case 'thinking-start': {
        // Finalize any open text segment
        const lastText = this.findLastOfType<TextSegment>(segments, 'text');
        const mutations: ViewMutation[] = [];
        if (lastText && !lastText.complete) {
          lastText.complete = true;
          mutations.push({ op: 'update', segmentIndex: segments.lastIndexOf(lastText), segment: lastText });
        }

        const newSeg: ThinkingSegment = {
          type: 'thinking',
          content: '',
          iteration: event.iteration,
          complete: false,
        };
        segments.push(newSeg);
        mutations.push({ op: 'append', segment: newSeg });
        return mutations;
      }

      case 'thinking-content': {
        const thinking = this.findLastIncomplete<ThinkingSegment>(segments, 'thinking');
        if (thinking) {
          thinking.content += event.content;
          const idx = segments.lastIndexOf(thinking);
          return [{ op: 'update', segmentIndex: idx, segment: thinking }];
        }
        return [];
      }

      case 'thinking-complete': {
        const thinking = this.findLastIncomplete<ThinkingSegment>(segments, 'thinking');
        if (thinking) {
          thinking.complete = true;
          const idx = segments.lastIndexOf(thinking);
          return [{ op: 'update', segmentIndex: idx, segment: thinking }];
        }
        return [];
      }

      case 'shell-start': {
        // Finalize any open text segment
        const lastText = this.findLastOfType<TextSegment>(segments, 'text');
        const mutations: ViewMutation[] = [];
        if (lastText && !lastText.complete) {
          lastText.complete = true;
          mutations.push({ op: 'update', segmentIndex: segments.lastIndexOf(lastText), segment: lastText });
        }

        const newSeg: ShellSegment = {
          type: 'shell',
          id: event.id,
          commands: event.commands,
          complete: false,
        };
        segments.push(newSeg);
        mutations.push({ op: 'append', segment: newSeg });
        return mutations;
      }

      case 'shell-complete': {
        const shell = this.findById<ShellSegment>(segments, 'shell', event.id);
        if (shell) {
          shell.results = event.results;
          shell.complete = true;
          const idx = segments.indexOf(shell);
          return [{ op: 'update', segmentIndex: idx, segment: shell }];
        }
        return [];
      }

      case 'approval-created': {
        const newSeg: ApprovalSegment = {
          type: 'approval',
          id: event.id,
          command: event.command,
          prefix: event.prefix,
          shellId: event.shellId,
          status: 'pending',
        };
        segments.push(newSeg);
        return [{ op: 'append', segment: newSeg }];
      }

      case 'approval-resolved': {
        const approval = this.findById<ApprovalSegment>(segments, 'approval', event.id);
        if (approval) {
          approval.status = event.decision;
          approval.persistent = event.persistent;
          const idx = segments.indexOf(approval);
          return [{ op: 'update', segmentIndex: idx, segment: approval }];
        }
        return [];
      }

      case 'file-modified': {
        const newSeg: FileModifiedSegment = {
          type: 'file-modified',
          path: event.path,
          status: event.status,
          editMode: event.editMode,
        };
        segments.push(newSeg);
        return [{ op: 'append', segment: newSeg }];
      }

      case 'tool-batch-start': {
        const newSeg: ToolBatchSegment = {
          type: 'tool-batch',
          tools: event.tools.map(t => ({ ...t })),
          complete: false,
        };
        segments.push(newSeg);
        return [{ op: 'append', segment: newSeg }];
      }

      case 'tool-batch-update': {
        const batch = this.findLastIncomplete<ToolBatchSegment>(segments, 'tool-batch');
        if (batch) {
          batch.tools = event.tools.map(t => ({ ...t }));
          const idx = segments.indexOf(batch);
          return [{ op: 'update', segmentIndex: idx, segment: batch }];
        }
        return [];
      }

      case 'tool-update': {
        const batch = this.findLastIncomplete<ToolBatchSegment>(segments, 'tool-batch');
        if (batch && event.index < batch.tools.length) {
          batch.tools[event.index].status = event.status;
          const idx = segments.indexOf(batch);
          return [{ op: 'update', segmentIndex: idx, segment: batch }];
        }
        return [];
      }

      case 'tool-batch-complete': {
        const batch = this.findLastIncomplete<ToolBatchSegment>(segments, 'tool-batch');
        if (batch) {
          batch.complete = true;
          const idx = segments.indexOf(batch);
          return [{ op: 'update', segmentIndex: idx, segment: batch }];
        }
        return [];
      }

      case 'code-block': {
        // Finalize any open text segment
        const lastText = this.findLastOfType<TextSegment>(segments, 'text');
        const mutations: ViewMutation[] = [];
        if (lastText && !lastText.complete) {
          lastText.complete = true;
          mutations.push({ op: 'update', segmentIndex: segments.lastIndexOf(lastText), segment: lastText });
        }

        const newSeg: CodeBlockSegment = {
          type: 'code-block',
          language: event.language,
          content: event.content,
          file: event.file,
        };
        segments.push(newSeg);
        mutations.push({ op: 'append', segment: newSeg });
        return mutations;
      }

      case 'drawing': {
        const newSeg: DrawingSegment = {
          type: 'drawing',
          imageDataUrl: event.imageDataUrl,
        };
        segments.push(newSeg);
        return [{ op: 'append', segment: newSeg }];
      }
    }
  }

  // ── Private Helpers ──

  private findLastIncomplete<T extends ViewSegment>(
    segments: ViewSegment[],
    type: T['type']
  ): T | null {
    for (let i = segments.length - 1; i >= 0; i--) {
      const s = segments[i];
      if (s.type === type && 'complete' in s && !(s as any).complete) {
        return s as T;
      }
    }
    return null;
  }

  private findById<T extends ViewSegment & { id: string }>(
    segments: ViewSegment[],
    type: T['type'],
    id: string
  ): T | null {
    for (const s of segments) {
      if (s.type === type && 'id' in s && (s as any).id === id) {
        return s as T;
      }
    }
    return null;
  }

  private findLastOfType<T extends ViewSegment>(
    segments: ViewSegment[],
    type: T['type']
  ): T | null {
    for (let i = segments.length - 1; i >= 0; i--) {
      if (segments[i].type === type) {
        return segments[i] as T;
      }
    }
    return null;
  }
}
