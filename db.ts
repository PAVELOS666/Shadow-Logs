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

export async function saveDeletedMessage(msg: StoredShadowMessage): Promise<void> {
    try {
        const clean: StoredShadowMessage = {
            id: String(msg.id),
            channelId: String(msg.channelId),
            guildId: msg.guildId ? String(msg.guildId) : undefined,
            authorId: String(msg.authorId || ""),
            authorName: msg.authorName || "User",
            authorAvatar: msg.authorAvatar,
            content: String(msg.content ?? ""),
            timestamp: toEpoch(msg.timestamp, msg.id),
            deleted: true,
            deletedAt: toEpoch(msg.deletedAt || Date.now()),
            attachments: (msg.attachments || []).map(a => ({
                id: String(a.id),
                url: String(a.url),
                proxy_url: a.proxy_url ? String(a.proxy_url) : undefined,
                filename: String(a.filename || "file"),
                size: typeof a.size === "number" ? a.size : 0,
                content_type: a.content_type,
                deleted: true,
            })),
            editHistory: (msg.editHistory || []).map((e: any) => ({
                timestamp: toEpoch(e.timestamp),
                content: String(e.content ?? ""),
            })),
        };
        await DataStore.set(clean.id, clean, shadowStore);
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

export async function markDeleted(id: string, deletedAt = Date.now(), fallbackMsg?: any): Promise<void> {
    try {
        let existing = await DataStore.get<StoredShadowMessage>(id, shadowStore);
        if (existing) {
            existing.deleted = true;
            existing.deletedAt = toEpoch(deletedAt);
            if (existing.attachments) {
                existing.attachments.forEach(a => (a.deleted = true));
            }
            await DataStore.set(id, existing, shadowStore);
        } else if (fallbackMsg) {
            const author = fallbackMsg.author || {};
            const stored: StoredShadowMessage = {
                id: String(fallbackMsg.id),
                channelId: String(fallbackMsg.channel_id),
                guildId: fallbackMsg.guild_id ? String(fallbackMsg.guild_id) : undefined,
                authorId: String(author.id ?? ""),
                authorName: author.global_name || author.username || "User",
                authorAvatar: author.avatar,
                content: String(fallbackMsg.content ?? ""),
                timestamp: toEpoch(fallbackMsg.timestamp),
                deleted: true,
                deletedAt: toEpoch(deletedAt),
                attachments: fallbackMsg.attachments?.map((a: any) => ({
                    id: String(a.id),
                    url: String(a.url),
                    proxy_url: a.proxy_url ? String(a.proxy_url) : undefined,
                    filename: String(a.filename || "file"),
                    size: typeof a.size === "number" ? a.size : 0,
                    content_type: a.content_type,
                    deleted: true,
                })),
                editHistory: fallbackMsg.editHistory?.map((e: any) => ({
                    timestamp: toEpoch(e.timestamp),
                    content: String(e.content ?? ""),
                })),
            };
            await DataStore.set(id, stored, shadowStore);
        }
    } catch (e) {
        console.error("[ShadowLogs] Error marking deleted:", e);
    }
}

export async function addEdit(id: string, oldContent: string, timestamp: number): Promise<void> {
    try {
        let existing = await DataStore.get<StoredShadowMessage>(id, shadowStore);
        if (!existing) return;
        if (!existing.editHistory) existing.editHistory = [];
        const last = existing.editHistory[existing.editHistory.length - 1];
        if (!last || last.content !== oldContent) {
            existing.editHistory.push({ timestamp: toEpoch(timestamp), content: oldContent });
            await DataStore.set(id, existing, shadowStore);
        }
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
        const json = JSON.stringify(all || []);
        const estimatedSizeBytes = json.length * 2;
        return {
            count,
            deletedCount: count,
            estimatedSizeBytes,
        };
    } catch (e) {
        console.error("[ShadowLogs] Error getting stats:", e);
        return { count: 0, deletedCount: 0, estimatedSizeBytes: 0 };
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
