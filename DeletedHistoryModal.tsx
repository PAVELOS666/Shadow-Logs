/*
 * Shadow Logs - Deleted Messages History Modal (User & Server)
 */

import ErrorBoundary from "@components/ErrorBoundary";
import { Margins } from "@utils/margins";
import { RenderModalProps } from "@vencord/discord-types";
import {
    Button,
    ChannelStore,
    GuildStore,
    MessageActions,
    Modal,
    NavigationRouter,
    openModal,
    Parser,
    Timestamp,
    useEffect,
    useMemo,
    UserStore,
    useState
} from "@webpack/common";

import { getDeletedMessagesForAuthor, getDeletedMessagesForGuild } from "./db";
import { openHistoryModal } from "./HistoryModal";
import { StoredShadowMessage } from "./types";

export interface DeletedHistoryTarget {
    type: "user" | "guild";
    id: string;
    name?: string;
    avatar?: string;
    icon?: string;
}

export function openDeletedHistoryModal(target: DeletedHistoryTarget) {
    openModal(props => (
        <ErrorBoundary>
            <DeletedHistoryModal modalProps={props} target={target} />
        </ErrorBoundary>
    ));
}

function formatBytes(bytes?: number): string {
    if (!bytes || bytes <= 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

function getAvatarUrl(authorId: string, avatarHash?: string): string {
    if (avatarHash) {
        if (avatarHash.startsWith("http")) return avatarHash;
        return `https://cdn.discordapp.com/avatars/${authorId}/${avatarHash}.png?size=80`;
    }
    const user = UserStore.getUser(authorId);
    if (user?.getAvatarURL) {
        return user.getAvatarURL(undefined, 80);
    }
    return "https://cdn.discordapp.com/embed/avatars/0.png";
}

export function DeletedHistoryModal({
    modalProps,
    target
}: {
    modalProps: RenderModalProps;
    target: DeletedHistoryTarget;
}) {
    const [messages, setMessages] = useState<StoredShadowMessage[]>([]);
    const [loading, setLoading] = useState(true);
    const [searchQuery, setSearchQuery] = useState("");
    const [page, setPage] = useState(1);
    const PAGE_SIZE = 20;

    useEffect(() => {
        let isMounted = true;
        setLoading(true);

        const fetcher =
            target.type === "user"
                ? getDeletedMessagesForAuthor(target.id)
                : getDeletedMessagesForGuild(target.id);

        fetcher.then(data => {
            if (!isMounted) return;
            setMessages(data);
            setLoading(false);
        }).catch(err => {
            console.error("[ShadowLogs] Error loading history:", err);
            if (!isMounted) return;
            setLoading(false);
        });

        return () => {
            isMounted = false;
        };
    }, [target.id, target.type]);

    // Live search filtering
    const filteredMessages = useMemo(() => {
        if (!searchQuery.trim()) return messages;
        const q = searchQuery.toLowerCase().trim();

        return messages.filter(msg => {
            const contentMatch = msg.content?.toLowerCase().includes(q);
            const authorMatch = msg.authorName?.toLowerCase().includes(q);
            const channelName = ChannelStore.getChannel(msg.channelId)?.name?.toLowerCase();
            const channelMatch = channelName ? channelName.includes(q) : msg.channelId.includes(q);
            const attachmentMatch = msg.attachments?.some(a => a.filename?.toLowerCase().includes(q));

            return contentMatch || authorMatch || channelMatch || attachmentMatch;
        });
    }, [messages, searchQuery]);

    // Reset pagination on search change
    useEffect(() => {
        setPage(1);
    }, [searchQuery]);

    const totalPages = Math.max(1, Math.ceil(filteredMessages.length / PAGE_SIZE));
    const currentPage = Math.min(page, totalPages);

    const paginatedMessages = useMemo(() => {
        const start = (currentPage - 1) * PAGE_SIZE;
        return filteredMessages.slice(start, start + PAGE_SIZE);
    }, [filteredMessages, currentPage]);

    const handleJump = (msg: StoredShadowMessage) => {
        modalProps.onClose();
        if (MessageActions?.jumpToMessage) {
            MessageActions.jumpToMessage({
                channelId: msg.channelId,
                messageId: msg.id,
                flash: true,
                jumpType: "ANIMATED"
            });
        } else if (NavigationRouter?.transitionTo) {
            NavigationRouter.transitionTo(`/channels/${msg.guildId || "@me"}/${msg.channelId}/${msg.id}`);
        }
    };

    const modalTitle = target.type === "user"
        ? `Deleted Messages - @${target.name || "User"}`
        : `Server Deleted Logs - ${target.name || "Server"}`;

    return (
        <Modal {...modalProps} size="lg" title={modalTitle}>
            <div className="shadowlogs-history-container">
                {/* Header Subtitle and Search Controls */}
                <div className="shadowlogs-history-controls">
                    <div className="shadowlogs-history-meta">
                        <span className="shadowlogs-history-stat-badge">
                            {messages.length} stored deletion{messages.length === 1 ? "" : "s"}
                        </span>
                        {searchQuery && (
                            <span className="shadowlogs-history-match-badge">
                                {filteredMessages.length} match{filteredMessages.length === 1 ? "" : "es"}
                            </span>
                        )}
                    </div>

                    <div className="shadowlogs-history-search-wrapper">
                        <input
                            type="text"
                            className="shadowlogs-input shadowlogs-history-search-input"
                            placeholder="Filter by message text, author, channel name, or file..."
                            value={searchQuery}
                            onChange={e => setSearchQuery(e.target.value)}
                        />
                        {searchQuery && (
                            <button
                                className="shadowlogs-history-clear-btn"
                                onClick={() => setSearchQuery("")}
                                title="Clear search"
                            >
                                ✕
                            </button>
                        )}
                    </div>
                </div>

                {/* Content List */}
                <div className="shadowlogs-history-list">
                    {loading ? (
                        <div className="shadowlogs-history-empty">
                            <div className="shadowlogs-spinner" />
                            <span>Loading deleted messages from IndexedDB...</span>
                        </div>
                    ) : filteredMessages.length === 0 ? (
                        <div className="shadowlogs-history-empty">
                            {searchQuery ? (
                                <span>No deleted messages match your search filter.</span>
                            ) : (
                                <span>No deleted messages recorded for this {target.type === "user" ? "user" : "server"} yet.</span>
                            )}
                        </div>
                    ) : (
                        paginatedMessages.map(msg => {
                            const channel = ChannelStore.getChannel(msg.channelId);
                            const channelName = channel?.name ? `#${channel.name}` : `Channel: ${msg.channelId}`;
                            const avatarUrl = getAvatarUrl(msg.authorId, msg.authorAvatar);
                            const hasEdits = !!(msg.editHistory && msg.editHistory.length > 0);

                            return (
                                <div key={msg.id} className="shadowlogs-history-card">
                                    <div className="shadowlogs-history-card-header">
                                        <div className="shadowlogs-history-card-author-info">
                                            <img
                                                src={avatarUrl}
                                                alt=""
                                                className="shadowlogs-history-avatar"
                                                onError={(e: any) => {
                                                    e.target.src = "https://cdn.discordapp.com/embed/avatars/0.png";
                                                }}
                                            />
                                            <div className="shadowlogs-history-card-names">
                                                <span className="shadowlogs-history-author-name">
                                                    {msg.authorName || "User"}
                                                </span>
                                                <span className="shadowlogs-history-channel-badge" title={`Channel ID: ${msg.channelId}`}>
                                                    {channelName}
                                                </span>
                                            </div>
                                        </div>

                                        <div className="shadowlogs-history-card-actions">
                                            <Button
                                                size={Button.Sizes?.MIN}
                                                color={Button.Colors?.PRIMARY}
                                                className="shadowlogs-history-jump-button"
                                                onClick={() => handleJump(msg)}
                                            >
                                                Jump to Message
                                            </Button>
                                        </div>
                                    </div>

                                    {/* Timestamps */}
                                    <div className="shadowlogs-history-timestamps">
                                        <span className="shadowlogs-history-time-item">
                                            Sent: <Timestamp timestamp={new Date(msg.timestamp)} isInline={true} />
                                        </span>
                                        <span className="shadowlogs-history-time-item shadowlogs-deleted-time-badge">
                                            Deleted: <Timestamp timestamp={new Date(msg.deletedAt || msg.timestamp)} isInline={true} />
                                        </span>
                                        {hasEdits && (
                                            <span
                                                className="shadowlogs-history-edits-badge"
                                                onClick={() => openHistoryModal(msg as any)}
                                                title="Click to view edit history"
                                            >
                                                Edited ({msg.editHistory!.length})
                                            </span>
                                        )}
                                    </div>

                                    {/* Message Content */}
                                    <div className="shadowlogs-history-content">
                                        {msg.content ? (
                                            Parser?.parse ? (
                                                Parser.parse(msg.content)
                                            ) : (
                                                <span>{msg.content}</span>
                                            )
                                        ) : (
                                            <span className="shadowlogs-history-no-content">
                                                (No text content)
                                            </span>
                                        )}
                                    </div>

                                    {/* Attachments */}
                                    {msg.attachments && msg.attachments.length > 0 && (
                                        <div className="shadowlogs-history-attachments">
                                            {msg.attachments.map(att => {
                                                const isImage = att.content_type?.startsWith("image/") ||
                                                    /\.(png|jpe?g|webp|gif)$/i.test(att.filename || "");

                                                return (
                                                    <div key={att.id} className="shadowlogs-history-attachment-item">
                                                        {isImage ? (
                                                            <div className="shadowlogs-history-attachment-preview">
                                                                <img
                                                                    src={att.proxy_url || att.url}
                                                                    alt={att.filename}
                                                                    className="shadowlogs-deleted-attachment shadowlogs-history-thumb"
                                                                />
                                                                <a
                                                                    href={att.url}
                                                                    target="_blank"
                                                                    rel="noreferrer"
                                                                    className="shadowlogs-history-attachment-link"
                                                                >
                                                                    {att.filename} ({formatBytes(att.size)})
                                                                </a>
                                                            </div>
                                                        ) : (
                                                            <div className="shadowlogs-history-attachment-file">
                                                                <span className="shadowlogs-history-file-icon">📄</span>
                                                                <a
                                                                    href={att.url}
                                                                    target="_blank"
                                                                    rel="noreferrer"
                                                                    className="shadowlogs-history-attachment-link"
                                                                >
                                                                    {att.filename}
                                                                </a>
                                                                <span className="shadowlogs-history-file-size">
                                                                    ({formatBytes(att.size)})
                                                                </span>
                                                                <span className="shadowlogs-deleted-badge">DELETED</span>
                                                            </div>
                                                        )}
                                                    </div>
                                                );
                                            })}
                                        </div>
                                    )}
                                </div>
                            );
                        })
                    )}
                </div>

                {/* Pagination Controls */}
                {totalPages > 1 && (
                    <div className="shadowlogs-history-pagination">
                        <Button
                            size={Button.Sizes?.SMALL}
                            color={Button.Colors?.PRIMARY}
                            disabled={currentPage <= 1}
                            onClick={() => setPage(p => Math.max(1, p - 1))}
                        >
                            Previous
                        </Button>

                        <span className="shadowlogs-history-page-info">
                            Page {currentPage} of {totalPages}
                        </span>

                        <Button
                            size={Button.Sizes?.SMALL}
                            color={Button.Colors?.PRIMARY}
                            disabled={currentPage >= totalPages}
                            onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                        >
                            Next
                        </Button>
                    </div>
                )}
            </div>
        </Modal>
    );
}
