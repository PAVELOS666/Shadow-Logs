/*
 * Shadow Logs - Persistent Message Logger for Vencord
 * Core Plugin Implementation
 */

import "./shadowLogs.css";

import { ChatBarButton, ChatBarButtonFactory } from "@api/ChatButtons";
import { findGroupChildrenByChildId, NavContextMenuPatchCallback } from "@api/ContextMenu";
import { updateMessage } from "@api/MessageUpdater";
import ErrorBoundary from "@components/ErrorBoundary";
import { DeleteIcon, EyeIcon } from "@components/Icons";
import { Logger } from "@utils/Logger";
import { classes } from "@utils/misc";
import definePlugin from "@utils/types";
import { Channel, Guild, Message, User } from "@vencord/discord-types";
import { findByCodeLazy, findCssClassesLazy } from "@webpack";
import {
    ChannelStore,
    FluxDispatcher,
    GuildMemberCountStore,
    GuildStore,
    Menu,
    MessageCache,
    MessageStore,
    Parser,
    SelectedChannelStore,
    showToast,
    Timestamp,
    UserStore,
    useStateFromStores
} from "@webpack/common";

import {
    addEdit,
    deleteByAuthor,
    deleteByChannel,
    deleteByGuild,
    deleteSingleMessage,
    getAllDeleted,
    markDeleted,
    saveDeletedMessage,
    saveMessagesBatch,
    saveNewMessage,
    toEpoch,
    toRawStoredMessage
} from "./db";
import { openDeletedHistoryModal } from "./DeletedHistoryModal";
import { openHistoryModal } from "./HistoryModal";
import { settings } from "./settings";
import { ShadowAttachment, ShadowMessage, StoredShadowMessage } from "./types";

const logger = new Logger("ShadowLogs");
const MessageClasses = findCssClassesLazy("edited", "communicationDisabled", "isSystemMessage");
const createMessageRecord = findByCodeLazy(".createFromServer(", ".isBlockedForMessage", "messageReference:");

// In-memory cache for ultra-fast, synchronous rehydration across reloads
export const inMemoryDeleted = new Map<string, StoredShadowMessage[]>();

export function clearInMemory() {
    inMemoryDeleted.clear();
    MessageStore.emitChange();
}

export function pruneInMemory(cutoff: number) {
    for (const [ch, list] of inMemoryDeleted.entries()) {
        inMemoryDeleted.set(ch, list.filter(m => toEpoch(m.timestamp) >= cutoff));
    }
    MessageStore.emitChange();
}

export function isLocationLogged(channel: Channel): boolean {
    if (!channel) return true;
    const { blacklistedChannels, blacklistedGuilds, whitelistedGuilds, memberThreshold } = settings.store;

    if (channel.guild_id) {
        const bGuilds = blacklistedGuilds?.split(",").map(s => s.trim()).filter(Boolean) || [];
        if (bGuilds.includes(channel.guild_id)) return false;

        const wGuilds = whitelistedGuilds?.split(",").map(s => s.trim()).filter(Boolean) || [];
        if (wGuilds.includes(channel.guild_id)) return true;

        const guild = GuildStore.getGuild(channel.guild_id);
        const memberCount = (guild as any)?.memberCount ?? GuildMemberCountStore?.getMemberCount(channel.guild_id);
        const threshold = memberThreshold || 500;
        if (typeof memberCount === "number" && memberCount > 0 && memberCount > threshold) {
            return false;
        }
        return true;
    } else {
        const bChannels = blacklistedChannels?.split(",").map(s => s.trim()).filter(Boolean) || [];
        return !bChannels.includes(channel.id);
    }
}

function ShadowLogsEnabledIcon({ height = 20, width = 20 }: { height?: number | string; width?: number | string }) {
    return (
        <svg width={width} height={height} viewBox="0 0 24 24" style={{ scale: "1.1" }}>
            <path
                fill="currentColor"
                d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z"
            />
        </svg>
    );
}

function ShadowLogsDisabledIcon({ height = 20, width = 20 }: { height?: number | string; width?: number | string }) {
    return (
        <svg width={width} height={height} viewBox="0 0 24 24" style={{ scale: "1.1" }}>
            <mask id="shadowlogs-disabled-mask">
                <path fill="#fff" d="M0 0h24v24H0Z" />
                <path stroke="#000" strokeWidth="3" d="M0 24 24 0" transform="translate(-1, -1)" />
            </mask>
            <path
                fill="currentColor"
                mask="url(#shadowlogs-disabled-mask)"
                d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z"
            />
            <path fill="var(--status-danger, #f23f43)" d="m20.5 2.1 1.4 1.4L4.1 21.3 2.7 19.9 20.5 2.1z" />
        </svg>
    );
}

const ShadowLogsChatBarButton: ChatBarButtonFactory = ({ channel, isAnyChat }) => {
    if (!channel || !isAnyChat) return null;

    const { blacklistedChannels, blacklistedGuilds, whitelistedGuilds, memberThreshold } = settings.use([
        "blacklistedChannels",
        "blacklistedGuilds",
        "whitelistedGuilds",
        "memberThreshold",
    ]);

    const isGuild = !!channel.guild_id;
    const guild = isGuild ? GuildStore.getGuild(channel.guild_id) : null;
    const isLogged = isLocationLogged(channel);

    const toggle = () => {
        if (isGuild && channel.guild_id) {
            const guildId = channel.guild_id;
            let bList = blacklistedGuilds?.split(",").map(s => s.trim()).filter(Boolean) || [];
            let wList = whitelistedGuilds?.split(",").map(s => s.trim()).filter(Boolean) || [];
            const memberCount = (guild as any)?.memberCount ?? GuildMemberCountStore?.getMemberCount(guildId) ?? 0;
            const isLarge = memberCount > (memberThreshold || 500);

            if (isLogged) {
                // Disable whole server
                if (wList.includes(guildId)) {
                    wList = wList.filter(id => id !== guildId);
                    settings.store.whitelistedGuilds = wList.join(", ");
                }
                if (!bList.includes(guildId)) {
                    bList.push(guildId);
                    settings.store.blacklistedGuilds = bList.join(", ");
                }
                showToast("Shadow Logs: Disabled for server " + (guild?.name || "Server"), "message");
            } else {
                // Enable whole server
                if (bList.includes(guildId)) {
                    bList = bList.filter(id => id !== guildId);
                    settings.store.blacklistedGuilds = bList.join(", ");
                }
                if (isLarge && !wList.includes(guildId)) {
                    wList.push(guildId);
                    settings.store.whitelistedGuilds = wList.join(", ");
                }
                showToast("Shadow Logs: Enabled for server " + (guild?.name || "Server"), "success");
            }
        } else {
            // DM / Group DM
            let cList = blacklistedChannels?.split(",").map(s => s.trim()).filter(Boolean) || [];
            if (isLogged) {
                if (!cList.includes(channel.id)) {
                    cList.push(channel.id);
                    settings.store.blacklistedChannels = cList.join(", ");
                }
                showToast("Shadow Logs: Disabled for this chat", "message");
            } else {
                cList = cList.filter(id => id !== channel.id);
                settings.store.blacklistedChannels = cList.join(", ");
                showToast("Shadow Logs: Enabled for this chat", "success");
            }
        }
    };

    const tooltip = isLogged
        ? (isGuild ? "Shadow Logs: Active for " + (guild?.name || "Server") + " (Click to disable server)" : "Shadow Logs: Active for DM (Click to disable)")
        : (isGuild ? "Shadow Logs: Ignored for " + (guild?.name || "Server") + " (Click to enable server)" : "Shadow Logs: Ignored for DM (Click to enable)");

    return (
        <ChatBarButton tooltip={tooltip} onClick={toggle}>
            {isLogged ? <ShadowLogsEnabledIcon /> : <ShadowLogsDisabledIcon />}
        </ChatBarButton>
    );
};

