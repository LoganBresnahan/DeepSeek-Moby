# System Prompt Overhaul Plan

## Overview

Three workstreams:
1. **Improve the default prompts** — fix the "always makes code edits" problem
2. **Add saved prompts DB table** — let users save/load/manage named prompts
3. **Fix the default prompt facade** — the prompts shown in settings don't match what's actually sent

---

## 1. Improve Default Prompts

### Problem

The current system prompt is too action-oriented. Every instruction pushes toward code edits — SEARCH/REPLACE examples, "complete tasks in a single response", etc. When a user asks "what does this function do?" or "is this architecture good?", DeepSeek still produces code blocks.

### Current Architecture

The actual prompt sent to the API is built in `requestOrchestrator.buildSystemPrompt()` (line ~470). It's assembled from:

1. **User's custom prompt** (from `deepseek.systemPrompt` VS Code setting) — prepended if set
2. **Base identity** — `"You are DeepSeek Moby, an expert programming assistant integrated into VS Code."`
3. **Model capabilities** — tool instructions (Chat/V3) or shell + `<shell>` tag instructions (Reasoner/R1) from `getReasonerShellPrompt()` in `reasonerShellExecutor.ts`
4. **Edit format instructions** — ~50 lines of SEARCH/REPLACE format with examples and common mistakes
5. **Dynamic context** — editor context, modified files, web search results

The "default prompts" in `settingsManager.ts` (`getChatDefaultPrompt()`/`getReasonerDefaultPrompt()`) are **only shown in the System Prompt modal** — they are NOT actually used in API requests. This is misleading.

### Changes

#### A. Add conversational gate (both models)

Add to the base identity section in `buildSystemPrompt()`:

```
Match your response to the user's intent:
- Questions about code → explain clearly, no edits needed
- Requests for changes → use the edit format below
- Architecture/design discussions → discuss tradeoffs, no edits unless asked
- Debugging help → analyze the issue, suggest fixes only if appropriate

Not every message needs a code edit.
```

#### B. Trim edit format instructions

The current block is ~50 lines with 3 full examples and a "common mistakes" section. Reduce to essentials:

- Keep: format spec, `# File:` requirement, one example
- Remove: "adding new code" example, "creating new files" example (Reasoner already has this via shell), "common mistakes to avoid" list
- Move the examples into the model-specific sections where they're contextually relevant

#### C. Split into separate prompts per model

**Reasoner (R1):**
- Autonomous, shell-capable, iterative
- Emphasize: explore first, then act
- Keep shell instructions and SEARCH/REPLACE for existing files
- Keep: "If the user asks a question, provide a clear direct answer. Do NOT create or edit files for questions." (already exists at line 408, but buried)
- Move this line to the TOP of the reasoner section

**Chat (V3):**
- Conversational, tool-calling, shorter responses
- Emphasize: answer questions directly, use tools to understand before suggesting
- Lighter edit instructions (no shell examples)
- Add: "Explore the codebase using tools before making suggestions"

#### D. Fix the default prompt facade

Two options:
1. **Make the defaults match reality** — update `getChatDefaultPrompt()`/`getReasonerDefaultPrompt()` to output the actual prompt that gets sent (minus dynamic context)
2. **Remove the facade** — the modal prepopulates with the actual prompt from settings; if empty, show the real base prompt

