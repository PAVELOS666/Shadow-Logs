/*
 * Shadow Logs - Persistent Message Logger for Vencord
 * Types definition
 */

import { Message, MessageAttachment } from "@vencord/discord-types";

export interface ShadowAttachment extends MessageAttachment {
    deleted?: boolean;
}

export interface ShadowEditEntry {
    timestamp: Date;
    content: string;
}

export interface ShadowMessage extends Message {
    deleted?: boolean;
    deletedAt?: number;
    editHistory?: ShadowEditEntry[];
    firstEditTimestamp?: Date;
}

export interface StoredShadowMessage {
    id: string;
    channelId: string;
    guildId?: string;
    channel_id?: string;
    guild_id?: string;
    authorId: string;
    authorName?: string;
    authorAvatar?: string;
    author?: any;
    content: string;
    timestamp: number; // epoch ms
    deleted: boolean;
    deletedAt?: number;
    editHistory?: { timestamp: number; content: string }[];
    attachments?: {
        id: string;
        url: string;
        proxy_url?: string;
        filename: string;
        size?: number;
        content_type?: string;
        deleted?: boolean;
    }[];
    embeds?: any[];
    message_reference?: any;
    sticker_items?: any[];
}

export type TimeUnit = "seconds" | "minutes" | "hours" | "days" | "months";

export interface DBStats {
    count: number;
    deletedCount: number;
    editedCount?: number;
    estimatedSizeBytes: number;
}
