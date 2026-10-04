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
    toEpoch
} from "./db";
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
        const memberCount = guild?.memberCount ?? GuildMemberCountStore?.getMemberCount(channel.guild_id) ?? 0;
        return memberCount <= (memberThreshold || 500);
    } else {
        const bChannels = blacklistedChannels?.split(",").map(s => s.trim()).filter(Boolean) || [];
        return !bChannels.includes(channel.id);
    }
}

function ShadowLogsEnabledIcon({ height = 20, width = 20 }: { height?: number; width?: number }) {
    return (
        <svg width={width} height={height} viewBox="0 0 24 24" style={{ scale: "1.1" }}>
            <path
                fill="currentColor"
                d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z"
            />
        </svg>
    );
}

function ShadowLogsDisabledIcon({ height = 20, width = 20 }: { height?: number; width?: number }) {
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
            const memberCount = guild?.memberCount ?? GuildMemberCountStore?.getMemberCount(guildId) ?? 0;
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
        timestamp: new Date(item.timestamp).toISOString(),
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
        } catch {
            // fallback to raw
        }
    }
    return raw;
}

export function rehydrateChannel(channelId: string): void {
    if (!channelId || !inMemoryDeleted.has(channelId)) return;
    const list = inMemoryDeleted.get(channelId);
    if (!list || list.length === 0) return;

    try {
        let cache = MessageCache.getOrCreate(channelId);
        if (!cache || typeof cache.receiveMessage !== "function") return;

        let changed = false;
        for (const item of list) {
            if (!cache.has(item.id)) {
                try {
                    const msg = createDiscordMessage(item);
                    cache = cache.receiveMessage(msg);
                    changed = true;
                } catch (err) {
                    logger.error("Error receiving message in rehydrateChannel:", item.id, err);
                }
            }
        }

        if (changed) {
            MessageCache.commit(cache);
            MessageStore.emitChange();
        }
    } catch (e) {
        logger.error("Error rehydrating channel:", channelId, e);
    }
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
    const memberCount = guild.memberCount ?? GuildMemberCountStore?.getMemberCount(guild.id) ?? 0;
    const isLarge = memberCount > threshold;

    const whitelisted = settings.store.whitelistedGuilds?.split(",").map(s => s.trim()).filter(Boolean) || [];
    const isWhitelisted = whitelisted.includes(guild.id);

    const blacklisted = settings.store.blacklistedGuilds?.split(",").map(s => s.trim()).filter(Boolean) || [];
    const isBlacklisted = blacklisted.includes(guild.id);

    children.push(
        <Menu.MenuGroup key="shadowlogs-guild-group">
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
let originalGetMessages: any = null;

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
        this.boundOnChannelSelect = ({ channelId }: { channelId: string }) => {
            if (channelId) {
                setTimeout(() => rehydrateChannel(channelId), 30);
            }
        };

        FluxDispatcher.subscribe("MESSAGE_CREATE", this.boundOnMessageCreate);
        FluxDispatcher.subscribe("MESSAGE_UPDATE", this.boundOnMessageUpdate);
        FluxDispatcher.subscribe("CHANNEL_SELECT", this.boundOnChannelSelect);

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

            const currentChannelId = SelectedChannelStore.getChannelId();
            if (currentChannelId) {
                rehydrateChannel(currentChannelId);
            }
            MessageStore.emitChange();
        }).catch(err => {
            logger.error("Failed loading persistent logs:", err);
        });

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
                    try {
                        const channelId = action.channelId;
                        if (inMemoryDeleted.has(channelId)) {
                            const list = inMemoryDeleted.get(channelId);
                            if (list && list.length > 0) {
                                for (const item of list) {
                                    if (!action.messages.some((m: any) => m.id === item.id)) {
                                        action.messages.push(createDiscordMessage(item));
                                    }
                                }
                                action.messages.sort((a: any, b: any) => toEpoch(a.timestamp) - toEpoch(b.timestamp));
                            }
                        }
                    } catch (e) {
                        logger.error("Error splicing deleted messages into LOAD_MESSAGES_SUCCESS:", e);
                    }
                }
                return originalDispatch.apply(this, arguments);
            };
        }

        // Safety fallback: Patch MessageStore.getMessages to inject deleted messages if missed
        if (!originalGetMessages && MessageStore?.getMessages) {
            originalGetMessages = MessageStore.getMessages;
            MessageStore.getMessages = function (channelId: string) {
                let res = originalGetMessages.apply(this, arguments);
                if (res && channelId && typeof res.receiveMessage === "function" && inMemoryDeleted.has(channelId)) {
                    const list = inMemoryDeleted.get(channelId);
                    if (list && list.length > 0) {
                        let changed = false;
                        for (const item of list) {
                            if (!res.has(item.id)) {
                                try {
                                    const msg = createDiscordMessage(item);
                                    res = res.receiveMessage(msg);
                                    changed = true;
                                } catch (e) {
                                    // ignore
                                }
                            }
                        }
                        if (changed) {
                            MessageCache.commit(res);
                        }
                    }
                }
                return res;
            };
        }

        logger.info("ShadowLogs initialized successfully.");
    },

    stop() {
        if (this.boundOnMessageCreate) FluxDispatcher.unsubscribe("MESSAGE_CREATE", this.boundOnMessageCreate);
        if (this.boundOnMessageUpdate) FluxDispatcher.unsubscribe("MESSAGE_UPDATE", this.boundOnMessageUpdate);
        if (this.boundOnChannelSelect) FluxDispatcher.unsubscribe("CHANNEL_SELECT", this.boundOnChannelSelect);

        if (originalDispatch) {
            FluxDispatcher.dispatch = originalDispatch;
            originalDispatch = null;
        }

        if (originalGetMessages) {
            MessageStore.getMessages = originalGetMessages;
            originalGetMessages = null;
        }

        inMemoryDeleted.clear();
        logger.info("ShadowLogs stopped.");
    },

    boundOnMessageCreate: null as any,
    boundOnMessageUpdate: null as any,
    boundOnChannelSelect: null as any,

    onMessageCreate(data: { message: any; channelId: string; }) {
        // We only persist messages when they are deleted or edited, preventing unnecessary disk bloat
    },

    onMessageUpdate(data: { message: any; }) {
        try {
            const msg = data.message;
            if (!msg || !msg.id || msg.content === undefined) return;
            if (this.shouldIgnore(msg, true)) return;

            const oldMsg = MessageStore.getMessage(msg.channel_id, msg.id);
            if (oldMsg && oldMsg.content && oldMsg.content !== msg.content) {
                addEdit(msg.id, oldMsg.content, Date.now()).catch(() => {});
            }
        } catch (e) {
            logger.error("Error in onMessageUpdate:", e);
        }
    },

    renderEdits: ErrorBoundary.wrap(({ message: { id: messageId, channel_id: channelId } }: { message: Message }) => {
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
    }, { noop: true }),

    makeEdit(newMessage: any, oldMessage: any): any {
        return {
            timestamp: new Date(newMessage.edited_timestamp),
            content: oldMessage.content,
        };
    },

    handleUpdateAttachments(newMessage: ShadowMessage): ShadowAttachment[] {
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
    },

    handleDelete(cache: any, data: { ids: string[]; id: string; channelId?: string; mlDeleted?: boolean }, isBulk: boolean) {
        try {
            if (cache == null || (!isBulk && !cache.has(data.id))) return cache;

            const mutate = (id: string) => {
                const msg = cache.get(id);
                if (!msg) return;

                const EPHEMERAL = 64;
                const shouldIgnore = data.mlDeleted || (msg.flags & EPHEMERAL) === EPHEMERAL || this.shouldIgnore(msg);

                if (shouldIgnore) {
                    cache = cache.remove(id);
                } else {
                    const now = Date.now();
                    cache = cache.update(id, (m: any) =>
                        m
                            .set("deleted", true)
                            .set("deletedAt", now)
                            .set("attachments", (m.attachments || []).map((a: any) => ({ ...a, deleted: true })))
                    );

                    const chId = msg.channel_id || data.channelId || SelectedChannelStore.getChannelId();
                    const author = msg.author || {};
                    const storedItem: StoredShadowMessage = {
                        id: msg.id,
                        channelId: chId,
                        guildId: msg.guild_id || ChannelStore.getChannel(chId)?.guild_id,
                        authorId: author.id ?? "",
                        authorName: author.global_name || author.username || "User",
                        authorAvatar: author.avatar,
                        content: msg.content ?? "",
                        timestamp: toEpoch(msg.timestamp),
                        deleted: true,
                        deletedAt: now,
                        attachments: msg.attachments?.map((a: any) => ({
                            id: a.id,
                            url: a.url,
                            proxy_url: a.proxy_url,
                            filename: a.filename,
                            size: a.size,
                            content_type: a.content_type,
                            deleted: true,
                        })),
                        editHistory: msg.editHistory?.map((e: any) => ({
                            timestamp: toEpoch(e.timestamp),
                            content: e.content,
                        })),
                    };

                    if (!inMemoryDeleted.has(chId)) {
                        inMemoryDeleted.set(chId, []);
                    }
                    const list = inMemoryDeleted.get(chId)!;
                    const existingIdx = list.findIndex(m => m.id === msg.id);
                    if (existingIdx >= 0) {
                        list[existingIdx] = storedItem;
                    } else {
                        list.push(storedItem);
                    }

                    // Save directly to persistent DataStore
                    saveDeletedMessage(storedItem).catch(err => {
                        logger.error("Failed to persist deleted message:", err);
                    });
                }
            };

            if (isBulk) {
                data.ids.forEach(mutate);
            } else {
                mutate(data.id);
            }
        } catch (e) {
            logger.error("Error during handleDelete:", e);
        }
        return cache;
    },

    shouldIgnore(message: any, isEdit = false): boolean {
        try {
            if (!message) return false;
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

            if (isEdit ? !logEdits : !logDeletes) return true;

            const myId = UserStore.getCurrentUser()?.id;
            if (ignoreSelf && message.author?.id === myId) return true;
            if (ignoreBots && message.author?.bot) return true;

            const authorId = message.author?.id;
            if (authorId && blacklistedUsers) {
                const uList = blacklistedUsers.split(",").map(s => s.trim()).filter(Boolean);
                if (uList.includes(authorId)) return true;
            }

            const channelId = message.channel_id;
            if (channelId && blacklistedChannels) {
                const channel = ChannelStore.getChannel(channelId);
                const cList = blacklistedChannels.split(",").map(s => s.trim()).filter(Boolean);
                if (cList.includes(channelId)) return true;
                if (channel?.parent_id && cList.includes(channel.parent_id)) return true;
            }

            const channel = ChannelStore.getChannel(message.channel_id);
            const guildId = channel?.guild_id;
            if (guildId) {
                if (blacklistedGuilds) {
                    const bGuilds = blacklistedGuilds.split(",").map(s => s.trim()).filter(Boolean);
                    if (bGuilds.includes(guildId)) return true;
                }

                const wGuilds = whitelistedGuilds?.split(",").map(s => s.trim()).filter(Boolean) || [];
                if (!wGuilds.includes(guildId)) {
                    const guild = GuildStore.getGuild(guildId);
                    const memberCount = guild?.memberCount ?? GuildMemberCountStore?.getMemberCount(guildId) ?? 0;
                    if (memberCount > (memberThreshold || 500)) {
                        return true;
                    }
                }
            }

            return false;
        } catch (e) {
            return false;
        }
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
                        let cache = $2.getOrCreate($1.channelId);
                        cache = $self.handleDelete(cache, $1, false);
                        $2.commit(cache);
                        return;
                    `,
                },
                {
                    match: /(?<=MESSAGE_DELETE_BULK:function\((\i)\){)(?=let.{0,100}(\i\.\i)\.getOrCreate)/,
                    replace: `
                        let cache = $2.getOrCreate($1.channelId);
                        cache = $self.handleDelete(cache, $1, true);
                        $2.commit(cache);
                        return;
                    `,
                },
                {
                    match: /(MESSAGE_UPDATE:function\((\i)\).+?)\.update\((\i)/,
                    replace: `
                        $1
                        .update($3, m =>
                            (($2.message.flags & 64) === 64 || $self.shouldIgnore($2.message, true)) ? m :
                            $2.message.edited_timestamp && $2.message.content !== m.content ?
                                m.set('editHistory',[...(m.editHistory || []), $self.makeEdit($2.message, m)]) :
                                m
                        )
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
                    replace: "return;",
                },
                {
                    match: /(?<=MESSAGE_DELETE_BULK:function\(\i\)\{)/,
                    replace: "return;",
                },
            ],
        },
    ],
});