**Recommended: Option 2.** The user should see exactly what gets prepended. The base identity + capability instructions are not user-editable (they're hardcoded in `buildSystemPrompt()`), so the modal should only show the user-customizable portion.

Update `sendDefaultSystemPrompt()` to return a helpful starting template rather than a fake "this is your prompt":

```
# Custom Instructions for DeepSeek Moby
# This text is prepended to every request.
# Leave empty to use the default behavior.
#
# Examples:
# - "Always respond in Spanish"
# - "Prefer functional programming patterns"
# - "Use tabs instead of spaces"
```

### Files to modify

| File | Change |
|------|--------|
| `src/providers/requestOrchestrator.ts` | Rewrite `buildSystemPrompt()` — add conversational gate, trim edit instructions, split model paths |
| `src/tools/reasonerShellExecutor.ts` | Trim `getReasonerShellPrompt()` — move intent-matching to top, reduce examples |
| `src/providers/settingsManager.ts` | Update `getChatDefaultPrompt()`/`getReasonerDefaultPrompt()` to return helpful templates instead of fake prompts |

---

## 2. Saved Prompts DB Table

### Current State

System prompts are stored in VS Code's `settings.json` as `deepseek.systemPrompt`:
- Single string value, overwritten on every save
- No history — previous prompts are lost
- Shared across all workspaces (global scope)
- Not in the SQLite database

### Design

#### Schema

Add to `src/events/migrations.ts` (version 1, fresh-start design — just add the CREATE TABLE):

```sql
CREATE TABLE IF NOT EXISTS saved_prompts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  content TEXT NOT NULL,
  model TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

- `name` — user-provided label (e.g., "Code Review Mode", "Documentation Focus")
- `content` — the prompt text
- `model` — optional, which model this prompt is intended for (`deepseek-chat`, `deepseek-reasoner`, or `NULL` for any)
- No UNIQUE constraint on name — users can have duplicates if they want

#### Manager Class

New file: `src/providers/savedPromptManager.ts`

Follow the `CommandApprovalManager` pattern:

```typescript
export interface SavedPrompt {
  id: number;
  name: string;
  content: string;
  model: string | null;
  created_at: number;
  updated_at: number;
}

export class SavedPromptManager {
  constructor(private readonly db: Database) {}

  save(name: string, content: string, model?: string): SavedPrompt { ... }
  getAll(): SavedPrompt[] { ... }
  getById(id: number): SavedPrompt | null { ... }
  update(id: number, name: string, content: string, model?: string): void { ... }
  delete(id: number): void { ... }
}
```

No in-memory cache needed (unlike command rules which are checked on every shell command). Prompts are loaded on-demand when the modal opens.

#### Extension Wiring

1. Instantiate `SavedPromptManager` in `chatProvider.ts` constructor (already has DB access via `conversationManager`)
2. Add message handlers:

```typescript
case 'getSavedPrompts':
  const prompts = this.savedPromptManager.getAll();
  this._view?.webview.postMessage({ type: 'savedPrompts', prompts });
  break;

case 'savePrompt':
  const saved = this.savedPromptManager.save(data.name, data.content, data.model);
  // Send updated list back
  this._view?.webview.postMessage({ type: 'savedPrompts', prompts: this.savedPromptManager.getAll() });
  break;

case 'updateSavedPrompt':
  this.savedPromptManager.update(data.id, data.name, data.content, data.model);
  this._view?.webview.postMessage({ type: 'savedPrompts', prompts: this.savedPromptManager.getAll() });
  break;

case 'deleteSavedPrompt':
  this.savedPromptManager.delete(data.id);
  this._view?.webview.postMessage({ type: 'savedPrompts', prompts: this.savedPromptManager.getAll() });
  break;
```

#### Modal UI Updates

Update `SystemPromptModalActor` to include a saved prompts panel:

**Layout:**

```
┌──────────────────────────────────────────────┐
│ ✏️ System Prompt                          ✕  │
├──────────────────────────────────────────────┤
│ Edit the system prompt sent with all requests│
│                                              │
│ ┌──────────────────────────────────────────┐ │
│ │ [textarea with current prompt]           │ │
│ │                                          │ │
│ │                                          │ │
│ └──────────────────────────────────────────┘ │
│                                              │
│ ── Saved Prompts ──────────────────────────  │
│ ┌──────────────┬────────┬────────┐           │
│ │ Code Review  │  Load  │ Delete │           │
│ │ Doc Writer   │  Load  │ Delete │           │
│ │ Strict Mode  │  Load  │ Delete │           │
│ └──────────────┴────────┴────────┘           │
├──────────────────────────────────────────────┤
│ [Save] [Save As...] [Reset to Default]       │
└──────────────────────────────────────────────┘
```

**New pub/sub topics:**
- `savedPrompts.list` — subscription, receives `SavedPrompt[]` from extension

**New message types:**
- `getSavedPrompts` — request list from extension
- `savePrompt` — save current textarea as named prompt
- `updateSavedPrompt` — update existing saved prompt
- `deleteSavedPrompt` — delete saved prompt by ID

**User flows:**
1. **Save current prompt**: Click "Save As..." → enter name → saves to DB, appears in list
2. **Load saved prompt**: Click "Load" next to a saved prompt → replaces textarea content (doesn't auto-save to settings)
3. **Delete saved prompt**: Click "Delete" → removes from DB
4. **Save overwrites**: If the loaded prompt was from a saved entry, "Save" updates both the VS Code setting and the saved prompt entry

### Files to create/modify

| File | Action |
|------|--------|
| `src/events/migrations.ts` | Add `saved_prompts` table to schema |
| `src/providers/savedPromptManager.ts` | **New** — CRUD for saved prompts |
| `src/providers/chatProvider.ts` | Add message handlers, instantiate manager |
| `media/actors/system-prompt/SystemPromptModalActor.ts` | Add saved prompts list UI, load/save/delete actions |
| `media/actors/system-prompt/shadowStyles.ts` | Add styles for saved prompts list |

---

## 3. Implementation Order

1. **Prompt improvements** (A-D) — immediate impact, no new infrastructure
2. **DB table + manager** — backend for saved prompts
3. **Modal UI updates** — saved prompts list with CRUD

---

## Open Questions

1. Should "Save As..." show an inline input in the modal footer or a separate dialog?
2. Should we show the model tag on saved prompts (e.g., "Code Review [R1]")?
3. Should loading a saved prompt auto-save to VS Code settings, or require the user to click Save?
4. Max number of saved prompts? (Suggest: no limit, but show newest first)
