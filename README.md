# Facebook Messenger CRM 📱

A powerful CRM system for managing Facebook Messenger conversations with advanced tagging, analytics, and a management dashboard.

## Features

### 🏷️ Tagging System
- **Multiple Tags Per Conversation**: Assign unlimited tags to each conversation
- **Custom Colors**: Choose from preset colors or set custom colors for each tag
- **Tag Management**: Create, edit, and delete tags with ease
- **Usage Analytics**: See how many conversations each tag is used in

### 📊 Management Dashboard
- **Real-time Analytics**: View statistics on conversations, tags, and activity
- **Conversation Management**: Browse, search, and organize all your conversations
- **Tag Editor**: Manage all your tags from a centralized interface
- **Activity Charts**: Track conversation activity over the last 7 days
- **Import/Export**: Backup and restore your data

### 🔌 Chrome Extension
- **Direct Messenger Integration**: Manage tags directly from Facebook Messenger
- **Conversation Detection**: Automatically detects conversations as you browse
- **Quick Tag Addition**: Add tags to conversations without leaving Messenger
- **Real-time Sync**: All changes sync instantly across devices

### 💾 Data Management
- **Local Storage**: All data is stored locally in your browser
- **Export/Import**: Download your data as JSON for backup
- **Multi-device Sync**: Use IndexedDB for persistent storage

## Project Structure

```
facebook-crm/
├── packages/
│   ├── extension/          # Chrome Extension
│   │   ├── public/         # Static assets and manifest
│   │   ├── src/
│   │   │   ├── background.ts    # Service Worker
│   │   │   ├── content.ts       # Content script for Messenger
│   │   │   └── popup.js         # Extension popup UI
│   │   ├── vite.config.ts
│   │   └── package.json
│   │
│   ├── dashboard/          # React Management Dashboard
│   │   ├── src/
│   │   │   ├── App.tsx
│   │   │   ├── components/
│   │   │   │   ├── Dashboard.tsx        # Analytics dashboard
│   │   │   │   ├── ConversationList.tsx # Conversation browser
│   │   │   │   └── TagManager.tsx       # Tag management
│   │   │   ├── main.tsx
│   │   │   └── index.css
│   │   ├── index.html
│   │   ├── vite.config.ts
│   │   └── package.json
│   │
│   └── shared/             # Shared types and utilities
│       ├── types.ts
│       └── storage.ts
│
├── README.md
├── package.json
└── .gitignore
```

## Installation

### Prerequisites
- Node.js 16+ and npm
- Google Chrome or Chromium-based browser

### Setup

1. **Clone or initialize the repository**
```bash
git clone <repository-url>
cd facebook-crm
```

2. **Install dependencies**
```bash
npm install
```

This will install dependencies for both the extension and dashboard thanks to the workspace setup.

## Development

### Build the Extension

```bash
cd packages/extension
npm run build
```

The compiled extension will be in `packages/extension/dist/`.

### Load Extension in Chrome

1. Open `chrome://extensions/`
2. Enable "Developer mode" (top right)
3. Click "Load unpacked"
4. Select `packages/extension/dist/` folder
5. The extension is now active!

### Run the Dashboard

```bash
cd packages/dashboard
npm run dev
```

The dashboard will be available at `http://localhost:5173`

### Development Mode (Watch Mode)

For extension:
```bash
cd packages/extension
npm run dev  # Requires manual reload in Chrome
```

For dashboard:
```bash
cd packages/dashboard
npm run dev
```

## Usage

### Chrome Extension

1. **Open Facebook Messenger** at `https://www.facebook.com/messages/`
2. **Look for the "+ Tag" button** in each conversation
3. **Click to add tags**:
   - Select existing tags
   - Or create new tags on the fly
4. **View your tags** in the extension popup

### Management Dashboard

1. **Start the dashboard**:
```bash
cd packages/dashboard
npm run dev
```

2. **Navigate to** `http://localhost:5173`