export function parseEditContent(content: string, message: Message) {
    return Parser.parse(content, true, {
        channelId: message.channel_id,
        messageId: message.id,
        allowLinks: true,
        allowHeading: true,
        allowList: true,
        allowEmojiLinks: true,
        viewingChannelId: SelectedChannelStore.getChannelId(),
    });
}

function doesMessageHaveHistory(message: ShadowMessage): boolean {
    return !!message.deleted || !!message.editHistory?.length || !!message.attachments?.some((a: ShadowAttachment) => a.deleted);
}

export function createRawDiscordMessage(item: StoredShadowMessage) {
    // Zachowaj oryginalny timestamp wysłania wiadomości z unikalnego Snowflake ID
    let originalTimestamp = item.timestamp;
    if (item.id) {
        try {
            const sfTime = Number((BigInt(item.id) >> 22n) + 1420070400000n);
            if (!isNaN(sfTime) && sfTime > 1420070400000) {
                originalTimestamp = sfTime;
            }
        } catch {}
    }

    const isoTimestamp = new Date(originalTimestamp || Date.now()).toISOString();

    return {
        id: item.id,
        type: 0,
        channel_id: item.channelId,
        guild_id: item.guildId,
        content: item.content ?? "",
        author: {
            id: item.authorId || "0",
            username: item.authorName || "User",
            avatar: item.authorAvatar || null,
            discriminator: "0",
            bot: false,
        },
        attachments: (item.attachments || []).map(a => ({
            id: a.id,
            url: a.url,
            proxy_url: a.proxy_url || a.url,
            filename: a.filename || "file",
            size: a.size || 0,
            content_type: a.content_type,
            deleted: true,
        })),
        embeds: [],
        mentions: [],
        mention_roles: [],
        mention_everyone: false,
        pinned: false,
        tts: false,
        timestamp: isoTimestamp,
        state: "SENT",
        deleted: true,
        deletedAt: item.deletedAt,
        editHistory: (item.editHistory || []).map((e: any) => ({
            timestamp: new Date(e.timestamp),
            content: e.content,
        })),
    };
}

export function createDiscordMessage(item: StoredShadowMessage): any {
    try {
        const raw = createRawDiscordMessage(item);
        if (typeof createMessageRecord === "function") {
            try {
                const rec = createMessageRecord(raw);
                if (rec) {
                    rec.deleted = true;
                    rec.deletedAt = item.deletedAt;
                    if (item.editHistory?.length) {
                        rec.editHistory = item.editHistory.map(e => ({
                            timestamp: new Date(e.timestamp),
                            content: e.content,
                        }));
                    }
                    return rec;
                }
            } catch (recErr) {
                console.error("[ShadowLogs] createMessageRecord failed for messageId:", item?.id, recErr);
            }
        }
        return raw;
    } catch (e) {
        console.error("[ShadowLogs] Error in createDiscordMessage for messageId:", item?.id, e);
        return item;
    }
}

export function rehydrateChannel(channelId: string): void {
    // Usunięto wywołania cache.receiveMessage - wiadomości są bezpiecznie wstrzykiwane jako surowy JSON w LOAD_MESSAGES_SUCCESS
}

const patchMessageContextMenu: NavContextMenuPatchCallback = (children, { message }: { message: ShadowMessage }) => {
    if (!message || !doesMessageHaveHistory(message)) return;

    const { deleted, id, channel_id } = message;

    if (deleted) {
        children.push(
            <Menu.MenuItem
                id="shadowlogs-toggle-highlight"
                key="shadowlogs-toggle-highlight"
                label="Toggle Deleted Highlight"
                leadingAccessory={{ type: "icon", icon: EyeIcon }}
                action={() => {
                    const el = document.getElementById("chat-messages-" + channel_id + "-" + id);
                    el?.classList.toggle("shadowlogs-deleted");
                }}
            />
        );
    }

    if (message.editHistory?.length) {
        children.push(
            <Menu.MenuItem
                id="shadowlogs-view-history"
                key="shadowlogs-view-history"
                label="View Edit History"
                leadingAccessory={{ type: "icon", icon: EyeIcon }}
                action={() => openHistoryModal(message)}
            />
        );
    }

    children.push(
        <Menu.MenuItem
            id="shadowlogs-remove-message"
            key="shadowlogs-remove-message"
            label="Remove from Shadow Logs"
            leadingAccessory={{ type: "icon", icon: DeleteIcon }}
            color="danger"
            action={async () => {
                await deleteSingleMessage(id);
                // Remove from in-memory cache
                if (inMemoryDeleted.has(channel_id)) {
                    inMemoryDeleted.set(channel_id, inMemoryDeleted.get(channel_id)!.filter(m => m.id !== id));
                }
                if (deleted) {
                    FluxDispatcher.dispatch({
                        type: "MESSAGE_DELETE",
                        channelId: channel_id,
                        id,
                        mlDeleted: true,
                    });
                } else {
                    const attachments = message.attachments?.filter((a: ShadowAttachment) => !a.deleted);
                    updateMessage(channel_id, id, { editHistory: [], attachments });
                }
                showToast("Message removed from Shadow Logs", "success");
            }}
        />
    );
};

