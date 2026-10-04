# ShadowLogs

ShadowLogs is a persistent message logger userplugin designed specifically for Vencord. Unlike standard message logging plugins that store deleted and edited messages purely in volatile memory (causing them to vanish the moment Discord is refreshed with `Ctrl + R` or reloaded), ShadowLogs persists message history directly on disk using a lightweight IndexedDB layer.

It combines cross-session durability with safety controls, including automatic threshold filtering on large servers, a dedicated chat bar toggle button, context menu controls, and an integrated retention manager.

---

## Why ShadowLogs?

Standard client mod loggers inject deleted messages directly into the running session's volatile cache. When you navigate between channels or trigger Discord's network sync, the client requests historical messages from Discord's REST API. Because Discord's servers do not return deleted messages, the incoming payload overwrites the client cache, wiping out previous logs.

ShadowLogs solves this architectural limitation by intercepting Discord's internal Flux dispatch pipeline (`LOAD_MESSAGES_SUCCESS` and `LOCAL_MESSAGES_LOADED`). Stored deleted messages from local IndexedDB storage are spliced directly into the incoming payload in chronological order before Discord's `MessageStore` processes them. As a result, the client treats logged messages as native channel history with zero flicker, zero delays, and full persistence across restarts.

### Feature Comparison

| Feature | Standard MessageLogger | ShadowLogs |
| :--- | :---: | :---: |
| **Cross-Session Persistence** | No (lost on `Ctrl + R`) | **Yes (IndexedDB storage)** |
| **Survives Channel Cache Refresh** | No | **Yes (Flux pipeline injection)** |
| **Large Server (>500 members) Protection** | No | **Yes (Auto-disabled by default)** |
| **Chat Bar Toggle Button** | No | **Yes (1-click Server/DM toggle)** |
| **Custom Retention Pruning** | No | **Yes (Seconds/Minutes/Hours/Days/Months)** |
| **Storage Metrics & JSON Export** | No | **Yes (Live stats & single-click export)** |
| **Targeted Log Erasure** | Limited | **Yes (By User, Channel, Server, or Message)** |
| **Edit Revision History Modal** | Yes | **Yes** |

---

## Key Features

### 1. Cross-Session Message Persistence
- Intercepts deletions and revisions in real time.
- Stores deleted messages, edit history, and attachments locally using Vencord's native `@api/DataStore` IndexedDB backend.
- Re-injects messages into Discord's message feed automatically on client reload, channel switch, or history pagination.

### 2. Large Server Protection
- By default, automatic logging is disabled on any server with **more than 500 members**.
- Prevents database bloating, high disk I/O, and unnecessary background processing on busy public servers.
- The member threshold can be customized or overridden via whitelist controls.

### 3. Chat Bar Quick Toggle
- Adds a dedicated icon inside the chat bar next to the emoji and application buttons.
- **Server Context**: Clicking toggles logging for the **entire server** (automatically managing the server whitelist/blacklist).
- **Direct Message Context**: Clicking toggles logging specifically for that individual DM or group chat.
- **Visual Feedback**: Shows an active eye icon when logging is enabled, or an eye with a red strike-through line when logging is disabled for that chat/server.

### 4. Database Retention & Storage Manager
- Built-in management interface located directly inside the plugin settings.
- **Pruning**: Automatically delete messages older than a specified duration, with units selectable from:
  - Seconds
  - Minutes
  - Hours
  - Days
  - Months
- **Clear All**: One-click total database wipe with confirmation protection.
- **JSON Export**: Export the entire database into a structured `.json` backup file.
- **Live Metrics**: Displays live counters for total stored records, deleted message count, and estimated database size on disk.

### 5. Visual Indicators & Styling
- Deleted messages feature a semi-transparent red background and a red left accent border.
- Includes a `[Deleted: HH:MM:SS]` timestamp badge indicating the exact time the message was deleted.
- Supports edit tracking with inline `(edited)` markers and an interactive revision history viewer modal.
- Marked deleted attachments remain visible with a red indicator rather than disappearing from the embed container.

### 6. Comprehensive Context Menus
- **Message Context Menu**: Toggle deleted highlight visibility, open the edit history modal, or permanently remove an individual message from the database.
- **User Context Menu**: Blacklist/whitelist all messages from a specific user, or wipe all historical logs associated with that user ID.
- **Server (Guild) Context Menu**: Whitelist large servers, blacklist small servers, or wipe all logs associated with that server.
- **Channel Context Menu**: Toggle channel-level ignore rules or wipe logs for a single channel.

---

## Technical Architecture

ShadowLogs operates on a three-tier architecture:

1. **Storage Tier (`db.ts`)**:
   - Utilizes Vencord's `@api/DataStore` (`ShadowLogsDataStore`) key-value storage engine backed by IndexedDB.
   - Sanitizes and serializes message structures into lightweight plain JSON objects, preventing prototype pollution and `DataCloneError` exceptions.
   - Avoids problematic IndexedDB boolean indexes, ensuring 100% write reliability across Chromium/Electron engine updates.

