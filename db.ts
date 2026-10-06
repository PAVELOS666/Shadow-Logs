/*
 * Shadow Logs - Persistent Message Logger for Vencord
 * Database Layer using Vencord Native DataStore API
 */

import * as DataStore from "@api/DataStore";

import { DBStats, StoredShadowMessage } from "./types";

const shadowStore = DataStore.createStore("ShadowLogsDataStore", "shadowMessages");

export function toEpoch(ts: any, snowflakeIdFallback?: string): number {
    if (ts) {
        if (typeof ts === "number" && !isNaN(ts)) return ts;
        if (typeof ts.toDate === "function") {
            const d = ts.toDate();
            if (d instanceof Date && !isNaN(d.getTime())) return d.getTime();
        }
        if (typeof ts.valueOf === "function") {
            const v = ts.valueOf();
            if (typeof v === "number" && !isNaN(v)) return v;
        }
        const parsed = new Date(ts).getTime();
        if (!isNaN(parsed)) return parsed;
    }

    if (snowflakeIdFallback) {
        try {
            const sf = Number((BigInt(snowflakeIdFallback) >> 22n) + 1420070400000n);
            if (!isNaN(sf) && sf > 1420070400000) return sf;
        } catch {}
    }

    return Date.now();
}


export function toRawStoredMessage(msg: any, channelId?: string, guildId?: string): StoredShadowMessage {
    const chId = String(msg.channel_id || msg.channelId || channelId || "");
    const gId = msg.guild_id || msg.guildId || guildId;
    const author = msg.author || {};
    const authorId = String(author.id || "");
    const authorName = author.global_name || author.username || "User";
    const authorAvatar = author.avatar;

    return {
        id: String(msg.id),
        channel_id: chId,
        guild_id: gId ? String(gId) : undefined,
        channelId: chId,
        guildId: gId ? String(gId) : undefined,
        author: {
            id: authorId,
            username: author.username || "User",
            avatar: authorAvatar,
            global_name: author.global_name,
            discriminator: author.discriminator || "0",
            bot: !!author.bot,
        },
        authorId,
        authorName,
        authorAvatar,
        content: String(msg.content ?? ""),
        timestamp: toEpoch(msg.timestamp, msg.id),
        deleted: false,
        deletedAt: undefined,
        editHistory: [],
        attachments: (msg.attachments || []).map((a: any) => ({
            id: String(a.id),
            url: String(a.url),
            proxy_url: a.proxy_url ? String(a.proxy_url) : undefined,
            filename: String(a.filename || "file"),
            size: typeof a.size === "number" ? a.size : 0,
            content_type: a.content_type,
            deleted: false,
        })),
        embeds: Array.isArray(msg.embeds) ? msg.embeds : [],
        message_reference: msg.message_reference ? { ...msg.message_reference } : undefined,
        sticker_items: Array.isArray(msg.sticker_items) ? msg.sticker_items : [],
    };
}

export async function saveNewMessage(msg: StoredShadowMessage): Promise<boolean> {
    try {
        const existing = await DataStore.get<StoredShadowMessage>(msg.id, shadowStore);
        if (existing) {
            return false;
        }
        await DataStore.set(msg.id, msg, shadowStore);
        return true;
    } catch (e) {
        console.error("[ShadowLogs] Error saving new message:", e);
        return false;
    }
}

export async function saveMessagesBatch(msgs: StoredShadowMessage[]): Promise<string[]> {
    try {
        if (!msgs || msgs.length === 0) return [];
        const keys = msgs.map(m => m.id);
        const existingList = await DataStore.getMany<StoredShadowMessage>(keys, shadowStore);
        const existingSet = new Set<string>();
        for (let i = 0; i < keys.length; i++) {
            if (existingList[i]) {
                existingSet.add(keys[i]);
            }
        }

        const toPutEntries: [IDBValidKey, StoredShadowMessage][] = [];
        const savedIds: string[] = [];
        for (const msg of msgs) {
            if (!existingSet.has(msg.id)) {
                toPutEntries.push([msg.id, msg]);
                savedIds.push(msg.id);
            }
        }

        if (toPutEntries.length > 0) {
            await DataStore.setMany(toPutEntries, shadowStore);
        }
        return savedIds;
    } catch (e) {
        console.error("[ShadowLogs] Error in saveMessagesBatch:", e);
        return [];
    }
}

