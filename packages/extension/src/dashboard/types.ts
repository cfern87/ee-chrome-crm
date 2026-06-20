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
  chatUrl?: string;
  archived: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface Store {
  conversations: Record<string, Conversation>;
  tags: Record<string, Tag>;
  notes: Record<string, unknown>;
  settings: Record<string, unknown>;
}
