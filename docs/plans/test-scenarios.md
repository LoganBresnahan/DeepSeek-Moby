# Comprehensive UI Test Scenarios

Full regression test scenarios for the DeepSeek Moby extension. Each scenario tests multiple features together in realistic user workflows.

**Current Status:** 2,440 tests passing (2,393 unit + 47 E2E)

---

## End-to-End Workflow Scenarios (Layer 3)

These are the high-value multi-step tests that exercise the full stack. Each scenario simulates a realistic user session.

### W1. Manual Mode Edit Cycle (P0)

1. Open extension (verify webview loads)
2. Set edit mode to Manual (M)
3. Send: "Add a greeting function to hello.ts"
4. Wait for response with code block
5. Click Diff on the code block → verify diff editor opens
6. Click Apply → verify code block shows "Applied"
7. Verify file was modified on disk
8. Send follow-up: "Now add a farewell function too"
9. Wait for response
10. Do NOT apply this one
11. Verify first code block still shows "Applied"
12. Verify second code block shows Diff/Apply buttons (not Applied)

### W2. Ask Mode Accept/Reject Cycle (P0)

1. Switch to Ask mode (Q)
2. Send: "Rename the greeting function to sayHello"
3. Wait for response with pending dropdown
4. Verify "Pending Changes" dropdown appears
5. Click Accept → verify status changes to "applied"
6. Send: "Now rename it back to greeting"
7. Wait for response
8. Click Reject → verify status changes to "rejected"
9. Verify file was NOT modified for the rejected change

### W3. Auto Mode Edit (P0)

1. Switch to Auto mode (A)
2. Send: "Add a comment at the top of hello.ts"
3. Wait for response
4. Verify "Modified Files" dropdown appears (not "Pending Changes")
5. Verify file shows as "applied" automatically
6. Verify no Accept/Reject buttons visible

### W4. Mode Switching Mid-Session (P0)

1. Start in Manual mode, send a message with code edit, apply it
2. Switch to Ask mode, send a message with code edit, accept it
3. Switch to Auto mode, send a message with code edit
4. Verify each turn retains its original mode's behavior
5. Verify all three code changes are reflected in the file

### W5. History Restore After Edits (P0)

1. Complete W1 (Manual mode, apply one diff)
2. Start a new conversation (New Chat)
3. Open History modal
4. Switch back to the original conversation
5. Verify the "Applied" code block is still green
6. Verify the unapplied code block is NOT green
7. Verify thinking dropdowns are present (if R1)
8. Verify shell dropdowns are present (if shell commands were used)

### W6. Model Switch Between Sessions (P0)

1. Start with Chat (V3), send a message, get response
2. Start new conversation
3. Switch to Reasoner (R1), send a message
4. Verify thinking dropdown appears
5. Open History, switch back to the Chat conversation
6. Verify model dropdown shows "Chat (V3)" (not Reasoner)
7. Verify the original conversation is intact

### W7. Stop Generation (P0)

1. Send a message requesting a long response
2. Wait for streaming to start (text or thinking appears)
3. Click Stop
4. Verify streaming stops
5. Verify partial content is preserved
6. Verify Send button reappears
7. Send another message → verify it works normally

### W8. Same File Edited Across Turns (P0)

Regression test for the markCodeBlockApplied bug.

1. Send: "Add turtle to animals.txt" (code edit response)
2. Do NOT apply
3. Send: "Add alligator to animals.txt" (code edit response)
4. Apply the alligator edit
5. Verify alligator code block shows "Applied"
6. Verify turtle code block does NOT show "Applied"

### W9. History Restore With All Statuses (P1)

1. In Ask mode, send 3 messages with code edits
2. Accept first, reject second, leave third unresolved
3. Start new conversation
4. Open History, switch back
5. Verify: first shows "applied" (green)
6. Verify: second shows "rejected" (red)
7. Verify: third shows "expired" (muted)

### W10. R1 Multi-Iteration With Shell (P1)

1. Select Reasoner model
2. Send a message that triggers shell commands (e.g., "List files in this directory and tell me about them")
3. Verify thinking dropdown appears with content
4. Verify shell dropdown appears with command and output
5. If multiple iterations: verify multiple thinking dropdowns
6. Verify final text response renders after all iterations

### W11. Web Search Integration (P1)

1. Open Web Search popup
2. Set mode to Forced
3. Send a message
4. Verify "Searching..." indicator appears
5. Verify search results integrated into response
6. Set mode to Off
7. Send another message
8. Verify no search performed

### W12. File Context Selection (P1)

1. Open a few files in the editor
2. Click Files button → open Files modal
3. Check two open files
4. Verify file chips appear below input
5. Send message with file context
6. Verify message references the selected files
7. Remove one file chip
8. Send another message
9. Verify only one file in context

### W13. System Prompt Workflow (P1)