export async function saveDeletedMessage(msg: StoredShadowMessage): Promise<void> {
    try {
        const raw = toRawStoredMessage(msg);
        raw.deleted = true;
        raw.deletedAt = toEpoch(msg.deletedAt || Date.now());
        if (raw.attachments) {
            raw.attachments.forEach(a => (a.deleted = true));
        }
        if (msg.editHistory) {
            raw.editHistory = msg.editHistory.map((e: any) => ({
                timestamp: toEpoch(e.timestamp),
                content: String(e.content ?? ""),
            }));
        }
        await DataStore.set(raw.id, raw, shadowStore);
    } catch (e) {
        console.error("[ShadowLogs] Error saving deleted message:", e);
    }
}

export const saveMessage = saveDeletedMessage;

export async function getMessage(id: string): Promise<StoredShadowMessage | undefined> {
    try {
        return await DataStore.get<StoredShadowMessage>(id, shadowStore);
    } catch (e) {
        console.error("[ShadowLogs] Error getting message:", e);
        return undefined;
    }
}

export async function markDeleted(
    id: string,
    deletedAt = Date.now(),
    fallbackMsg?: any
): Promise<StoredShadowMessage | null> {
    try {
        let existing = await DataStore.get<StoredShadowMessage>(id, shadowStore);
        if (existing) {
            existing.deleted = true;
            existing.deletedAt = toEpoch(deletedAt);
            if (existing.attachments) {
                existing.attachments.forEach(a => (a.deleted = true));
            }
            await DataStore.set(id, existing, shadowStore);
            return existing;
        } else if (fallbackMsg) {
            console.log(`[ShadowLogs] MESSAGE_DELETE: message ${id} not found in IndexedDB, using Discord cache fallback`);
            const stored = toRawStoredMessage(fallbackMsg);
            stored.deleted = true;
            stored.deletedAt = toEpoch(deletedAt);
            if (stored.attachments) {
                stored.attachments.forEach(a => (a.deleted = true));
            }
            await DataStore.set(id, stored, shadowStore);
            return stored;
        } else {
            console.log(`[ShadowLogs] MESSAGE_DELETE: message ${id} not found in IndexedDB nor in fallback`);
            return null;
        }
    } catch (e) {
        console.error("[ShadowLogs] Error marking deleted:", e);
        return null;
    }
}

export async function addEdit(
    id: string,
    oldContent: string,
    timestamp: number,
    fallbackMsg?: any,
    newContent?: string
): Promise<void> {
    try {
        let existing = await DataStore.get<StoredShadowMessage>(id, shadowStore);
        if (!existing && fallbackMsg) {
            existing = toRawStoredMessage(fallbackMsg);
        }
        if (!existing) return;

        if (!existing.editHistory) existing.editHistory = [];
        const last = existing.editHistory[existing.editHistory.length - 1];
        if (!last || last.content !== oldContent) {
            existing.editHistory.push({ timestamp: toEpoch(timestamp), content: oldContent });
        }
        if (newContent !== undefined) {
            existing.content = String(newContent);
        }
        await DataStore.set(id, existing, shadowStore);
    } catch (e) {
        console.error("[ShadowLogs] Error adding edit:", e);
    }
}

export async function getAllDeleted(): Promise<StoredShadowMessage[]> {
    try {
        const all = await DataStore.values<StoredShadowMessage>(shadowStore);
        if (!all || !Array.isArray(all)) return [];
        return all
            .filter(m => m && m.id && m.deleted)
            .sort((a, b) => toEpoch(b.deletedAt || b.timestamp) - toEpoch(a.deletedAt || a.timestamp));
    } catch (e) {
        console.error("[ShadowLogs] Error fetching all deleted:", e);
        return [];
    }
}

export async function getDeletedMessagesForChannel(channelId: string): Promise<StoredShadowMessage[]> {
    try {
        const all = await getAllDeleted();
        return all
            .filter(m => m.channelId === channelId)
            .sort((a, b) => toEpoch(b.deletedAt || b.timestamp) - toEpoch(a.deletedAt || a.timestamp));
    } catch (e) {
        console.error("[ShadowLogs] Error fetching deleted messages for channel:", e);
        return [];
    }
}

export async function getDeletedMessagesForAuthor(authorId: string): Promise<StoredShadowMessage[]> {
    try {
        const all = await getAllDeleted();
        return all
            .filter(m => m.authorId === authorId)
            .sort((a, b) => toEpoch(b.deletedAt || b.timestamp) - toEpoch(a.deletedAt || a.timestamp));
    } catch (e) {
        console.error("[ShadowLogs] Error fetching deleted messages for author:", e);
        return [];
    }
}

