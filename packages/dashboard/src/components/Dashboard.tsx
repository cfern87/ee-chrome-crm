import React from 'react';
import { CRMStore, Conversation, Tag } from '../../types';
import { Users, Tags, MessageSquare, TrendingUp } from 'lucide-react';

interface DashboardProps {
  store: CRMStore;
  conversations: Conversation[];
  tags: Tag[];
}

export default function Dashboard({ store, conversations, tags }: DashboardProps) {
  const totalConversations = Object.keys(store.conversations).length;
  const archivedConversations = Object.values(store.conversations).filter(c => c.archived).length;
  const totalTags = Object.keys(store.tags).length;

  // Get most used tags
  const tagUsage = tags.map(tag => ({
    ...tag,
    count: Object.values(store.conversations).filter(conv => conv.tags.includes(tag.id)).length
  })).sort((a, b) => b.count - a.count).slice(0, 5);

  // Get recent conversations
  const recentConversations = Object.values(store.conversations)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 5);

  // Get conversations by date
  const last7Days = Array.from({ length: 7 }, (_, i) => {
    const date = new Date();
    date.setDate(date.getDate() - i);
    return date.toLocaleDateString();
  }).reverse();

  const conversationsByDate = last7Days.map(date => ({
    date,
    count: Object.values(store.conversations).filter(conv =>
      new Date(conv.createdAt).toLocaleDateString() === date
    ).length
  }));

  return (
    <div className="p-8">
      <div className="max-w-6xl mx-auto">
        {/* Stats Grid */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-8">
          <div className="bg-gradient-to-br from-blue-600 to-blue-700 rounded-lg p-6 text-white">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm opacity-80">Total Conversations</div>
                <div className="text-3xl font-bold mt-2">{totalConversations}</div>
              </div>
              <Users size={40} opacity={0.3} />
            </div>
          </div>

          <div className="bg-gradient-to-br from-purple-600 to-purple-700 rounded-lg p-6 text-white">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm opacity-80">Active Conversations</div>
                <div className="text-3xl font-bold mt-2">{totalConversations - archivedConversations}</div>
              </div>
              <MessageSquare size={40} opacity={0.3} />
            </div>
          </div>

          <div className="bg-gradient-to-br from-pink-600 to-pink-700 rounded-lg p-6 text-white">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm opacity-80">Total Tags</div>
                <div className="text-3xl font-bold mt-2">{totalTags}</div>
              </div>
              <Tags size={40} opacity={0.3} />
            </div>
          </div>

          <div className="bg-gradient-to-br from-teal-600 to-teal-700 rounded-lg p-6 text-white">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm opacity-80">Avg Tags per Conv</div>
                <div className="text-3xl font-bold mt-2">
                  {totalConversations > 0
                    ? (Object.values(store.conversations).reduce((sum, c) => sum + c.tags.length, 0) / totalConversations).toFixed(1)
                    : '0'}
                </div>
              </div>
              <TrendingUp size={40} opacity={0.3} />
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
          {/* Most Used Tags */}
          <div className="bg-slate-700 rounded-lg p-6">
            <h3 className="text-xl font-bold text-white mb-4">Most Used Tags</h3>
            {tagUsage.length === 0 ? (
              <div className="text-center text-slate-400 py-8">No tags yet</div>
            ) : (
              <div className="space-y-3">
                {tagUsage.map((tag) => (
                  <div key={tag.id} className="flex items-center gap-3">
                    <div className="w-3 h-3 rounded-full" style={{ backgroundColor: tag.color }} />
                    <div className="flex-1">
                      <div className="text-white font-medium">{tag.name}</div>
                      <div className="w-full bg-slate-600 rounded-full h-2 mt-1">
                        <div
                          className="h-full rounded-full transition-all"
                          style={{
                            backgroundColor: tag.color,
                            width: `${(tag.count / Math.max(...tagUsage.map(t => t.count), 1)) * 100}%`
                          }}
                        />
                      </div>
                    </div>
                    <div className="text-slate-400 text-sm font-medium">{tag.count}</div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Recent Conversations */}
          <div className="bg-slate-700 rounded-lg p-6">
            <h3 className="text-xl font-bold text-white mb-4">Recent Conversations</h3>
            {recentConversations.length === 0 ? (
              <div className="text-center text-slate-400 py-8">No conversations yet</div>
            ) : (
              <div className="space-y-3">
                {recentConversations.map((conv) => (
                  <div key={conv.id} className="p-3 bg-slate-600 rounded-lg hover:bg-slate-500 transition-colors">
                    <div className="font-medium text-white">{conv.participantName}</div>
                    <div className="text-sm text-slate-300 truncate mt-1">{conv.lastMessage}</div>
                    <div className="flex gap-1 mt-2 flex-wrap">
                      {conv.tags.slice(0, 2).map((tagId) => {
                        const tag = tags.find(t => t.id === tagId);
                        return tag ? (
                          <span
                            key={tag.id}
                            className="text-xs px-2 py-1 rounded text-white"
                            style={{ backgroundColor: tag.color }}
                          >
                            {tag.name}
                          </span>
                        ) : null;
                      })}
                      {conv.tags.length > 2 && (
                        <span className="text-xs text-slate-400">+{conv.tags.length - 2}</span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Activity Chart */}
          <div className="bg-slate-700 rounded-lg p-6 lg:col-span-2">
            <h3 className="text-xl font-bold text-white mb-4">Conversations Last 7 Days</h3>
            <div className="flex items-end gap-2 h-32">
              {conversationsByDate.map((item, idx) => (
                <div key={idx} className="flex-1 flex flex-col items-center">
                  <div className="w-full bg-slate-600 rounded-t relative group">
                    <div
                      className="w-full bg-gradient-to-t from-blue-500 to-blue-400 rounded-t transition-all"
                      style={{ height: `${Math.max((item.count / Math.max(...conversationsByDate.map(d => d.count), 1)) * 100, 5)}%` }}
                    >
                      {item.count > 0 && (
                        <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-2 py-1 bg-slate-800 text-white text-xs rounded opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap">
                          {item.count}
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="text-xs text-slate-400 mt-2 text-center">
                    {new Date(item.date).toLocaleDateString('en-US', { weekday: 'short' })}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
