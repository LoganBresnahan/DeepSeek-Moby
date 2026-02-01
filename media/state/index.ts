/**
 * Event State Management System
 *
 * An actor-based state management system for VS Code webviews.
 * Enables decoupled, testable UI components with pub/sub communication.
 */

export { EventStateManager } from './EventStateManager';
export { EventStateActor } from './EventStateActor';
export { InterleavedContentActor } from './InterleavedContentActor';
export type { InterleavedContainer, InterleavedContentConfig } from './InterleavedContentActor';
export { EventStateLogger, logger } from './EventStateLogger';
export * from './types';