1. Open Commands → System Prompt
2. Type a custom prompt
3. Click Save
4. Send message → verify response follows custom prompt
5. Open System Prompt again
6. Click "New" to clear
7. Send message → verify default behavior restored

### W14. Command Approval Flow (P1)

1. Select Reasoner model
2. Send message that triggers a shell command
3. When approval widget appears, click "Always Allow [prefix]"
4. Verify command executes
5. Send another message triggering same prefix
6. Verify no approval needed (auto-allowed)
7. Open Command Rules modal
8. Verify the rule appears in the list

### W15. Plan Files Workflow (P1)

1. Click Plan button in toolbar
2. Create a new plan ("test-plan")
3. Verify plan file created and opened
4. Toggle plan active
5. Verify toolbar shows plan badge
6. Send message → verify plan context included
7. Delete the plan
8. Verify plan removed from list

### W16. Drawing Server (P2)

1. Click Drawing Server icon
2. Click Start Server
3. Verify QR code and URL display
4. Click Copy URL → verify clipboard
5. Click Stop Server → verify UI resets

### W17. Fork Session (P1)

1. Have a conversation with 3+ turns
2. Click fork button on the 2nd turn
3. Verify new session created
4. Send a message in the fork
5. Open History → verify fork appears with badge
6. Switch to parent session
7. Verify parent is unchanged (still has original 3 turns)

### W18. Input Area Interactions (P0)

1. Type a message, press Shift+Enter → verify newline added
2. Press Enter → verify message sent
3. Verify input clears after send
4. Type long text → verify textarea auto-resizes
5. With empty input, press Enter → verify nothing sent

### W19. Rapid Mode Cycling (P2)

1. Click edit mode button rapidly 10 times
2. Verify final mode is correct (M→Q→A→M... cycle)
3. No UI glitches or missed transitions
4. Send message → verify correct mode applied

### W20. Full Conversation Export/Import (P1)

1. Have a conversation with multiple turns
2. Open History → click Export → JSON
3. Verify file saved with correct content
4. Delete the session
5. Verify session removed from history

---

## Isolated UI Component Tests (Layer 2 & 3)

These test individual components in isolation.

### Edit Mode (6 tests)

| ID | Test | Priority | Layer |
|---|---|---|---|
| EM1 | Edit mode cycles M→Q→A→M | P0 | 3 |
| EM2 | Edit mode change sends message to extension | P0 | 3 |
| EM3 | Edit mode disabled during streaming | P0 | 3 |
| EM4 | Manual mode: code block shows Diff/Apply buttons | P1 | 2 |
| EM5 | Ask mode: pending dropdown shows Accept/Reject | P1 | 2 |
| EM6 | Auto mode: files show as auto-applied | P1 | 2 |

### Model Selector (8 tests)

| ID | Test | Priority | Layer |
|---|---|---|---|
| MS1 | Model popup opens/closes | P0 | 3 |
| MS2 | Selecting Chat shows temperature slider | P0 | 3 |
| MS3 | Selecting Reasoner shows shell iterations slider | P0 | 3 |
| MS4 | Model change sends message to extension | P0 | 3 |
| MS5 | Max tokens persists per model | P1 | 3 |
| MS6 | Model popup disabled during streaming | P0 | 3 |
| MS7 | Temperature slider range 0-2, step 0.1 | P1 | 2 |
| MS8 | Header updates with model name | P1 | 2 |

### History Modal (12 tests)

| ID | Test | Priority | Layer |
|---|---|---|---|
| HM1 | History modal opens | P0 | 3 |
| HM2 | History modal closes (X, Escape, backdrop) | P0 | 3 |
| HM3 | Sessions listed and grouped by date | P1 | 3 |
| HM4 | Click session switches conversation | P0 | 3 |
| HM5 | Search filters sessions | P1 | 3 |
| HM6 | Rename session via menu | P1 | 3 |
| HM7 | Delete session via menu | P1 | 3 |
| HM8 | Delete all sessions | P1 | 3 |
| HM9 | Export session (JSON/Markdown/TXT) | P1 | 3 |
| HM10 | Session shows model badge | P2 | 2 |
| HM11 | Session shows message count | P2 | 2 |
| HM12 | Fork badge visible on forked sessions | P2 | 3 |

### Pending Files Dropdown (13 tests)

| ID | Test | Priority | Layer |
|---|---|---|---|
| PF1 | Applied file shows green styling | P0 | 2 |
| PF2 | Rejected file shows red styling | P0 | 2 |
| PF3 | Expired file shows muted styling | P1 | 2 |
| PF4 | Deleted file shows strikethrough | P1 | 2 |
| PF5 | Multiple files in one dropdown | P0 | 2 |
| PF6 | Auto mode shows "Modified Files" title | P1 | 2 |
| PF7 | Ask mode shows "Pending Changes" title | P1 | 2 |
| PF8 | Accept click sends message | P0 | 3 |
| PF9 | Reject click sends message | P0 | 3 |
| PF10 | File name click focuses file | P1 | 3 |
| PF11 | Dropdown expand/collapse toggle | P2 | 2 |
| PF12 | Mixed statuses render correctly | P1 | 2 |
| PF13 | Same file in two turns scoped correctly | P0 | 2 |

