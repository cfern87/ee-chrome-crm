import { Conversation, Tag, ConversationNote, CRMStore, CRMSettings } from './types';

const STORAGE_KEY = 'facebook_crm_store';
const DEFAULT_SETTINGS: CRMSettings = {
  autoTagging: true,
  notificationEnabled: true,
  theme: 'light'
};

export class StorageService {
  static async getStore(): Promise<CRMStore> {
    return new Promise((resolve) => {
      chrome.storage.local.get(STORAGE_KEY, (result) => {
        const store = result[STORAGE_KEY] || {
          conversations: {},
          tags: {},
          notes: {},
          settings: DEFAULT_SETTINGS
        };
        resolve(store);
      });
    });
  }

  static async saveStore(store: CRMStore): Promise<void> {
    return new Promise((resolve) => {
      chrome.storage.local.set({ [STORAGE_KEY]: store }, resolve);
    });
  }

  static async addConversation(conversation: Conversation): Promise<void> {
    const store = await this.getStore();
    store.conversations[conversation.id] = conversation;
    await this.saveStore(store);
  }

  static async updateConversation(id: string, updates: Partial<Conversation>): Promise<void> {
    const store = await this.getStore();
    if (store.conversations[id]) {
      store.conversations[id] = {
        ...store.conversations[id],
        ...updates,
        updatedAt: Date.now()
      };
      await this.saveStore(store);
    }
  }

  static async addTag(tag: Tag): Promise<void> {
    const store = await this.getStore();
    store.tags[tag.id] = tag;
    await this.saveStore(store);
  }

  static async updateTag(id: string, updates: Partial<Tag>): Promise<void> {
    const store = await this.getStore();
    if (store.tags[id]) {
      store.tags[id] = { ...store.tags[id], ...updates };
      await this.saveStore(store);
    }
  }

  static async deleteTag(id: string): Promise<void> {
    const store = await this.getStore();
    delete store.tags[id];
    // Remove tag from all conversations
    Object.keys(store.conversations).forEach((convId) => {
      store.conversations[convId].tags = store.conversations[convId].tags.filter(t => t !== id);
    });
    await this.saveStore(store);
  }

  static async addTagToConversation(conversationId: string, tagId: string): Promise<void> {
    const store = await this.getStore();
    if (store.conversations[conversationId]) {
      const conversation = store.conversations[conversationId];
      if (!conversation.tags.includes(tagId)) {
        conversation.tags.push(tagId);
        conversation.updatedAt = Date.now();
        await this.saveStore(store);
      }
    }
  }

  static async removeTagFromConversation(conversationId: string, tagId: string): Promise<void> {
    const store = await this.getStore();
    if (store.conversations[conversationId]) {
      const conversation = store.conversations[conversationId];
      conversation.tags = conversation.tags.filter(t => t !== tagId);
      conversation.updatedAt = Date.now();
      await this.saveStore(store);
    }
  }

  static async addNote(note: ConversationNote): Promise<void> {
    const store = await this.getStore();
    store.notes[note.id] = note;
    await this.saveStore(store);
  }

  static async deleteNote(id: string): Promise<void> {
    const store = await this.getStore();
    delete store.notes[id];
    await this.saveStore(store);
  }

  static async getConversationNotes(conversationId: string): Promise<ConversationNote[]> {
    const store = await this.getStore();
    return Object.values(store.notes).filter(note => note.conversationId === conversationId);
  }

  static async updateSettings(settings: Partial<CRMSettings>): Promise<void> {
    const store = await this.getStore();
    store.settings = { ...store.settings, ...settings };
    await this.saveStore(store);
  }

  static async exportData(): Promise<CRMStore> {
    return this.getStore();
  }

  static async importData(data: CRMStore): Promise<void> {
    await this.saveStore(data);
  }
}
