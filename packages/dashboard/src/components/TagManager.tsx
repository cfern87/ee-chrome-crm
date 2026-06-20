import React, { useState } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { Tag, Conversation } from '../../types';
import { Trash2, Plus, Edit2 } from 'lucide-react';

interface TagManagerProps {
  tags: Tag[];
  conversations: Conversation[];
  onAdd: (tag: Tag) => void;
  onUpdate: (id: string, updates: Partial<Tag>) => void;
  onDelete: (id: string) => void;
}

const COLORS = [
  '#FF6B6B', '#4ECDC4', '#45B7D1', '#FFA07A', '#98D8C8',
  '#F7DC6F', '#BB8FCE', '#85C1E2', '#F8B988', '#52B788'
];

export default function TagManager({
  tags,
  conversations,
  onAdd,
  onUpdate,
  onDelete
}: TagManagerProps) {
  const [newTagName, setNewTagName] = useState('');
  const [newTagColor, setNewTagColor] = useState(COLORS[0]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editColor, setEditColor] = useState('');

  const getTagUsage = (tagId: string) => {
    return conversations.filter(conv => conv.tags.includes(tagId)).length;
  };

  const handleAddTag = () => {
    if (!newTagName.trim()) {
      alert('Please enter a tag name');
      return;
    }

    const tag: Tag = {
      id: uuidv4(),
      name: newTagName.trim(),
      color: newTagColor,
      createdAt: Date.now()
    };

    onAdd(tag);
    setNewTagName('');
    setNewTagColor(COLORS[0]);
  };

  const handleUpdateTag = (id: string) => {
    if (!editName.trim()) {
      alert('Please enter a tag name');
      return;
    }

    onUpdate(id, {
      name: editName.trim(),
      color: editColor
    });
    setEditingId(null);
  };

  return (
    <div className="p-8">
      <div className="max-w-4xl mx-auto">
        {/* Create New Tag */}
        <div className="bg-slate-700 rounded-lg p-6 mb-8">
          <h2 className="text-2xl font-bold text-white mb-4">Create New Tag</h2>
          <div className="flex gap-3">
            <input
              type="text"
              placeholder="Tag name..."
              value={newTagName}
              onChange={(e) => setNewTagName(e.target.value)}
              onKeyPress={(e) => e.key === 'Enter' && handleAddTag()}
              className="flex-1 px-4 py-2 bg-slate-600 text-white rounded-lg border border-slate-500 focus:border-blue-500 focus:outline-none"
            />
            <div className="flex items-center gap-2">
              <label className="text-slate-300">Color:</label>
              <input
                type="color"
                value={newTagColor}
                onChange={(e) => setNewTagColor(e.target.value)}
                className="w-12 h-10 rounded-lg cursor-pointer border border-slate-500"
              />
            </div>
            <button
              onClick={handleAddTag}
              className="px-6 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-medium flex items-center gap-2 transition-colors"
            >
              <Plus size={18} />
              Create
            </button>
          </div>

          {/* Color Presets */}
          <div className="mt-4">
            <p className="text-sm text-slate-400 mb-2">Quick colors:</p>
            <div className="flex gap-2 flex-wrap">
              {COLORS.map((color) => (
                <button
                  key={color}
                  onClick={() => setNewTagColor(color)}
                  className="w-8 h-8 rounded-full border-2 transition-transform hover:scale-110"
                  style={{
                    backgroundColor: color,
                    borderColor: newTagColor === color ? '#fff' : 'transparent'
                  }}
                />
              ))}
            </div>
          </div>
        </div>

        {/* Tags List */}
        <div className="bg-slate-700 rounded-lg p-6">
          <h2 className="text-2xl font-bold text-white mb-4">Tags ({tags.length})</h2>

          {tags.length === 0 ? (
            <div className="text-center text-slate-400 py-8">No tags yet. Create one to get started!</div>
          ) : (
            <div className="space-y-3">
              {tags.map((tag) => {
                const usage = getTagUsage(tag.id);
                const isEditing = editingId === tag.id;

                return (
                  <div
                    key={tag.id}
                    className="flex items-center justify-between p-4 bg-slate-600 rounded-lg hover:bg-slate-500 transition-colors"
                  >
                    <div className="flex items-center gap-3 flex-1">
                      <div
                        className="w-6 h-6 rounded"
                        style={{ backgroundColor: tag.color }}
                      />
                      {isEditing ? (
                        <div className="flex gap-2 flex-1">
                          <input
                            type="text"
                            value={editName}
                            onChange={(e) => setEditName(e.target.value)}
                            className="flex-1 px-3 py-1 bg-slate-700 text-white rounded border border-slate-500 focus:border-blue-500 focus:outline-none"
                          />
                          <input
                            type="color"
                            value={editColor}
                            onChange={(e) => setEditColor(e.target.value)}
                            className="w-10 h-8 rounded cursor-pointer border border-slate-500"
                          />
                        </div>
                      ) : (
                        <div>
                          <div className="text-white font-semibold">{tag.name}</div>
                          <div className="text-sm text-slate-400">Used in {usage} conversation{usage !== 1 ? 's' : ''}</div>
                        </div>
                      )}
                    </div>

                    <div className="flex gap-2">
                      {isEditing ? (
                        <>
                          <button
                            onClick={() => handleUpdateTag(tag.id)}
                            className="px-3 py-1 bg-blue-600 hover:bg-blue-700 text-white rounded text-sm font-medium transition-colors"
                          >
                            Save
                          </button>
                          <button
                            onClick={() => setEditingId(null)}
                            className="px-3 py-1 bg-slate-700 hover:bg-slate-800 text-white rounded text-sm font-medium transition-colors"
                          >
                            Cancel
                          </button>
                        </>
                      ) : (
                        <>
                          <button
                            onClick={() => {
                              setEditingId(tag.id);
                              setEditName(tag.name);
                              setEditColor(tag.color);
                            }}
                            className="p-2 bg-slate-700 hover:bg-slate-800 text-white rounded transition-colors"
                          >
                            <Edit2 size={16} />
                          </button>
                          <button
                            onClick={() => {
                              if (window.confirm(`Delete tag "${tag.name}"? It will be removed from all conversations.`)) {
                                onDelete(tag.id);
                              }
                            }}
                            className="p-2 bg-red-600 hover:bg-red-700 text-white rounded transition-colors"
                          >
                            <Trash2 size={16} />
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
