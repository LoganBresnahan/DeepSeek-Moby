/**
 * image-describe role — turns an attached image into a text digest the
 * text-only main model can read.
 *
 * DeepSeek's first-party API is text-only, so image bytes never reach the main
 * loop. The user configures any OpenAI-compatible vision model via
 * `moby.customModels` (declaring `acceptsImages` + the `image-describe` role)
 * and points `moby.subagents.image-describe` at it.
 *
 * This is the only role that uses the router's `buildUserContent` hook — the
 * sub call carries an `image_url` content part, not a string.
 */

import type { SubagentMessageContent, SubagentRole, SubagentTaskContext } from '../types';

export interface ImageDescribeInput {
  /** Data URI of the (already downscaled) image. */
  dataUrl: string;
  /** Original filename, used to orient the description and label the digest. */
  name: string;
}

export interface ImageDescribeOutput {
  /** What the image shows. Always present. */
  description: string;
  /** Text legible in the image, transcribed. Screenshots are the common case. */
  text?: string;
  /** Anything the vision model was unsure about. */
  caveats?: string;
}

/** Prefix marking the digest as second-hand — the assistant did not see the
 *  image itself, and the description is another model's claim about it. */
export const DIGEST_PREFIX = 'Image described by a vision subagent (the assistant cannot see the image itself)';

export function makeImageDescribeRole(): SubagentRole<ImageDescribeInput, ImageDescribeOutput> {
  return {
    name: 'image-describe',
    requiresImageSupport: true,

    shouldRoute(input) {
      // No threshold: the user attached an image, so describing it IS the
      // request. Only refuse when there is nothing to send.
      return typeof input.dataUrl === 'string' && input.dataUrl.length > 0;
    },

    buildSystemPrompt(taskContext: SubagentTaskContext) {
      const taskLine = taskContext.recentUserPrompt
        ? `The user's current task: "${truncate(taskContext.recentUserPrompt, 500)}". Bias the description toward what matters for that task, but never omit something important just because it seems unrelated.`
        : 'The user gave no accompanying prompt — describe the image on its own terms.';
      return [
        'You describe images for another AI assistant that cannot see them. Your description is the ONLY thing it will know about this image, so it must be complete enough to act on.',
        taskLine,
        '',
        'Rules:',
        '- Describe what is actually there. Never guess at, infer, or invent detail you cannot see.',
        '- If the image contains text (a screenshot, a diagram, an error message, code), transcribe it VERBATIM into the "text" field — exact wording, exact numbers. This is usually the most valuable part.',
        '- For UI screenshots, state the layout and where things sit relative to each other.',
        '- For code, preserve indentation and symbol names exactly.',
        '- If something is blurry, cropped, or ambiguous, say so in "caveats" rather than guessing.',
        '',
        'Respond with JSON ONLY, matching this schema:',
        '{',
        '  "description": string,',
        '  "text"?: string,',
        '  "caveats"?: string',
        '}'
      ].join('\n');
    },

    // Never used — buildUserContent takes precedence. Kept because the
    // interface requires it, and it keeps the role degradable if the hook is
    // ever bypassed (a text-only backend would at least get the filename).
    buildUserMessage(input) {
      return `Describe the attached image (filename: ${input.name}).`;
    },

    buildUserContent(input): SubagentMessageContent {
      return [
        { type: 'text', text: `Describe this image (filename: ${input.name}).` },
        { type: 'image_url', image_url: { url: input.dataUrl } }
      ];
    },

    parse(rawJson) {
      if (!rawJson || typeof rawJson !== 'object') return null;
      const obj = rawJson as Record<string, unknown>;
      if (typeof obj.description !== 'string' || obj.description.trim().length === 0) return null;

      return {
        description: obj.description,
        ...(typeof obj.text === 'string' && obj.text.length > 0 ? { text: obj.text } : {}),
        ...(typeof obj.caveats === 'string' && obj.caveats.length > 0 ? { caveats: obj.caveats } : {})
      };
    },

    formatForMain(output, originalInput) {
      const lines = [`${DIGEST_PREFIX} — "${originalInput.name}":`, '', output.description];
      if (output.text) {
        lines.push('', 'Text visible in the image:', '```', output.text, '```');
      }
      if (output.caveats) {
        lines.push('', `Uncertain: ${output.caveats}`);
      }
      return lines.join('\n');
    }
  };
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max) + '…';
}