### Input Area (12 tests)

| ID | Test | Priority | Layer |
|---|---|---|---|
| IA1 | Textarea exists and accepts input | P0 | 2 |
| IA2 | Enter sends message | P0 | 3 |
| IA3 | Shift+Enter adds newline | P0 | 3 |
| IA4 | Empty message not sent | P1 | 3 |
| IA5 | Textarea clears after send | P0 | 3 |
| IA6 | Textarea auto-resizes | P1 | 2 |
| IA7 | Stop button visible during streaming | P0 | 3 |
| IA8 | Send button disabled without API key | P0 | 2 |
| IA9 | Interrupt queues message | P1 | 3 |
| IA10 | Collapse/expand toggle | P2 | 2 |
| IA11 | Attachment chips display | P1 | 3 |
| IA12 | Remove attachment chip | P1 | 3 |

### Streaming Indicators (8 tests)

| ID | Test | Priority | Layer |
|---|---|---|---|
| SI1 | Thinking dropdown appears during R1 streaming | P0 | 3 |
| SI2 | Thinking pulse animation during streaming | P1 | 2 |
| SI3 | Thinking pulse stops after complete | P1 | 2 |
| SI4 | Tool calls batch shows progress | P1 | 3 |
| SI5 | Shell command shows execution status | P1 | 3 |
| SI6 | Send→Stop button transition | P0 | 3 |
| SI7 | Multiple thinking iterations numbered | P2 | 2 |
| SI8 | Thinking dropdown expand/collapse | P2 | 2 |

### Toolbar (6 tests)

| ID | Test | Priority | Layer |
|---|---|---|---|
| TB1 | Send button enabled with API key | P0 | 3 |
| TB2 | Stop button during streaming | P0 | 3 |
| TB3 | Edit mode button cycles modes | P0 | 3 |
| TB4 | Plan button shows badge when active | P2 | 3 |
| TB5 | Files button shows badge when selected | P2 | 3 |
| TB6 | Web search button states | P1 | 3 |

### Web Search Popup (6 tests)

| ID | Test | Priority | Layer |
|---|---|---|---|
| WS1 | Mode buttons (Off/Forced/Auto) | P1 | 3 |
| WS2 | Controls disabled when mode is Off | P1 | 2 |
| WS3 | Credits slider range changes with depth | P1 | 2 |
| WS4 | Depth toggle Basic/Advanced | P1 | 2 |
| WS5 | Clear cache button | P2 | 3 |
| WS6 | Search results appear during request | P1 | 3 |

### Command Approval (6 tests)

| ID | Test | Priority | Layer |
|---|---|---|---|
| CA1 | Approval widget appears for unknown command | P0 | 3 |
| CA2 | Allow Once executes command | P0 | 3 |
| CA3 | Always Allow creates rule | P0 | 3 |
| CA4 | Block Once prevents execution | P0 | 3 |
| CA5 | Always Block creates rule | P0 | 3 |
| CA6 | Rules appear in Command Rules modal | P1 | 3 |

### Settings & Configuration (6 tests)

| ID | Test | Priority | Layer |
|---|---|---|---|
| SC1 | Settings popup opens | P1 | 3 |
| SC2 | API key via command palette | P0 | 3 |
| SC3 | API key via environment variable | P0 | 3 |
| SC4 | Edit mode persists across reload | P1 | 3 |
| SC5 | Model persists across reload | P1 | 3 |
| SC6 | Reset to defaults | P2 | 3 |

---

## Priority Summary

| Priority | Workflow Tests | Component Tests | Total |
|---|---|---|---|
| **P0** | 8 (W1-W8, W18) | 27 | 35 |
| **P1** | 8 (W9-W15, W17, W20) | 49 | 57 |
| **P2** | 2 (W16, W19) | 15 | 17 |
| **Total** | **20** | **91** | **~134** |

---

## Implementation Strategy

**Phase 1:** Implement W1-W8 (P0 workflows) — these cover the core edit/history/model/stop flows that we've been debugging manually.

**Phase 2:** Implement P0 component tests — fill gaps in isolated UI testing.

**Phase 3:** Implement W9-W15 (P1 workflows) — web search, plans, approvals, forks.

**Phase 4:** P1 component tests and P2 everything.

Each workflow test should be self-contained: sets up its own state, performs the actions, and verifies the result. No dependencies between workflow tests.