export async function getDeletedMessagesForGuild(guildId: string): Promise<StoredShadowMessage[]> {
    try {
        const all = await getAllDeleted();
        return all
            .filter(m => m.guildId === guildId)
            .sort((a, b) => toEpoch(b.deletedAt || b.timestamp) - toEpoch(a.deletedAt || a.timestamp));
    } catch (e) {
        console.error("[ShadowLogs] Error fetching deleted messages for guild:", e);
        return [];
    }
}

export async function pruneOlderThan(cutoffEpochMs: number): Promise<number> {
    try {
        const allEntries = await DataStore.entries<string, StoredShadowMessage>(shadowStore);
        const toDelete: string[] = [];
        for (const [id, msg] of allEntries) {
            if (msg && toEpoch(msg.timestamp) < cutoffEpochMs) {
                toDelete.push(id);
            }
        }
        if (toDelete.length > 0) {
            await DataStore.delMany(toDelete, shadowStore);
        }
        return toDelete.length;
    } catch (e) {
        console.error("[ShadowLogs] Error pruning messages:", e);
        return 0;
    }
}

export async function deleteByAuthor(authorId: string): Promise<number> {
    try {
        const allEntries = await DataStore.entries<string, StoredShadowMessage>(shadowStore);
        const toDelete = allEntries
            .filter(([_, msg]) => msg && msg.authorId === authorId)
            .map(([id]) => id);
        if (toDelete.length > 0) {
            await DataStore.delMany(toDelete, shadowStore);
        }
        return toDelete.length;
    } catch (e) {
        console.error("[ShadowLogs] Error deleting by author:", e);
        return 0;
    }
}

export async function deleteByGuild(guildId: string): Promise<number> {
    try {
        const allEntries = await DataStore.entries<string, StoredShadowMessage>(shadowStore);
        const toDelete = allEntries
            .filter(([_, msg]) => msg && msg.guildId === guildId)
            .map(([id]) => id);
        if (toDelete.length > 0) {
            await DataStore.delMany(toDelete, shadowStore);
        }
        return toDelete.length;
    } catch (e) {
        console.error("[ShadowLogs] Error deleting by guild:", e);
        return 0;
    }
}

export async function deleteByChannel(channelId: string): Promise<number> {
    try {
        const allEntries = await DataStore.entries<string, StoredShadowMessage>(shadowStore);
        const toDelete = allEntries
            .filter(([_, msg]) => msg && msg.channelId === channelId)
            .map(([id]) => id);
        if (toDelete.length > 0) {
            await DataStore.delMany(toDelete, shadowStore);
        }
        return toDelete.length;
    } catch (e) {
        console.error("[ShadowLogs] Error deleting by channel:", e);
        return 0;
    }
}

export async function deleteSingleMessage(id: string): Promise<void> {
    try {
        await DataStore.del(id, shadowStore);
    } catch (e) {
        console.error("[ShadowLogs] Error deleting message:", e);
    }
}

export async function clearAll(): Promise<void> {
    try {
        await DataStore.clear(shadowStore);
    } catch (e) {
        console.error("[ShadowLogs] Error clearing store:", e);
    }
}

export async function getStats(): Promise<DBStats> {
    try {
        const all = await DataStore.values<StoredShadowMessage>(shadowStore);
        const count = all ? all.length : 0;
        const deletedCount = all ? all.filter(m => m && m.deleted).length : 0;
        const editedCount = all ? all.filter(m => m && !m.deleted && (m.editHistory?.length || 0) > 0).length : 0;
        const json = JSON.stringify(all || []);
        const estimatedSizeBytes = json.length * 2;
        return {
            count,
            deletedCount,
            editedCount,
            estimatedSizeBytes,
        };
    } catch (e) {
        console.error("[ShadowLogs] Error getting stats:", e);
        return { count: 0, deletedCount: 0, editedCount: 0, estimatedSizeBytes: 0 };
    }
}

export async function exportAll(): Promise<string> {
    try {
        const all = await DataStore.values<StoredShadowMessage>(shadowStore);
        return JSON.stringify(all || [], null, 2);
    } catch (e) {
        console.error("[ShadowLogs] Error exporting:", e);
        return "[]";
    }
}
