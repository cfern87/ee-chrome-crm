import React, { useState } from 'react';
import { Conversation, Tag } from '../../types';
import { X, Plus, Trash2, Archive, ExternalLink } from 'lucide-react';

interface ConversationListProps {
  conversations: Conversation[];
  tags: Tag[];
  onUpdate: (id: string, updates: Partial<Conversation>) => void;
  onDelete: (id: string) => void;
  onAddTag: (conversationId: string, tagId: string) => void;
  onRemoveTag: (conversationId: string, tagId: string) => void;
  onSearchChange: (query: string) => void;
  searchQuery: string;
}

export default function ConversationList({
  conversations,
  tags,
  onUpdate,
  onDelete,
  onAddTag,
  onRemoveTag,
  onSearchChange,
  searchQuery
}: ConversationListProps) {
  const [selectedConvId, setSelectedConvId] = useState<string | null>(null);
  const [showAddTag, setShowAddTag] = useState<string | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);

  const selectedConversation = selectedConvId ? conversations.find(c => c.id === selectedConvId) : null;
  const selectedTags = selectedConversation ? tags.filter(t => selectedConversation.tags.includes(t.id)) : [];
  const availableTags = selectedConversation ? tags.filter(t => !selectedConversation.tags.includes(t.id)) : [];

  return (
    <div className="flex h-full bg-slate-800">
      {/* List */}
      <div className="w-1/3 border-r border-slate-600 flex flex-col">
        {/* Search */}
        <div className="p-4 border-b border-slate-600">
          <input
            type="text"
            placeholder="Search conversations..."
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            className="w-full px-4 py-2 bg-slate-700 text-white rounded-lg border border-slate-600 focus:border-blue-500 focus:outline-none"
          />
        </div>

        {/* Conversations */}
        <div className="flex-1 overflow-auto">
          {conversations.length === 0 ? (
            <div className="p-4 text-center text-slate-400">No conversations found</div>
          ) : (
            conversations.map((conv) => (
              <button
                key={conv.id}
                onClick={() => setSelectedConvId(conv.id)}
                className={`w-full text-left p-4 border-b border-slate-600 hover:bg-slate-700 transition-colors ${
                  selectedConvId === conv.id ? 'bg-blue-600' : 'bg-slate-800'
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="font-semibold text-white truncate">{conv.participantName}</div>
                  {conv.chatUrl && (
                    <a
                      href={conv.chatUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={e => e.stopPropagation()}
                      className="flex-shrink-0 text-slate-400 hover:text-blue-400 transition-colors"
                      title="Open chat"
                    >
                      <ExternalLink size={14} />
                    </a>
                  )}
                </div>
                <div className="text-sm text-slate-300 truncate mt-1">{conv.lastMessage}</div>
                <div className="flex gap-1 mt-2 flex-wrap">
                  {conv.tags.slice(0, 2).map((tagId) => {
                    const tag = tags.find(t => t.id === tagId);
                    return tag ? (
                      <span key={tag.id} className="text-xs px-2 py-1 rounded text-white" style={{ background: tag.color }}>
                        {tag.name}
                      </span>
                    ) : null;
                  })}
                  {conv.tags.length > 2 && <span className="text-xs text-slate-400">+{conv.tags.length - 2}</span>}
                </div>
              </button>
            ))
          )}
        </div>
      </div>

      {/* Details */}
      <div className="w-2/3 p-6 flex flex-col">
        {selectedConversation ? (
          <>
            <div className="mb-6">
              <div className="flex items-center gap-3 mb-2">
                {selectedConversation.chatUrl ? (
                  <a
                    href={selectedConversation.chatUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-3xl font-bold text-white hover:text-blue-400 transition-colors flex items-center gap-2 group"
                  >
                    {selectedConversation.participantName}
                    <ExternalLink size={20} className="opacity-0 group-hover:opacity-100 transition-opacity text-blue-400" />
                  </a>
                ) : (
                  <h2 className="text-3xl font-bold text-white">{selectedConversation.participantName}</h2>
                )}
              </div>
              <p className="text-slate-400">
                Last message: {new Date(selectedConversation.lastMessageTime).toLocaleDateString()}
              </p>
            </div>

            {/* Tags Section */}
            <div className="mb-6">
              <h3 className="text-lg font-semibold text-white mb-3">Tags</h3>
              <div className="flex flex-wrap gap-2 mb-3">
                {selectedTags.map((tag) => (
                  <div
                    key={tag.id}
                    className="flex items-center gap-2 px-3 py-2 rounded-lg text-white"
                    style={{ background: tag.color }}
                  >
                    {tag.name}
                    <button
                      onClick={() => onRemoveTag(selectedConversation.id, tag.id)}
                      className="ml-1 hover:opacity-80"
                    >
                      <X size={16} />
                    </button>
                  </div>
                ))}
              </div>

              {availableTags.length > 0 && (
                <div className="relative">
                  <button
                    onClick={() => setShowAddTag(showAddTag === selectedConversation.id ? null : selectedConversation.id)}
                    className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg flex items-center gap-2 font-medium transition-colors"
                  >
                    <Plus size={16} />
                    Add Tag
                  </button>

                  {showAddTag === selectedConversation.id && (
                    <div className="absolute top-full mt-2 bg-slate-700 rounded-lg shadow-lg z-10 min-w-[200px]">
                      {availableTags.map((tag) => (
                        <button
                          key={tag.id}
                          onClick={() => {
                            onAddTag(selectedConversation.id, tag.id);
                            setShowAddTag(null);
                          }}
                          className="w-full text-left px-4 py-2 text-white hover:bg-slate-600 first:rounded-t-lg last:rounded-b-lg"
                          style={{ borderLeft: `4px solid ${tag.color}` }}
                        >
                          {tag.name}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Message Preview */}
            <div className="mb-6 flex-1">
              <h3 className="text-lg font-semibold text-white mb-3">Last Message</h3>
              <p className="text-slate-300 bg-slate-700 p-4 rounded-lg">{selectedConversation.lastMessage}</p>
            </div>

            {/* Actions */}
            <div className="flex gap-2">
              {selectedConversation.chatUrl && (
                <a
                  href={selectedConversation.chatUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex-1 py-2 px-4 bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-medium flex items-center justify-center gap-2 transition-colors"
                >
                  <ExternalLink size={16} />
                  Open Chat
                </a>
              )}
              <button
                onClick={() => {
                  onUpdate(selectedConversation.id, { archived: !selectedConversation.archived });
                }}
                className="flex-1 py-2 px-4 bg-slate-700 hover:bg-slate-600 text-white rounded-lg font-medium flex items-center justify-center gap-2 transition-colors"
              >
                <Archive size={16} />
                {selectedConversation.archived ? 'Unarchive' : 'Archive'}
              </button>
              <button
                onClick={() => setDeleteConfirm(selectedConversation.id)}
                className="flex-1 py-2 px-4 bg-red-600 hover:bg-red-700 text-white rounded-lg font-medium flex items-center justify-center gap-2 transition-colors"
              >
                <Trash2 size={16} />
                Delete
              </button>
            </div>

            {/* Delete confirmation modal */}
            {deleteConfirm === selectedConversation.id && (
              <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
                <div className="bg-slate-700 rounded-lg p-6 max-w-sm mx-4">
                  <h3 className="text-lg font-bold text-white mb-2">Delete conversation?</h3>
                  <p className="text-slate-300 mb-4">
                    Are you sure you want to delete <strong>{selectedConversation.participantName}</strong>? This action cannot be undone.
                  </p>
                  <div className="flex gap-3">
                    <button
                      onClick={() => setDeleteConfirm(null)}
                      className="flex-1 py-2 px-4 bg-slate-600 hover:bg-slate-500 text-white rounded-lg font-medium transition-colors"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={() => {
                        onDelete(selectedConversation.id);
                        setSelectedConvId(null);
                        setDeleteConfirm(null);
                      }}
                      className="flex-1 py-2 px-4 bg-red-600 hover:bg-red-700 text-white rounded-lg font-medium transition-colors"
                    >
                      Yes, Delete
                    </button>
                  </div>
                </div>
              </div>
            )}
          </>
        ) : (
          <div className="flex items-center justify-center h-full text-slate-400">
            Select a conversation to view details
          </div>
        )}
      </div>
    </div>
  );
}