const patchUserContextMenu: NavContextMenuPatchCallback = (children, { user }: { user: User }) => {
    if (!user) return;

    const blacklisted = settings.store.blacklistedUsers?.split(",").map(s => s.trim()).filter(Boolean) || [];
    const isIgnored = blacklisted.includes(user.id);

    children.push(
        <Menu.MenuGroup key="shadowlogs-user-group">
            <Menu.MenuItem
                id="shadowlogs-view-user-history"
                label="View Deleted Messages"
                action={() => {
                    openDeletedHistoryModal({
                        type: "user",
                        id: user.id,
                        name: user.globalName || user.username,
                        avatar: user.getAvatarURL?.(undefined, 80) || user.avatar
                    });
                }}
            />
            <Menu.MenuItem
                id="shadowlogs-toggle-ignore-user"
                label={isIgnored ? "Shadow Logs: Resume Logging User" : "Shadow Logs: Ignore User (Blacklist)"}
                action={() => {
                    let next = [...blacklisted];
                    if (isIgnored) {
                        next = next.filter(id => id !== user.id);
                        showToast("Shadow Logs: Logging resumed for " + user.username, "success");
                    } else {
                        next.push(user.id);
                        showToast("Shadow Logs: Ignored user " + user.username, "success");
                    }
                    settings.store.blacklistedUsers = next.join(", ");
                }}
            />
            <Menu.MenuItem
                id="shadowlogs-clear-user"
                label="Shadow Logs: Clear Logs for This User"
                color="danger"
                action={async () => {
                    const count = await deleteByAuthor(user.id);
                    // Clear in-memory
                    for (const [ch, list] of inMemoryDeleted.entries()) {
                        inMemoryDeleted.set(ch, list.filter(m => m.authorId !== user.id));
                    }
                    MessageStore.emitChange();
                    showToast("Cleared " + count.toLocaleString() + " stored message(s) for " + user.username, "success");
                }}
            />
        </Menu.MenuGroup>
    );
};

const patchGuildContextMenu: NavContextMenuPatchCallback = (children, { guild }: { guild: Guild }) => {
    if (!guild) return;

    const threshold = settings.store.memberThreshold || 500;
    const memberCount = (guild as any)?.memberCount ?? GuildMemberCountStore?.getMemberCount(guild.id) ?? 0;
    const isLarge = memberCount > threshold;

    const whitelisted = settings.store.whitelistedGuilds?.split(",").map(s => s.trim()).filter(Boolean) || [];
    const isWhitelisted = whitelisted.includes(guild.id);

    const blacklisted = settings.store.blacklistedGuilds?.split(",").map(s => s.trim()).filter(Boolean) || [];
    const isBlacklisted = blacklisted.includes(guild.id);

    children.push(
        <Menu.MenuGroup key="shadowlogs-guild-group">
            <Menu.MenuItem
                id="shadowlogs-view-guild-history"
                label="Server Deleted Logs"
                action={() => {
                    openDeletedHistoryModal({
                        type: "guild",
                        id: guild.id,
                        name: guild.name,
                        icon: (guild as any)?.getIconURL?.(80) || guild.icon
                    });
                }}
            />
            {isLarge ? (
                <Menu.MenuItem
                    id="shadowlogs-guild-whitelist"
                    label={
                        isWhitelisted
                            ? "Shadow Logs: Remove Whitelist (" + memberCount + " members)"
                            : "Shadow Logs: Whitelist Server (Force log, " + memberCount + " members)"
                    }
                    action={() => {
                        let next = [...whitelisted];
                        if (isWhitelisted) {
                            next = next.filter(id => id !== guild.id);
                            showToast("Shadow Logs: Whitelist removed for " + guild.name, "message");
                        } else {
                            next.push(guild.id);
                            showToast("Shadow Logs: Whitelisted " + guild.name + " (Forced logging)", "success");
                        }
                        settings.store.whitelistedGuilds = next.join(", ");
                    }}
                />
            ) : (
                <Menu.MenuItem
                    id="shadowlogs-guild-blacklist"
                    label={
                        isBlacklisted
                            ? "Shadow Logs: Resume Logging Server"
                            : "Shadow Logs: Ignore Server (" + memberCount + " members)"
                    }
                    action={() => {
                        let next = [...blacklisted];
                        if (isBlacklisted) {
                            next = next.filter(id => id !== guild.id);
                            showToast("Shadow Logs: Logging resumed for " + guild.name, "success");
                        } else {
                            next.push(guild.id);
                            showToast("Shadow Logs: Ignored server " + guild.name, "message");
                        }
                        settings.store.blacklistedGuilds = next.join(", ");
                    }}
                />
            )}

            <Menu.MenuItem
                id="shadowlogs-clear-guild"
                label="Shadow Logs: Clear Logs for This Server"
                color="danger"
                action={async () => {
                    const count = await deleteByGuild(guild.id);
                    for (const [ch, list] of inMemoryDeleted.entries()) {
                        inMemoryDeleted.set(ch, list.filter(m => m.guildId !== guild.id));
                    }
                    MessageStore.emitChange();
                    showToast("Cleared " + count.toLocaleString() + " stored message(s) for " + guild.name, "success");
                }}
            />
        </Menu.MenuGroup>
    );
};

const patchChannelContextMenu: NavContextMenuPatchCallback = (children, { channel }: { channel: Channel }) => {
    if (!channel) return;

    const blacklisted = settings.store.blacklistedChannels?.split(",").map(s => s.trim()).filter(Boolean) || [];
    const isIgnored = blacklisted.includes(channel.id);

    const group = findGroupChildrenByChildId("mark-channel-read", children) ?? children;
    group.push(
        <Menu.MenuItem
            id="shadowlogs-toggle-ignore-channel"
            key="shadowlogs-toggle-ignore-channel"
            label={isIgnored ? "Shadow Logs: Resume Logging Channel" : "Shadow Logs: Ignore Channel"}
            action={() => {
                let next = [...blacklisted];
                if (isIgnored) {
                    next = next.filter(id => id !== channel.id);
                    showToast("Shadow Logs: Channel logging resumed", "success");
                } else {
                    next.push(channel.id);
                    showToast("Shadow Logs: Channel ignored", "message");
                }
                settings.store.blacklistedChannels = next.join(", ");
            }}
        />,
        <Menu.MenuItem
            id="shadowlogs-clear-channel"
            key="shadowlogs-clear-channel"
            label="Shadow Logs: Clear Logs for This Channel"
            color="danger"
            action={async () => {
                const count = await deleteByChannel(channel.id);
                inMemoryDeleted.delete(channel.id);
                MessageStore.emitChange();
                showToast("Cleared " + count.toLocaleString() + " stored message(s) for this channel", "success");
            }}
        />
    );
};

