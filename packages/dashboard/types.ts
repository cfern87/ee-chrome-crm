export interface Tag {
  id: string;
  name: string;
  color: string;
  createdAt: number;
}

export interface Conversation {
  id: string;
  participantName: string;
  participantId: string;
  lastMessage: string;
  lastMessageTime: number;
  tags: string[];
  profilePicUrl?: string;
  archived: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface ConversationNote {
  id: string;
  conversationId: string;
  content: string;
  createdAt: number;
  updatedAt: number;
}

export interface CRMStore {
  conversations: Record<string, Conversation>;
  tags: Record<string, Tag>;
  notes: Record<string, ConversationNote>;
  settings: CRMSettings;
}

export interface CRMSettings {
  autoTagging: boolean;
  notificationEnabled: boolean;
  theme: 'light' | 'dark';
}
