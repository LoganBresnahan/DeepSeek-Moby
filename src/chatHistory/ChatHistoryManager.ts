import * as vscode from 'vscode';
import { ChatStorage } from './ChatStorage';
import { ChatSession, Message, estimateTokens, generateSessionId } from './ChatSession';

export class ChatHistoryManager {
  private storage: ChatStorage;
  private onSessionsChanged: vscode.EventEmitter<void>;
  public readonly onSessionsChangedEvent: vscode.Event<void>;

  constructor(context: vscode.ExtensionContext) {
    this.storage = ChatStorage.getInstance(context);
    this.onSessionsChanged = new vscode.EventEmitter<void>();
    this.onSessionsChangedEvent = this.onSessionsChanged.event;
  }

  // Public API
  async startNewSession(
    initialMessage?: string,
    model?: string,
    language?: string,
    filePath?: string
  ): Promise<ChatSession> {
    const session = await this.storage.createSession(initialMessage, model, language, filePath);
    this.onSessionsChanged.fire();
    return session;
  }

  async addMessageToCurrentSession(message: Omit<Message, 'timestamp'>): Promise<void> {
    const currentSession = this.storage.getCurrentSession();
    if (!currentSession) {
      // Create new session if none exists
      await this.startNewSession(
        message.role === 'user' ? message.content : undefined,
        'deepseek-chat'
      );
    }

    const sessionId = this.storage.getCurrentSession()?.id;
    if (sessionId) {
      await this.storage.addMessage(sessionId, message);
      this.onSessionsChanged.fire();
    }
  }

  async getCurrentSession(): Promise<ChatSession | null> {
    return this.storage.getCurrentSession();
  }

  async getAllSessions(): Promise<ChatSession[]> {
    return this.storage.getAllSessions();
  }

  async getSession(id: string): Promise<ChatSession | null> {
    return this.storage.getSession(id);
  }

  async switchToSession(sessionId: string): Promise<void> {
    await this.storage.setCurrentSession(sessionId);
    this.onSessionsChanged.fire();
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.storage.deleteSession(sessionId);
    this.onSessionsChanged.fire();
  }

  async clearAllHistory(): Promise<void> {
    await this.storage.clearAllSessions();
    this.onSessionsChanged.fire();
  }

  async searchHistory(query: string): Promise<ChatSession[]> {
    return this.storage.searchSessions(query);
  }

  async exportSession(sessionId: string, format: 'json' | 'markdown' | 'txt' = 'json'): Promise<string> {
    const session = this.storage.getSession(sessionId);
    if (!session) {
      return '';
    }

    switch (format) {
      case 'json':
        return JSON.stringify(session, null, 2);

      case 'markdown':
        return `# ${session.title}\n` +
          `**Created:** ${session.createdAt.toLocaleString()}  \n` +
          `**Model:** ${session.model}  \n` +
          `**Language:** ${session.language || 'N/A'}  \n` +
          (session.filePath ? `**File:** ${session.filePath}  \n` : '') +
          (session.tags.length ? `**Tags:** ${session.tags.join(', ')}  \n` : '') +
          `\n## Conversation\n\n` +
          session.messages.map(msg =>
            `### ${msg.role === 'user' ? 'You' : 'DeepSeek Moby'}\n` +
            `*${msg.timestamp.toLocaleTimeString()}*\n\n` +
            msg.content + '\n'
          ).join('\n');

      case 'txt':
        return `=== ${session.title} ===\n` +
          `Created: ${session.createdAt.toLocaleString()}\n` +
          `Model: ${session.model}\n` +
          `Language: ${session.language || 'N/A'}\n` +
          (session.filePath ? `File: ${session.filePath}\n` : '') +
          (session.tags.length ? `Tags: ${session.tags.join(', ')}\n` : '') +
          `\nConversation:\n\n` +
          session.messages.map(msg =>
            `[${msg.timestamp.toLocaleTimeString()}] ${msg.role === 'user' ? 'You' : 'DeepSeek Moby'}:\n` +
            msg.content + '\n'
          ).join('\n');
    }
  }

  async importSession(data: string): Promise<ChatSession | null> {
    const session = await this.storage.importSession(data);
    if (session) {
      this.onSessionsChanged.fire();
    }
    return session;
  }