let originalDispatch: any = null;
let dbReadyResolve: () => void = () => {};
let isDbReady = false;
let dbReadyPromise: Promise<void> = Promise.resolve();

export default definePlugin({
    name: "ShadowLogs",
    description: "Persistent message logger with IndexedDB storage, threshold filtering, and custom retention tools.",
    authors: [
        {
            name: "PAVELOS",
            id: 710126890798678059n,
        }
    ],
    settings,
    contextMenus: {
        "message": patchMessageContextMenu,
        "user-context": patchUserContextMenu,
        "guild-context": patchGuildContextMenu,
        "channel-context": patchChannelContextMenu,
        "thread-context": patchChannelContextMenu,
        "gdm-context": patchChannelContextMenu,
    },

    chatBarButton: {
        icon: ShadowLogsEnabledIcon,
        render: ShadowLogsChatBarButton,
    },

    start() {
        this.boundOnMessageCreate = this.onMessageCreate.bind(this);
        this.boundOnMessageUpdate = this.onMessageUpdate.bind(this);

        FluxDispatcher.subscribe("MESSAGE_CREATE", this.boundOnMessageCreate);
        FluxDispatcher.subscribe("MESSAGE_UPDATE", this.boundOnMessageUpdate);

        // Promise gotowości bazy danych do wyeliminowania wyścigu przy starcie
        isDbReady = false;
        dbReadyPromise = new Promise<void>(resolve => {
            dbReadyResolve = () => {
                isDbReady = true;
                resolve();
            };
        });

        // Preload all persistent deleted messages into fast in-memory map
        getAllDeleted().then(all => {
            inMemoryDeleted.clear();
            for (const item of all) {
                if (!inMemoryDeleted.has(item.channelId)) {
                    inMemoryDeleted.set(item.channelId, []);
                }
                inMemoryDeleted.get(item.channelId)!.push(item);
            }
            logger.info("Loaded " + all.length + " persistent deleted messages into cache.");
            dbReadyResolve();

            // Jeśli baza załadowała się po pierwotnym wywołaniu, bezpiecznie odśwież aktualny kanał przez Flux
            const currentChannelId = SelectedChannelStore.getChannelId();
            if (currentChannelId && inMemoryDeleted.has(currentChannelId)) {
                const channelDeleted = inMemoryDeleted.get(currentChannelId);
                if (channelDeleted && channelDeleted.length > 0) {
                    const msgs = MessageStore.getMessages(currentChannelId);
                    if (msgs && msgs._array && msgs._array.length > 0) {
                        let currentMaxId: bigint | null = null;
                        for (const m of msgs._array) {
                            if (m?.id) {
                                try {
                                    const bn = BigInt(m.id);
                                    if (currentMaxId === null || bn > currentMaxId) currentMaxId = bn;
                                } catch {}
                            }
                        }
                        const hasMissingAtEnd = currentMaxId !== null && channelDeleted.some(d => {
                            try {
                                return BigInt(d.id) > currentMaxId! && !msgs.has(d.id);
                            } catch {
                                return false;
                            }
                        });
                        if (hasMissingAtEnd) {
                            FluxDispatcher.dispatch({
                                type: "LOCAL_MESSAGES_LOADED",
                                channelId: currentChannelId,
                                messages: msgs._array.map((m: any) => m),
                                isPluginDbReady: true,
                            });
                        }
                    }
                }
            }

            MessageStore.emitChange();
        }).catch(err => {
            logger.error("Failed loading persistent logs:", err);
            dbReadyResolve();
        });

        const pluginSelf = this;

        // Intercept LOAD_MESSAGES_SUCCESS directly at Dispatcher level
        if (!originalDispatch && FluxDispatcher?.dispatch) {
            originalDispatch = FluxDispatcher.dispatch;
            FluxDispatcher.dispatch = function (action: any) {
                if (
                    action &&
                    (action.type === "LOAD_MESSAGES_SUCCESS" || action.type === "LOCAL_MESSAGES_LOADED") &&
                    action.channelId &&
                    Array.isArray(action.messages)
                ) {
                    const processAction = () => {
                        try {
                            const eventName = action.type;
                            const channelId = action.channelId;
                            const inputCount = action.messages.length;

                            // 1. Zaloguj klucze i wartości akcji dla każdego eventu
                            console.log(
                                `[ShadowLogs] ${eventName} flags: channelId=${channelId}, isBefore=${action.isBefore}, isAfter=${action.isAfter}, ` +
                                `hasMoreBefore=${action.hasMoreBefore}, hasMoreAfter=${action.hasMoreAfter}, jump=${typeof action.jump === "object" ? JSON.stringify(action.jump) : action.jump}, ` +
                                `limit=${action.limit}, truncate=${action.truncate}, ready=${action.ready}`
                            );

                            // Asynchroniczny batch zapis oryginalnych wiadomości z załadowanej partii do IndexedDB
                            if (!action.isPluginDbReady) {
                                const originalMsgs = action.messages.filter((m: any) => m && m.id && !m.deleted);
                                if (originalMsgs.length > 0) {
                                    const channel = ChannelStore.getChannel(channelId);
                                    const toBatchSave: StoredShadowMessage[] = [];

                                    for (const m of originalMsgs) {
                                        const reason = pluginSelf.getIgnoreReason(m);
                                        if (reason) {
                                            console.log(`[ShadowLogs] skipped ${m.id} reason: ${reason}`);
                                        } else {
                                            toBatchSave.push(toRawStoredMessage(m, channelId, m.guild_id || channel?.guild_id));
                                        }
                                    }

                                    if (toBatchSave.length > 0) {
                                        (async () => {
                                            try {
                                                const savedIds = await saveMessagesBatch(toBatchSave);
                                                const savedSet = new Set(savedIds);
                                                for (const item of toBatchSave) {
                                                    if (savedSet.has(item.id)) {
                                                        console.log(`[ShadowLogs] saved ${item.id} channel ${item.channelId} guild ${item.guildId || "DM"}`);
                                                    }
                                                }
                                            } catch (err) {
                                                console.error("[ShadowLogs] Error in batch save during LOAD_MESSAGES_SUCCESS:", err);
                                            }
                                        })();
                                    }
                                }
                            }

                            // 6. Sprawdzenie dla emitowanego przez plugin LOCAL_MESSAGES_LOADED (tylko aktualnie otwarty kanał)
                            if (action.isPluginDbReady && channelId !== SelectedChannelStore.getChannelId()) {
                                console.log(`[ShadowLogs] ${eventName} pominięto: isPluginDbReady dla nieaktywnego kanału ${channelId}`);
                                return;
                            }

                            // Analiza paginacji
                            const isBefore = !!(action.isBefore || (action as any).before);
                            const isAfter = !!(action.isAfter || (action as any).after);
                            const hasJumpTarget = !!(
                                (typeof action.jump === "object" && action.jump && (action.jump.messageId || action.jump.message_id)) ||
                                (typeof action.jump === "string" && action.jump) ||
                                (action as any).messageId ||
                                (action as any).message_id ||
                                action.around ||
                                (action as any).around
                            );
                            const hasMoreAfter = !!action.hasMoreAfter;
                            const hasMoreBefore = action.hasMoreBefore !== undefined ? !!action.hasMoreBefore : false;

                            // 2. Wstrzykuj wiadomości o id > maxId TYLKO gdy partia jest ładowaniem najnowszych wiadomości kanału
                            // (nie isBefore, nie isAfter, nie jump/around do konkretnego id w historii, i brak hasMoreAfter). Przy isBefore nigdy nie wstrzykuj nowszych niż maxId.
                            const reachesEnd = !isBefore && !isAfter && !hasJumpTarget && !hasMoreAfter;

                            // 3. Wstrzykuj wiadomości o id < minId TYLKO gdy partia sięga początku historii (brak hasMoreBefore) i nie jest to ładowanie isAfter.
                            const reachesStart = !hasMoreBefore && !isAfter && !hasJumpTarget;

                            const list = inMemoryDeleted.get(channelId) || [];
                            const channelDeletedCount = list.length;

                            let minId: bigint | null = null;
                            let maxId: bigint | null = null;
                            const existingIds = new Set<string>();

                            for (const m of action.messages) {
                                if (m?.id) {
                                    existingIds.add(String(m.id));
                                    try {
                                        const idBn = BigInt(m.id);
                                        if (minId === null || idBn < minId) minId = idBn;
                                        if (maxId === null || idBn > maxId) maxId = idBn;
                                    } catch {}
                                }
                            }

                            const toInject: { rawMessage: any; id: string; reason: string }[] = [];
                            const rejectedList: { id: string; reason: string }[] = [];

                            if (channelDeletedCount > 0) {
                                for (const item of list) {
                                    if (!item?.id) continue;
                                    if (existingIds.has(String(item.id))) {
                                        rejectedList.push({ id: item.id, reason: "Already present in action.messages" });
                                        continue;
                                    }

                                    let inRange = false;
                                    let injectReason = "";
                                    let rejectReason = "";

                                    if (minId === null || maxId === null) {
                                        // Obsługa pustej partii wiadomości
                                        if (reachesEnd) {
                                            inRange = true;
                                            injectReason = "reachesEnd";
                                        } else if (reachesStart) {
                                            inRange = true;
                                            injectReason = "reachesStart";
                                        } else {
                                            inRange = false;
                                            rejectReason = "Empty batch in pagination range";
                                        }
                                    } else {
                                        try {
                                            const itemBn = BigInt(item.id);
                                            const isBetween = itemBn >= minId && itemBn <= maxId;
                                            const isNewer = itemBn > maxId;
                                            const isOlder = itemBn < minId;

                                            if (action.isPluginDbReady) {
                                                // 6. Dla emitowanego przez plugin LOCAL_MESSAGES_LOADED: wstrzykuj tylko wiadomości, które powinny być na końcu aktualnie załadowanego okna; nie mieszaj w środek.
                                                if (isNewer && reachesEnd) {
                                                    inRange = true;
                                                    injectReason = "reachesEnd";
                                                } else {
                                                    inRange = false;
                                                    rejectReason = isBetween
                                                        ? "isPluginDbReady: odrzucono ze środka okna (zakaz mieszania w środek)"
                                                        : `isPluginDbReady: poza końcem okna [${minId}, ${maxId}]`;
                                                }
                                            } else {
                                                // 4. Standardowy przepływ:
                                                if (isBetween) {
                                                    inRange = true;
                                                    injectReason = "inRange";
                                                } else if (isNewer && reachesEnd) {
                                                    inRange = true;
                                                    injectReason = "reachesEnd";
                                                } else if (isOlder && reachesStart) {
                                                    inRange = true;
                                                    injectReason = "reachesStart";
                                                } else {
                                                    inRange = false;
                                                    if (isNewer) {
                                                        rejectReason = isBefore
                                                            ? `Newer than maxId (${item.id} > ${maxId}) during isBefore (przewijanie w górę)`
                                                            : `Newer than maxId (${item.id} > ${maxId}) and not newest batch`;
                                                    } else if (isOlder) {
                                                        rejectReason = `Older than minId (${item.id} < ${minId}) and reachesStart is false`;
                                                    } else {
                                                        rejectReason = `Outside range [${minId}, ${maxId}]`;
                                                    }
                                                }
                                            }
                                        } catch {
                                            inRange = false;
                                            rejectReason = "Invalid snowflake ID";
                                        }
                                    }

                                    if (inRange) {
                                        existingIds.add(String(item.id));
                                        toInject.push({
                                            rawMessage: createRawDiscordMessage(item),
                                            id: item.id,
                                            reason: injectReason,
                                        });
                                    } else {
                                        rejectedList.push({ id: item.id, reason: rejectReason });
                                    }
                                }

                                if (toInject.length > 0) {
                                    let firstId: bigint | null = null;
                                    let lastId: bigint | null = null;

                                    for (let i = 0; i < action.messages.length; i++) {
                                        if (action.messages[i]?.id) {
                                            try {
                                                firstId = BigInt(action.messages[i].id);
                                                break;
                                            } catch {}
                                        }
                                    }

                                    for (let i = action.messages.length - 1; i >= 0; i--) {
                                        if (action.messages[i]?.id) {
                                            try {
                                                const cur = BigInt(action.messages[i].id);
                                                if (firstId === null || cur !== firstId) {
                                                    lastId = cur;
                                                    break;
                                                }
                                            } catch {}
                                        }
                                    }

                                    const isAscending = firstId !== null && lastId !== null ? firstId < lastId : false;

                                    action.messages.push(...toInject.map(ti => ti.rawMessage));

                                    // 5. Sortuj ściśle po unikalnym Snowflake ID (BigInt) dopasowując się do naturalnego kierunku
                                    if (isAscending) {
                                        action.messages.sort((a: any, b: any) => {
                                            try {
                                                const idA = BigInt(a.id);
                                                const idB = BigInt(b.id);
                                                return idA < idB ? -1 : idA > idB ? 1 : 0;
                                            } catch {
                                                return 0;
                                            }
                                        });
                                    } else {
                                        action.messages.sort((a: any, b: any) => {
                                            try {
                                                const idA = BigInt(a.id);
                                                const idB = BigInt(b.id);
                                                return idA > idB ? -1 : idA < idB ? 1 : 0;
                                            } catch {
                                                return 0;
                                            }
                                        });
                                    }

                                    // 7. Dodaj log [ShadowLogs] dla każdej wstrzykniętej wiadomości: id, pozycja w tablicy po wstawieniu i powód wstrzyknięcia (inRange / reachesEnd / reachesStart)
                                    for (const item of toInject) {
                                        const pos = action.messages.findIndex((m: any) => String(m?.id) === String(item.id));
                                        console.log(`[ShadowLogs] wstrzyknięta wiadomość: id=${item.id}, pozycja=${pos}, powód=${item.reason}`);
                                    }
                                }
                            }

                            console.log(
                                `[ShadowLogs] ${eventName}: channelId=${channelId}, dbReady=${isDbReady}, ` +
                                `minId=${minId?.toString() ?? "none"}, maxId=${maxId?.toString() ?? "none"}, ` +
                                `hasMoreBefore=${hasMoreBefore}, hasMoreAfter=${hasMoreAfter}, ` +
                                `liczbaUsuniętychWBazie=${channelDeletedCount}, ` +
                                `wstrzyknięte=${toInject.length}, odrzucone=${rejectedList.length}`
                            );
                            if (rejectedList.length > 0) {
                                console.log(`[ShadowLogs] ${eventName} odrzucone z powodem:`, rejectedList);
                            }
                        } catch (e) {
                            console.error("[ShadowLogs] Error in FluxDispatcher.dispatch interceptor:", e);
                        }
                    };

                    if (!isDbReady) {
                        Promise.race([
                            dbReadyPromise,
                            new Promise<void>(res => setTimeout(res, 1000))
                        ]).then(() => {
                            processAction();
                            originalDispatch.call(FluxDispatcher, action);
                        }).catch(err => {
                            console.error("[ShadowLogs] Error waiting for dbReady in dispatch:", err);
                            originalDispatch.call(FluxDispatcher, action);
                        });
                        return;
                    }

                    processAction();
                    return originalDispatch.apply(this, arguments);
                }
                return originalDispatch.apply(this, arguments);
            };
        }

        logger.info("ShadowLogs initialized successfully.");
    },

    stop() {
        if (this.boundOnMessageCreate) FluxDispatcher.unsubscribe("MESSAGE_CREATE", this.boundOnMessageCreate);
        if (this.boundOnMessageUpdate) FluxDispatcher.unsubscribe("MESSAGE_UPDATE", this.boundOnMessageUpdate);

        if (originalDispatch) {
            FluxDispatcher.dispatch = originalDispatch;
            originalDispatch = null;
        }

        isDbReady = false;
        inMemoryDeleted.clear();
        logger.info("ShadowLogs stopped.");
    },

    boundOnMessageCreate: null as any,
    boundOnMessageUpdate: null as any,

    onMessageCreate(data: { message: any; channelId: string; }) {
        try {
            const msg = data?.message;
            if (!msg || !msg.id) return;

            const reason = this.getIgnoreReason(msg);
            if (reason) {
                console.log(`[ShadowLogs] skipped ${msg.id} reason: ${reason}`);
                return;
            }

            const chId = data.channelId || msg.channel_id;
            const channel = ChannelStore.getChannel(chId);
            const guildId = msg.guild_id || channel?.guild_id;

            (async () => {
                try {
                    const rawItem = toRawStoredMessage(msg, chId, guildId);
                    const saved = await saveNewMessage(rawItem);
                    if (saved) {
                        console.log(`[ShadowLogs] saved ${msg.id} channel ${chId} guild ${guildId || "DM"}`);
                    }
                } catch (err) {
                    console.error("[ShadowLogs] Error in onMessageCreate async save:", err);
                }
            })();
        } catch (e) {
            console.error("[ShadowLogs] Error in onMessageCreate:", e);
        }
    },

    onMessageUpdate(data: { message: any; }) {
        try {
            const msg = data.message;
            if (!msg || !msg.id || msg.content === undefined) return;
            const reason = this.getIgnoreReason(msg, true);
            if (reason) {
                console.log(`[ShadowLogs] skipped ${msg.id} reason: ${reason}`);
                return;
            }

            const oldMsg = MessageStore.getMessage(msg.channel_id, msg.id);
            if (oldMsg && oldMsg.content && oldMsg.content !== msg.content) {
                (async () => {
                    try {
                        await addEdit(msg.id, oldMsg.content, Date.now(), oldMsg, msg.content);
                    } catch (err) {
                        console.error("[ShadowLogs] Error updating edit in onMessageUpdate:", err);
                    }
                })();
            }
        } catch (e) {
            console.error("[ShadowLogs] Error in onMessageUpdate:", e);
        }
    },

    renderEdits: ErrorBoundary.wrap(({ message: { id: messageId, channel_id: channelId } }: { message: Message }) => {
        try {
            const message = useStateFromStores(
                [MessageStore],
                () => MessageStore.getMessage(channelId, messageId) as ShadowMessage,
                null,
                (oldMsg, newMsg) => oldMsg?.editHistory === newMsg?.editHistory && oldMsg?.deleted === newMsg?.deleted
            );

            if (!message) return null;

            return (
                <>
                    {message.deleted && (
                        <div style={{ marginBottom: "2px" }}>
                            <span
                                className="shadowlogs-deleted-badge"
                                title={message.deletedAt ? "Deleted at " + new Date(message.deletedAt).toLocaleString() : "Message was deleted"}
                            >
                                {"[Deleted" + (message.deletedAt ? ": " + new Date(message.deletedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "") + "]"}
                            </span>
                        </div>
                    )}
                    {settings.store.logEdits && message.editHistory?.map((edit, idx) => (
                        <div key={idx} className="shadowlogs-edited">
                            {parseEditContent(edit.content, message)}
                            <Timestamp
                                timestamp={edit.timestamp}
                                isEdited={true}
                                isInline={false}
                            >
                                <span className={MessageClasses.edited}> (edited)</span>
                            </Timestamp>
                        </div>
                    ))}
                </>
            );
        } catch (e) {
            console.error("[ShadowLogs] Error rendering edits in renderEdits:", e);
            return null;
        }
    }, { noop: true }),

    makeEdit(newMessage: any, oldMessage: any): any {
        return {
            timestamp: new Date(newMessage.edited_timestamp),
            content: oldMessage.content,
        };
    },

    handleUpdateAttachments(newMessage: ShadowMessage): ShadowAttachment[] {
        try {
            const oldMessage = MessageStore.getMessage(newMessage.channel_id, newMessage.id) as ShadowMessage | undefined;
            if (!oldMessage || this.shouldIgnore(newMessage, true)) {
                return newMessage.attachments || [];
            }
            if (!newMessage.attachments?.length) {
                return (oldMessage.attachments || []).map((a: ShadowAttachment) => ({ ...a, deleted: true }));
            }
            return (oldMessage.attachments || [])
                .map((oldAttachment: ShadowAttachment) =>
                    newMessage.attachments?.find((a: any) => a.id === oldAttachment.id) ?? { ...oldAttachment, deleted: true }
                )
                .concat((newMessage.attachments || []).filter((a: any) => !(oldMessage.attachments || []).some((o: any) => o.id === a.id)));
        } catch (e) {
            console.error("[ShadowLogs] Error in handleUpdateAttachments:", e);
            return newMessage?.attachments || [];
        }
    },

    handleDelete(cache: any, data: { ids: string[]; id: string; channelId?: string; mlDeleted?: boolean }, isBulk: boolean) {
        try {
            const targetIds = isBulk ? data.ids : [data.id];
            if (!targetIds || targetIds.length === 0) return cache;

            const now = Date.now();
            const chId = data.channelId || SelectedChannelStore.getChannelId();

            for (const id of targetIds) {
                if (!id) continue;
                const msg = cache?.get?.(id);
                const EPHEMERAL = 64;
                const shouldIgnore = data.mlDeleted || (msg && (msg.flags & EPHEMERAL) === EPHEMERAL) || (msg && this.shouldIgnore(msg));

                if (shouldIgnore) {
                    if (cache?.has?.(id)) cache = cache.remove(id);
                    continue;
                }

                if (cache?.has?.(id)) {
                    cache = cache.update(id, (m: any) =>
                        m
                            .set("deleted", true)
                            .set("deletedAt", now)
                            .set("attachments", (m.attachments || []).map((a: any) => ({ ...a, deleted: true })))
                    );
                }

                const fallbackMsg = msg;
                (async () => {
                    try {
                        const updated = await markDeleted(id, now, fallbackMsg);
                        if (updated) {
                            const targetChId = updated.channelId || chId;
                            if (!inMemoryDeleted.has(targetChId)) {
                                inMemoryDeleted.set(targetChId, []);
                            }
                            const list = inMemoryDeleted.get(targetChId)!;
                            const existingIdx = list.findIndex(m => m.id === id);
                            if (existingIdx >= 0) {
                                list[existingIdx] = updated;
                            } else {
                                list.push(updated);
                            }
                        }
                    } catch (err) {
                        console.error(`[ShadowLogs] Error marking deleted for message ${id}:`, err);
                    }
                })();
            }
        } catch (e) {
            console.error("[ShadowLogs] Error during handleDelete:", e);
        }
        return cache;
    },

    getIgnoreReason(message: any, isEdit = false): string | null {
        try {
            if (!message) return "No message object";
            const {
                ignoreBots,
                ignoreSelf,
                blacklistedUsers,
                blacklistedChannels,
                blacklistedGuilds,
                whitelistedGuilds,
                memberThreshold,
                logDeletes,
                logEdits,
            } = settings.store;

            if (isEdit && !logEdits) return "logEdits disabled";
            if (!isEdit && !logDeletes) return "logDeletes disabled";

            const myId = UserStore.getCurrentUser()?.id;
            if (ignoreSelf && message.author?.id === myId) return "Ignore self";
            if (ignoreBots && message.author?.bot) return "Bot user";

            const authorId = message.author?.id;
            if (authorId && blacklistedUsers) {
                const uList = blacklistedUsers.split(",").map(s => s.trim()).filter(Boolean);
                if (uList.includes(authorId)) return "User blacklisted";
            }

            const channelId = message.channel_id || message.channelId;
            if (channelId && blacklistedChannels) {
                const channel = ChannelStore.getChannel(channelId);
                const cList = blacklistedChannels.split(",").map(s => s.trim()).filter(Boolean);
                if (cList.includes(channelId)) return "Channel blacklisted";
                if (channel?.parent_id && cList.includes(channel.parent_id)) return "Parent channel blacklisted";
            }

            const channel = ChannelStore.getChannel(channelId);
            const guildId = message.guild_id || message.guildId || channel?.guild_id;
            if (guildId) {
                if (blacklistedGuilds) {
                    const bGuilds = blacklistedGuilds.split(",").map(s => s.trim()).filter(Boolean);
                    if (bGuilds.includes(guildId)) return "Guild blacklisted";
                }

                const wGuilds = whitelistedGuilds?.split(",").map(s => s.trim()).filter(Boolean) || [];
                if (!wGuilds.includes(guildId)) {
                    const guild = GuildStore.getGuild(guildId);
                    const count = (guild as any)?.memberCount ?? GuildMemberCountStore?.getMemberCount(guildId);
                    const threshold = memberThreshold || 500;
                    if (typeof count === "number" && count > 0 && count > threshold) {
                        return `Member threshold exceeded (${count} > ${threshold})`;
                    }
                }
            }

            return null;
        } catch {
            return null;
        }
    },

    shouldIgnore(message: any, isEdit = false): boolean {
        return this.getIgnoreReason(message, isEdit) !== null;
    },

    EditMarker({ message, className, children, ...props }: any) {
        return (
            <span
                {...props}
                className={classes("shadowlogs-edit-marker", className)}
                onClick={() => openHistoryModal(message)}
                role="button"
            >
                {children}
            </span>
        );
    },

    patches: [
        {
            find: '"MessageStore"',
            replacement: [
                {
                    match: /(?<=MESSAGE_DELETE:function\((\i)\)\{)(?=let.{0,100}(\i\.\i)\.getOrCreate)/,
                    replace: `
                        try {
                            console.log("[ShadowLogs] Patch MessageStore.MESSAGE_DELETE fired for messageId:", $1?.id, "channelId:", $1?.channelId);
                            let cache = $2.getOrCreate($1.channelId);
                            const countBefore = cache?._array?.length ?? cache?.length ?? 0;
                            cache = $self.handleDelete(cache, $1, false);
                            const countAfter = cache?._array?.length ?? cache?.length ?? 0;
                            console.log("[ShadowLogs] Patch MessageStore.MESSAGE_DELETE finished. countBefore:", countBefore, "countAfter:", countAfter);
                            $2.commit(cache);
                            return;
                        } catch (err) {
                            console.error("[ShadowLogs] Error in patched MessageStore.MESSAGE_DELETE:", err);
                        }
                    `,
                },
                {
                    match: /(?<=MESSAGE_DELETE_BULK:function\((\i)\){)(?=let.{0,100}(\i\.\i)\.getOrCreate)/,
                    replace: `
                        try {
                            console.log("[ShadowLogs] Patch MessageStore.MESSAGE_DELETE_BULK fired for IDs count:", $1?.ids?.length, "channelId:", $1?.channelId);
                            let cache = $2.getOrCreate($1.channelId);
                            const countBefore = cache?._array?.length ?? cache?.length ?? 0;
                            cache = $self.handleDelete(cache, $1, true);
                            const countAfter = cache?._array?.length ?? cache?.length ?? 0;
                            console.log("[ShadowLogs] Patch MessageStore.MESSAGE_DELETE_BULK finished. countBefore:", countBefore, "countAfter:", countAfter);
                            $2.commit(cache);
                            return;
                        } catch (err) {
                            console.error("[ShadowLogs] Error in patched MessageStore.MESSAGE_DELETE_BULK:", err);
                        }
                    `,
                },
                {
                    match: /(MESSAGE_UPDATE:function\((\i)\).+?)\.update\((\i)/,
                    replace: `
                        $1
                        .update($3, m => {
                            try {
                                if (!m) return m;
                                if (($2.message.flags & 64) === 64 || $self.shouldIgnore($2.message, true)) return m;
                                if ($2.message.edited_timestamp && $2.message.content !== m.content) {
                                    console.log("[ShadowLogs] Patch MessageStore.MESSAGE_UPDATE edit recorded for messageId:", m.id);
                                    return m.set('editHistory', [...(m.editHistory || []), $self.makeEdit($2.message, m)]);
                                }
                                return m;
                            } catch (err) {
                                console.error("[ShadowLogs] Error in patched MessageStore.MESSAGE_UPDATE updater:", err);
                                return m;
                            }
                        })
                        .update($3
                    `,
                },
                {
                    match: /(?<=getLastEditableMessage\(\i\)\{.{0,200}\.find\((\i)=>)/,
                    replace: "!$1.deleted &&",
                },
            ],
        },

        {
            find: "}addReaction(",
            replacement: [
                {
                    match: /this\.customRenderedContent=(\i)\.customRenderedContent,/,
                    replace:
                        "this.customRenderedContent = $1.customRenderedContent," +
                        "this.deleted = $1.deleted || false," +
                        "this.deletedAt = $1.deletedAt || null," +
                        "this.editHistory = $1.editHistory || []," +
                        "this.firstEditTimestamp = $1.firstEditTimestamp || this.editedTimestamp || this.timestamp,",
                },
            ],
        },

        {
            find: ".PREMIUM_REFERRAL&&(",
            replacement: [
                {
                    match: /(?<=null!=\i\.edited_timestamp\)return )\i\(\i,\{reactions:(\i)\.reactions.{0,50}\}\)/,
                    replace:
                        "Object.assign($&,{ deleted:$1.deleted, deletedAt:$1.deletedAt, editHistory:$1.editHistory, firstEditTimestamp:$1.firstEditTimestamp })",
                },
                {
                    match: /attachments:(\i)\.attachments\?\?\[\],/,
                    predicate: () => settings.store.logDeletedAttachments,
                    replace: "attachments: $self.handleUpdateAttachments($1),",
                },
            ],
        },

        {
            find: "#{intl::REMOVE_ATTACHMENT_TOOLTIP_TEXT}",
            replacement: [
                {
                    match: /\.SPOILER,(?=\[\i\.\i\]:)(?<=item:(\i),.{0,200}?)/,
                    replace: '$&"shadowlogs-deleted-attachment": $1?.originalItem?.deleted,',
                },
                {
                    match: /(?<=\{let\{[^}]*?item:(\i),autoPlayGif:\i,)canRemoveItem:(\i)(?=,onRemoveItem:)/,
                    replace: "_canRemoveItem:$2 = arguments[0].canRemoveItem && !$1?.originalItem?.deleted",
                },
            ],
        },

        {
            find: "Message must not be a thread starter message",
            replacement: [
                {
                    match: /\)\("li",\{(.+?),className:/,
                    replace: ')("li",{$1,className:(arguments[0]?.message?.deleted ? "shadowlogs-deleted " : "")+',
                },
            ],
        },

        {
            find: ".SEND_FAILED,",
            replacement: {
                match: /\]:\i.isUnsupported.{0,20}?,children:\[/,
                replace:
                    "$&(arguments[0]?.message?.editHistory?.length>0||arguments[0]?.message?.deleted)&&$self.renderEdits(arguments[0]),",
            },
        },

        {
            find: "#{intl::MESSAGE_EDITED}",
            replacement: {
                match: /(isInline:!1,children:.{0,50}?)"span",\{(?=className:)/,
                replace: "$1$self.EditMarker,{message:arguments[0].message,",
            },
        },

        {
            find: '"ReferencedMessageStore"',
            replacement: [
                {
                    match: /(?<=MESSAGE_DELETE:function\(\i\)\{)/,
                    replace: `
                        try {
                            console.log("[ShadowLogs] Patch ReferencedMessageStore.MESSAGE_DELETE intercepted for messageId:", arguments[0]?.id);
                            return;
                        } catch (err) {
                            console.error("[ShadowLogs] Error in ReferencedMessageStore.MESSAGE_DELETE patch:", err);
                        }
                    `,
                },
                {
                    match: /(?<=MESSAGE_DELETE_BULK:function\(\i\)\{)/,
                    replace: `
                        try {
                            console.log("[ShadowLogs] Patch ReferencedMessageStore.MESSAGE_DELETE_BULK intercepted for IDs count:", arguments[0]?.ids?.length);
                            return;
                        } catch (err) {
                            console.error("[ShadowLogs] Error in ReferencedMessageStore.MESSAGE_DELETE_BULK patch:", err);
                        }
                    `,
                },
            ],
        },
    ],
});