2. **Memory Tier (`inMemoryDeleted`)**:
   - Maintains an in-memory hash map of channel IDs to arrays of deleted records.
   - Initialized at client launch for instant, zero-latency synchronous access during render cycles.

3. **Interception Tier (`index.tsx`)**:
   - Hooks into `FluxDispatcher.dispatch` for `LOAD_MESSAGES_SUCCESS` and `LOCAL_MESSAGES_LOADED`.
   - Generates native Discord `MessageRecord` structures via internal factories (`createMessageRecord`).
   - Slices and chronologically sorts messages directly into the payload array before Discord's UI components receive state changes.

---

## Installation Guide

### Prerequisites

Ensure you have the following installed on your system:
- [Git](https://git-scm.com/)
- [Node.js](https://nodejs.org/) (Version 18 or newer)
- [pnpm](https://pnpm.io/) (`npm install -g pnpm`)
- Discord Desktop client (Stable, PTB, or Canary)

---

### Step 1: Set Up Vencord from Source

If you do not already have a local Vencord build repository:

```bash
git clone https://github.com/Vendicated/Vencord.git
cd Vencord
pnpm install
```

---

### Step 2: Install ShadowLogs as a Userplugin

Clone the ShadowLogs repository directly into Vencord's `src/userplugins` folder:

```bash
# Execute from inside your Vencord root folder:
git clone https://github.com/PAVELOS666/Shadow-Logs.git src/userplugins/shadowLogs
```

Verify that the files are situated as follows:

```
Vencord/
└── src/
    └── userplugins/
        └── shadowLogs/
            ├── db.ts
            ├── HistoryModal.tsx
            ├── index.tsx
            ├── settings.tsx
            ├── shadowLogs.css
            ├── types.ts
            └── README.md
```

---

### Step 3: Build and Inject into Discord

Compile the plugin bundle and inject it into your Discord desktop installation:

```bash
# Build the client bundle
pnpm build

# Run the injector
pnpm inject
```

When prompted by the installer, choose your Discord installation (typically `Stable`).

---

### Step 4: Enable the Plugin

1. Restart Discord completely or focus the Discord window and press `Ctrl + R`.
2. Open **User Settings** (the cog icon next to your avatar).
3. Scroll down to the **Vencord** category in the sidebar and select **Plugins**.
4. Use the search bar to locate **ShadowLogs**.
5. Toggle the switch to **ON**.
6. Open the settings cog next to the toggle to customize your retention and threshold preferences.

---

## Configuration Reference

| Option | Type | Default | Description |
| :--- | :---: | :---: | :--- |
| `memberThreshold` | Number | `500` | Servers with more than this number of members are ignored automatically unless whitelisted. |
| `logDeletes` | Boolean | `true` | Enables logging of deleted messages with red highlight and timestamp badges. |
| `logEdits` | Boolean | `true` | Enables tracking of message modifications and edit revision history. |
| `logDeletedAttachments` | Boolean | `true` | Keeps deleted file attachments visible with a red overlay indicator. |
| `ignoreBots` | Boolean | `true` | Automatically ignores messages sent by bot accounts. |
| `ignoreSelf` | Boolean | `false` | When enabled, prevents logging your own deleted or edited messages. |
| `whitelistedGuilds` | String | `""` | Comma-separated list of Guild IDs to ALWAYS log (even if above the member threshold). |
| `blacklistedGuilds` | String | `""` | Comma-separated list of Guild IDs to NEVER log under any circumstances. |
| `blacklistedChannels`| String | `""` | Comma-separated list of Channel or Thread IDs to exclude from logging. |
| `blacklistedUsers` | String | `""` | Comma-separated list of User IDs whose messages will never be logged. |

---

## Frequently Asked Questions

#### Will ShadowLogs slow down Discord?
No. Because automatic logging is disabled on servers with >500 members by default, ShadowLogs only writes to IndexedDB when a message is actually deleted or edited in smaller chats or whitelisted servers. Normal chat traffic incurs zero disk writes.

#### How do I update ShadowLogs when changes are published?
Navigate to your `Vencord/src/userplugins/shadowLogs` directory, pull the latest commits, and rebuild Vencord:

```bash
cd Vencord/src/userplugins/shadowLogs
git pull
cd ../../..
pnpm build
```
Then reload Discord with `Ctrl + R`.

#### Where are messages stored?
All data is stored locally on your machine inside your Discord client's IndexedDB storage under the database name `ShadowLogsDataStore`. No logs or message data are ever sent over the network.

---

## Author

- **PAVELOS** (Discord ID: `710126890798678059`)

---

## License

This project is licensed under the GPL-3.0 License.