  async exportAllSessions(format: 'json' | 'markdown' | 'txt' = 'json'): Promise<string> {
    const sessions = this.storage.getAllSessions();

    switch (format) {
      case 'json':
        return JSON.stringify(sessions, null, 2);

      case 'markdown':
        return sessions.map(session =>
          `# ${session.title}\n` +
          `**Created:** ${session.createdAt.toLocaleString()}  \n` +
          `**Model:** ${session.model}  \n` +
          `**Language:** ${session.language || 'N/A'}  \n` +
          (session.filePath ? `**File:** ${session.filePath}  \n` : '') +
          (session.tags.length ? `**Tags:** ${session.tags.join(', ')}  \n` : '') +
          `\n## Conversation\n` +
          session.messages.map(msg =>
            `### ${msg.role === 'user' ? 'You' : 'DeepSeek Moby'}\n` +
            `*${msg.timestamp.toLocaleTimeString()}*\n\n` +
            '```' + (session.language || 'text') + '\n' +
            msg.content + '\n```\n'
          ).join('\n') + '\n---\n'
        ).join('\n');

      case 'txt':
        return sessions.map(session =>
          `=== ${session.title} ===\n` +
          `Created: ${session.createdAt.toLocaleString()}\n` +
          `Model: ${session.model}\n` +
          `Language: ${session.language || 'N/A'}\n` +
          (session.filePath ? `File: ${session.filePath}\n` : '') +
          (session.tags.length ? `Tags: ${session.tags.join(', ')}\n` : '') +
          `\nConversation:\n` +
          session.messages.map(msg =>
            `[${msg.timestamp.toLocaleTimeString()}] ${msg.role === 'user' ? 'You' : 'DeepSeek Moby'}:\n` +
            msg.content + '\n'
          ).join('\n') + '\n\n'
        ).join('\n');
    }
  }

  async getSessionStats(): Promise<{
    totalSessions: number;
    totalMessages: number;
    totalTokens: number;
    byModel: Record<string, number>;
    byLanguage: Record<string, number>;
  }> {
    const sessions = this.storage.getAllSessions();
    let totalMessages = 0;
    let totalTokens = 0;
    const byModel: Record<string, number> = {};
    const byLanguage: Record<string, number> = {};

    sessions.forEach(session => {
      totalMessages += session.messages.length;
      session.messages.forEach(msg => {
        totalTokens += msg.tokens || estimateTokens(msg.content);
      });

      byModel[session.model] = (byModel[session.model] || 0) + 1;
      if (session.language) {
        byLanguage[session.language] = (byLanguage[session.language] || 0) + 1;
      }
    });

    return {
      totalSessions: sessions.length,
      totalMessages,
      totalTokens,
      byModel,
      byLanguage
    };
  }

  async addTagToSession(sessionId: string, tag: string): Promise<void> {
    const session = this.storage.getSession(sessionId);
    if (session && !session.tags.includes(tag)) {
      session.tags.push(tag);
      await this.storage.updateSession(sessionId, { tags: session.tags });
      this.onSessionsChanged.fire();
    }
  }

  async removeTagFromSession(sessionId: string, tag: string): Promise<void> {
    const session = this.storage.getSession(sessionId);
    if (session) {
      const newTags = session.tags.filter(t => t !== tag);
      await this.storage.updateSession(sessionId, { tags: newTags });
      this.onSessionsChanged.fire();
    }
  }

  async getSessionsByTag(tag: string): Promise<ChatSession[]> {
    const sessions = this.storage.getAllSessions();
    return sessions.filter(session => session.tags.includes(tag));
  }

  async renameSession(sessionId: string, newTitle: string): Promise<void> {
    await this.storage.updateSession(sessionId, { title: newTitle });
    this.onSessionsChanged.fire();
  }

  async duplicateSession(sessionId: string): Promise<ChatSession | null> {
    const session = this.storage.getSession(sessionId);
    if (!session) return null;

    const duplicated: ChatSession = {
      ...session,
      id: generateSessionId(),
      title: `${session.title} (Copy)`,
      createdAt: new Date(),
      updatedAt: new Date()
    };

    await this.storage.updateSession(duplicated.id, duplicated);
    this.onSessionsChanged.fire();
    return duplicated;
  }

  // Helper method for backward compatibility
  async getConversationHistory(): Promise<Message[]> {
    const currentSession = await this.getCurrentSession();
    return currentSession?.messages || [];
  }

  // Helper method for backward compatibility
  async clearConversationHistory(): Promise<void> {
    // This clears just the current conversation, not the entire history
    await this.startNewSession();
  }
}
