import * as vscode from 'vscode';
import { ChatSession, Message, createChatSession, generateSessionId } from './ChatSession';

export class ChatStorage {
  private static instance: ChatStorage;
  private context: vscode.ExtensionContext;
  private sessions: Map<string, ChatSession> = new Map();
  private currentSessionId: string | null = null;

  private constructor(context: vscode.ExtensionContext) {
    this.context = context;
    this.loadSessions();
  }

  static getInstance(context?: vscode.ExtensionContext): ChatStorage {
    if (!ChatStorage.instance && context) {
      ChatStorage.instance = new ChatStorage(context);
    }
    return ChatStorage.instance;
  }

  private loadSessions(): void {
    const saved = this.context.globalState.get<ChatSession[]>('chatSessions') || [];
    saved.forEach(session => {
      // Convert string dates back to Date objects
      session.createdAt = new Date(session.createdAt);
      session.updatedAt = new Date(session.updatedAt);
      session.messages.forEach(msg => {
        msg.timestamp = new Date(msg.timestamp);
      });
      this.sessions.set(session.id, session);
    });
    
    this.currentSessionId = this.context.globalState.get<string>('currentSessionId') || null;
  }

  private saveSessions(): void {
    const sessions = Array.from(this.sessions.values());
    this.context.globalState.update('chatSessions', sessions);
    if (this.currentSessionId) {
      this.context.globalState.update('currentSessionId', this.currentSessionId);
    }
  }

  // Session management
  createSession(title?: string, model?: string, language?: string, filePath?: string): ChatSession {
    const session = createChatSession(title, model, language, filePath);
    this.sessions.set(session.id, session);
    this.currentSessionId = session.id;
    this.saveSessions();
    return session;
  }

  getCurrentSession(): ChatSession | null {
    if (!this.currentSessionId) return null;
    return this.sessions.get(this.currentSessionId) || null;
  }

  getSession(id: string): ChatSession | null {
    return this.sessions.get(id) || null;
  }

  getAllSessions(): ChatSession[] {
    return Array.from(this.sessions.values())
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
  }

  updateSession(sessionId: string, updates: Partial<ChatSession>): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      Object.assign(session, updates, { updatedAt: new Date() });
      this.saveSessions();
    }
  }

  addMessage(sessionId: string, message: Omit<Message, 'timestamp'>): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      const msgWithTimestamp = {
        ...message,
        timestamp: new Date()
      };
      session.messages.push(msgWithTimestamp);
      session.updatedAt = new Date();
      
      // Auto-generate title from first user message if not set
      if (session.messages.length === 1 && message.role === 'user') {
        session.title = message.content.substring(0, 50) + 
          (message.content.length > 50 ? '...' : '');
      }
      
      this.saveSessions();
    }
  }

  deleteSession(sessionId: string): void {
    this.sessions.delete(sessionId);
    if (this.currentSessionId === sessionId) {
      this.currentSessionId = null;
    }
    this.saveSessions();
  }

  clearAllSessions(): void {
    this.sessions.clear();
    this.currentSessionId = null;
    this.saveSessions();
  }

  searchSessions(query: string): ChatSession[] {
    const lowerQuery = query.toLowerCase();
    return this.getAllSessions().filter(session => 
      session.title.toLowerCase().includes(lowerQuery) ||
      session.messages.some(msg => 
        msg.content.toLowerCase().includes(lowerQuery)
      ) ||
      session.tags.some(tag => 
        tag.toLowerCase().includes(lowerQuery)
      )
    );
  }

  exportSession(sessionId: string): string {
    const session = this.getSession(sessionId);
    if (!session) return '';
    
    const exportData = {
      metadata: {
        title: session.title,
        createdAt: session.createdAt.toISOString(),
        updatedAt: session.updatedAt.toISOString(),
        model: session.model,
        language: session.language,
        filePath: session.filePath,
        tags: session.tags
      },
      messages: session.messages
    };
    
    return JSON.stringify(exportData, null, 2);
  }

  importSession(data: string): ChatSession | null {
    try {
      const importData = JSON.parse(data);
      const session: ChatSession = {
        id: generateSessionId(),
        title: importData.metadata.title || 'Imported Chat',
        messages: importData.messages.map((msg: any) => ({
          ...msg,
          timestamp: new Date(msg.timestamp)
        })),
        createdAt: new Date(importData.metadata.createdAt || Date.now()),
        updatedAt: new Date(importData.metadata.updatedAt || Date.now()),
        model: importData.metadata.model || 'deepseek-chat',
        language: importData.metadata.language,
        filePath: importData.metadata.filePath,
        tags: importData.metadata.tags || []
      };
      
      this.sessions.set(session.id, session);
      this.saveSessions();
      return session;
    } catch (error) {
      console.error('Failed to import session:', error);
      return null;
    }
  }

  setCurrentSession(sessionId: string): void {
    if (this.sessions.has(sessionId)) {
      this.currentSessionId = sessionId;
      this.saveSessions();
    }
  }
}