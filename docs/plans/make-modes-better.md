# Make Edit Modes Better

**Status:** Research

**Depends on:** DiffManager extraction (complete), sandbox research

---

## Context

The three edit modes (manual / ask / auto) control how the LLM's code output is handled. Currently:

| Mode | Behavior |
|------|----------|
| **Manual (M)** | Code blocks rendered in chat. User manually copies/applies. |
| **Ask (Q)** | Diff tabs auto-open. User reviews and accepts/rejects. LLM doesn't know the result. |
| **Auto (A)** | Code applied directly to files. No user confirmation. |

The gap is that **ask mode is fire-and-forget** — the LLM outputs code, diffs appear, but the LLM has no idea whether the user accepted or rejected them. This limits the LLM's ability to adapt.

## The Core Idea: Blocking Approval Flow

Make ask mode (and potentially command execution) **blocking** — the LLM waits for user input before continuing.

### How It Works Architecturally

The LLM already stops naturally at action boundaries. It's not one continuous stream that needs interrupting:

**V3 (tool calls):**
```
LLM turn → tool_calls in response → [APPROVAL GATE] → execute → feed result → LLM continues
```

**R1 (shell/code tags):**
```
LLM turn → <shell>cmd</shell> → iteration loop breaks → [APPROVAL GATE] → execute → feed result as user msg → LLM continues
```

The LLM finishes its turn, then waits for tool results before continuing. "Pausing" is really just **delaying the action** before sending the result back.

### Ask Mode with Feedback

Current ask mode flow:
```
1. LLM outputs code block
2. Diff shown to user (fire-and-forget)
3. LLM keeps going, unaware of user's decision
```

Proposed blocking ask mode:
```
1. LLM outputs code block (turn ends or iteration ends)
2. Diff shown to user
3. Extension WAITS for user accept/reject
4. Result fed back: "User applied changes to foo.ts" or "User rejected changes to foo.ts"
5. LLM continues with that knowledge
```

This lets the LLM:
- Retry with a different approach if rejected
- Build on confirmed changes for the next file
- Ask follow-up questions if the user rejects

### Command Approval (Same Pattern)

```
1. LLM says: "I'll run `npm install express`" (turn ends with tool call)
2. Extension checks allowlist → not found → shows approval UI
3. UI: "Allow `npm install express`?"  [Run] [Block] [Always Allow]
4a. User approves → execute → send result back → LLM continues
4b. User rejects → send "Command rejected by user" as tool result → LLM adapts
```

### Blocking vs Non-Blocking Tradeoffs

| Aspect | Blocking (wait for user) | Non-blocking (fire-and-forget) |
|--------|--------------------------|-------------------------------|
| LLM awareness | Knows result, can adapt | Blind to user decisions |
| Speed | Slower (waits per action) | Fast (no interruptions) |
| Multi-file edits | Sequential, each approved | All generated at once |
| User experience | More control, more clicks | Less friction, less control |
| Error recovery | LLM can retry on rejection | User must manually fix |

### Where the Await Lives

The `requestOrchestrator` already has the async infrastructure. The tool execution callback is `async`, and the shell iteration loop already does await-execute-continue.

For **V3 tool calls** — the approval gate sits in `runToolLoop()` before `executeToolCall()`:
```typescript
// Before executing, check approval
const approved = await this.commandApprovalManager.checkApproval(command);
if (!approved) {
  return { role: 'tool', content: 'Command rejected by user' };
}
```

For **R1 shell iteration** — the gate sits in `reasonerShellExecutor` before shell execution.

For **ask mode diffs** — the gate sits in `handleCodeBlockDetection()`. Instead of immediately showing the diff (current), it would:
1. Show the diff
2. Create a Promise that resolves when user accepts/rejects
3. Await the Promise
4. Feed the result back

## Open Questions

1. **Should ask mode always block?** Or should there be a "blocking ask" vs "non-blocking ask" option?
2. **Batch approval for multi-file changes** — if the LLM edits 5 files, approve each individually or show a summary?
3. **Timeout** — what if the user walks away? Should there be a timeout that auto-rejects?
4. **Auto mode + command approval** — in auto mode (trust all code changes), should commands still require approval? Probably yes — auto mode trusts code edits, not arbitrary shell commands.
5. **UI design** — inline in chat? Modal? VS Code QuickPick? Diff tab with accept/reject buttons (current ask mode already has this)?

## Implementation Sketch

### New Event Types

```typescript
// In src/providers/types.ts
interface ApprovalRequestEvent {
  id: string;
  type: 'command' | 'diff';
  description: string;  // What we're asking about
  detail?: string;       // Full command or diff preview
}

interface ApprovalResponseEvent {
  id: string;
  approved: boolean;
  remember?: boolean;    // "Always allow/block this"
}
```

### Approval Flow

```typescript
// In requestOrchestrator or diffManager
async function waitForApproval(request: ApprovalRequestEvent): Promise<boolean> {
  return new Promise((resolve) => {
    this._onApprovalRequest.fire(request);
    // ChatProvider forwards to webview → user sees UI
    // User clicks approve/reject → webview posts message back
    // ChatProvider fires approval response → we resolve
    const disposable = this.onApprovalResponse((response) => {
      if (response.id === request.id) {
        disposable.dispose();
        resolve(response.approved);
      }
    });
  });
}
```

This follows the existing EventEmitter pattern — the approval request goes out, the response comes back, and the Promise resolves.
