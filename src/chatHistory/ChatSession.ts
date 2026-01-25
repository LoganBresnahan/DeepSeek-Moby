import * as vscode from 'vscode';

export interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: Date;
  tokens?: number;
  reasoning_content?: string;
}

export interface ChatSession {
  id: string;
  title: string;
  messages: Message[];
  createdAt: Date;
  updatedAt: Date;
  model: string;
  language?: string;
  filePath?: string;
  tags: string[];
}

export function createChatSession(
  initialMessage?: string,
  model: string = 'deepseek-chat',
  language?: string,
  filePath?: string
): ChatSession {
  const now = new Date();
  const title = initialMessage 
    ? (initialMessage.substring(0, 50) + (initialMessage.length > 50 ? '...' : ''))
    : 'New Chat';
  
  return {
    id: generateSessionId(),
    title,
    messages: initialMessage ? [{
      role: 'user' as const,
      content: initialMessage,
      timestamp: now
    }] : [],
    createdAt: now,
    updatedAt: now,
    model,
    language,
    filePath,
    tags: []
  };
}

export function generateSessionId(): string {
  return Date.now().toString(36) + Math.random().toString(36).substring(2);
}

// Helper function to estimate tokens (you can move this to a separate utils file)
export function estimateTokens(text: string): number {
  // Rough estimate: 1 token ≈ 4 characters for English
  return Math.ceil(text.length / 4);
}

// Helper to format date for display
export function formatSessionDate(date: Date): string {
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 60) {
    return `${diffMins} min ago`;
  } else if (diffHours < 24) {
    return `${diffHours} hour${diffHours > 1 ? 's' : ''} ago`;
  } else if (diffDays < 7) {
    return `${diffDays} day${diffDays > 1 ? 's' : ''} ago`;
  } else {
    return date.toLocaleDateString();
  }
}

// Helper to get session preview (first non-empty message)
export function getSessionPreview(session: ChatSession): string {
  const firstUserMessage = session.messages.find(msg => msg.role === 'user');
  if (firstUserMessage) {
    return firstUserMessage.content.substring(0, 100) + 
      (firstUserMessage.content.length > 100 ? '...' : '');
  }
  return 'Empty conversation';
}