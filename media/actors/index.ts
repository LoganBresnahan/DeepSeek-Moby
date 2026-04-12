/**
 * Actor exports
 *
 * All UI actors are Shadow DOM based for style isolation.
 * Utility actors (Streaming, Scroll) don't need Shadow DOM.
 */

// Streaming (utility - no Shadow DOM needed)
export { StreamingActor } from './streaming';
export type { StreamingState } from './streaming';

// Scroll (utility - no Shadow DOM needed)
export { ScrollActor } from './scroll';
export type { ScrollState } from './scroll';

// Session (manages VS Code extension communication - no Shadow DOM needed)
export { SessionActor } from './session';
export type { SessionData, SessionState, VSCodeAPI } from './session';

// Edit Mode (manages edit mode state - no Shadow DOM needed)
export { EditModeActor } from './edit-mode';
export type { EditMode } from './edit-mode';

// Virtual Message Gateway (1B architecture - uses VirtualListActor)
// See ARCHITECTURE/message-gateway.md for detailed documentation
export { VirtualMessageGatewayActor } from './message-gateway';
export type { VirtualActorRefs, GatewayPhase } from './message-gateway';

// Header (minimal version - just updates model name display, uses light DOM)
export { HeaderActor } from './header/HeaderActor';
export type { HeaderState, HeaderElements } from './header/HeaderActor';

// Input Area
export { InputAreaShadowActor } from './input-area/InputAreaShadowActor';
export type { Attachment, InputAreaState, SendHandler, StopHandler, InterruptHandler } from './input-area/InputAreaShadowActor';

// Status Panel
export { StatusPanelShadowActor } from './status-panel/StatusPanelShadowActor';
export type { StatusPanelState, LogsHandler } from './status-panel/StatusPanelShadowActor';

// Toolbar
export { ToolbarShadowActor } from './toolbar/ToolbarShadowActor';
export type { ToolbarState, EditModeHandler, WebSearchHandler, FilesHandler, CommandHandler, WebSearchSettings } from './toolbar/ToolbarShadowActor';

// History
export { HistoryShadowActor } from './history';
export type { HistorySession, HistoryMessage } from './history';

// Files (context files modal)
export { FilesShadowActor } from './files';
export type { FileData, FilesState, FilesChangeHandler } from './files';

// Commands (commands dropdown)
export { CommandsShadowActor } from './commands';
export type { CommandItem, CommandHandler } from './commands';

// Command Rules (command approval rules modal)
export { CommandRulesModalActor } from './command-rules';
export type { CommandRule } from './command-rules';

// Model Selector (model dropdown with parameters)
export { ModelSelectorShadowActor } from './model-selector';
export type { ModelOption, ModelSettings, ModelChangeHandler as ModelSelectHandler, SettingsChangeHandler } from './model-selector';

// Settings (settings dropdown)
export { SettingsShadowActor } from './settings';
export type { SettingsValues, DefaultPrompt } from './settings';

// MessageTurnActor (1B Architecture - one actor per conversation turn)
export { MessageTurnActor, type MessageTurnActorConfig } from './turn';
export type { TurnRole, TurnData as TurnMetadata, EditMode as TurnEditMode } from './turn/types';
export { turnActorStyles } from './turn';

// VirtualListActor (virtual rendering with actor pooling)
export { VirtualListActor } from './virtual-list';
export type { TurnData, PoolStats, VisibleRange, VirtualListConfig } from './virtual-list/types';

// Drawing Server (header popup for starting/stopping server + QR code)
export { DrawingServerShadowActor } from './drawing-server/DrawingServerShadowActor';
export type { DrawingServerState } from './drawing-server/DrawingServerShadowActor';

// System Prompt (modal for editing system prompt)
export { SystemPromptModalActor } from './system-prompt';

// Plans (popup for managing plan files)
export { PlanPopupShadowActor } from './plans/PlanPopupShadowActor';
export type { PlanFile } from './plans/PlanPopupShadowActor';

// Web Search (popup for search settings)
export { WebSearchPopupShadowActor } from './web-search/WebSearchPopupShadowActor';
export type { WebSearchMode, WebSearchSettings as WebSearchPopupSettings } from './web-search/WebSearchPopupShadowActor';

// Stats (modal for account usage stats)
export { StatsModalActor } from './stats/StatsModalActor';

// Inspector - Dev-only tool, not exported from production actors
// Access via: import { InspectorShadowActor } from './dev/inspector'
