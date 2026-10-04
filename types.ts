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
    authorId: string;
    authorName?: string;
    authorAvatar?: string;
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
}

export type TimeUnit = "seconds" | "minutes" | "hours" | "days" | "months";

export interface DBStats {
    count: number;
    deletedCount: number;
    estimatedSizeBytes: number;
}