3. **Tabs available**:
   - **Dashboard**: View analytics and activity charts
   - **Conversations**: Browse and manage all conversations
   - **Tags**: Create and manage tags
   - **Settings**: Configure preferences and export/import data

## Features Breakdown

### Dashboard Analytics
- Total conversations count
- Active vs archived conversations
- Total tags in use
- Average tags per conversation
- Most used tags with usage charts
- 7-day activity visualization
- Recent conversations feed

### Conversation Management
- Search conversations by name or content
- View full conversation details
- Add/remove tags from conversations
- Archive conversations
- Delete conversations permanently
- View last message and timestamp

### Tag Management
- Create tags with custom names and colors
- 10 preset colors for quick selection
- Edit existing tags
- Delete tags (removes from all conversations)
- View usage count per tag
- Visual tag statistics

### Settings
- Toggle auto-tagging
- Toggle notifications
- Export data to JSON file
- Import data from JSON file
- Theme selection (light/dark)

## Data Storage

All data is stored in:
- **Chrome Extension**: `chrome.storage.local`
- **Dashboard**: `localStorage`

Both use the same data structure, allowing seamless sync between the extension and dashboard.

### Data Structure

```typescript
interface CRMStore {
  conversations: Record<string, Conversation>;
  tags: Record<string, Tag>;
  notes: Record<string, ConversationNote>;
  settings: CRMSettings;
}

interface Conversation {
  id: string;
  participantName: string;
  participantId: string;
  lastMessage: string;
  lastMessageTime: number;
  tags: string[];
  archived: boolean;
  createdAt: number;
  updatedAt: number;
}

interface Tag {
  id: string;
  name: string;
  color: string;
  createdAt: number;
}
```

## Backup & Restore

### Export Data
1. Go to **Settings** tab in dashboard
2. Click **📥 Export Data**
3. A JSON file will be downloaded with all your data

### Import Data
1. Go to **Settings** tab in dashboard
2. Click **📤 Import Data**
3. Select a previously exported JSON file
4. Your data will be restored immediately

## Tech Stack

### Extension
- **TypeScript**: Type-safe development
- **React**: UI components for popup
- **Vite**: Fast build tool
- **Chrome APIs**: For storage and messaging

### Dashboard
- **React 18**: Modern UI framework
- **TypeScript**: Type safety
- **Tailwind CSS**: Utility-first styling
- **Lucide React**: Beautiful icons
- **Vite**: Fast dev server and builds

### Shared
- **UUID**: Unique ID generation
- **TypeScript**: Shared type definitions

## Building for Production

### Extension
```bash
cd packages/extension
npm run build
```

### Dashboard
```bash
cd packages/dashboard
npm run build
```

The built files will be in respective `dist/` directories.

## Limitations & Future Enhancements

### Current Limitations
- Data is stored locally (no cloud sync)
- Requires manual conversation detection
- No automated backup
- Limited to your browser's storage limits (~5-10MB)

### Future Enhancements
- Backend server for cloud sync
- Real-time Facebook Graph API integration
- Automated message tracking
- Analytics reports and exports
- Team collaboration features
- Conversation templates
- Auto-tagging rules
- Integration with other platforms (Instagram, WhatsApp)

## Troubleshooting

### Extension not showing tags
1. Refresh the Messenger page
2. Check that the extension is enabled in Chrome
3. Open DevTools (F12) and check console for errors

### Dashboard shows no data
1. Ensure localStorage is enabled
2. Check if you're using the same browser profile
3. Try exporting extension data and importing to dashboard

### Extension popup shows blank
1. Reload the extension from `chrome://extensions/`
2. Hard refresh the popup window
3. Check browser console for errors

## License

MIT License - feel free to use, modify, and distribute

## Support

For issues, feature requests, or questions:
1. Check this README for common solutions
2. Open an issue in the repository
3. Review the code structure for insights

---

Built with ❤️ for managing Facebook Messenger conversations
