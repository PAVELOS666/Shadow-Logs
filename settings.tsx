/*
 * Shadow Logs - Settings & Retention UI
 */

import { definePluginSettings } from "@api/Settings";
import { Button } from "@components/Button";
import { Heading } from "@components/Heading";
import { Paragraph } from "@components/Paragraph";
import { OptionType } from "@utils/types";
import { useEffect, useState } from "@webpack/common";

import { clearAll, exportAll, getStats, pruneOlderThan } from "./db";
import { clearInMemory, pruneInMemory } from "./index";
import { DBStats, TimeUnit } from "./types";

export const settings = definePluginSettings({
    memberThreshold: {
        type: OptionType.NUMBER,
        description: "Maximum server member count for automatic logging (Servers with > members are ignored unless whitelisted)",
        default: 500,
    },
    logDeletes: {
        type: OptionType.BOOLEAN,
        description: "Log deleted messages and keep them visible with red highlight",
        default: true,
    },
    logEdits: {
        type: OptionType.BOOLEAN,
        description: "Log message edits and maintain edit revision history",
        default: true,
    },
    logDeletedAttachments: {
        type: OptionType.BOOLEAN,
        description: "Mark deleted attachments visually rather than removing them",
        default: true,
    },
    ignoreBots: {
        type: OptionType.BOOLEAN,
        description: "Ignore messages from bot accounts",
        default: true,
    },
    ignoreSelf: {
        type: OptionType.BOOLEAN,
        description: "Ignore messages sent by yourself",
        default: false,
    },
    whitelistedGuilds: {
        type: OptionType.STRING,
        description: "Comma-separated list of Guild IDs to ALWAYS log (even if over member count threshold)",
        default: "",
        multiline: true,
    },
    blacklistedGuilds: {
        type: OptionType.STRING,
        description: "Comma-separated list of Guild IDs to NEVER log",
        default: "",
        multiline: true,
    },
    blacklistedChannels: {
        type: OptionType.STRING,
        description: "Comma-separated list of Channel IDs to NEVER log",
        default: "",
        multiline: true,
    },
    blacklistedUsers: {
        type: OptionType.STRING,
        description: "Comma-separated list of User IDs to NEVER log",
        default: "",
        multiline: true,
    },
    retentionManager: {
        type: OptionType.COMPONENT,
        component: RetentionComponent,
    },
});

function formatBytes(bytes: number): string {
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / (1024 * 1024)).toFixed(2) + " MB";
}

function calculateCutoff(value: number, unit: TimeUnit): number {
    const now = Date.now();
    let ms = 0;
    switch (unit) {
        case "seconds":
            ms = value * 1000;
            break;
        case "minutes":
            ms = value * 60 * 1000;
            break;
        case "hours":
            ms = value * 60 * 60 * 1000;
            break;
        case "days":
            ms = value * 24 * 60 * 60 * 1000;
            break;
        case "months":
            ms = value * 30 * 24 * 60 * 60 * 1000;
            break;
    }
    return now - ms;
}

export function RetentionComponent() {
    const [stats, setStats] = useState<DBStats>({ count: 0, deletedCount: 0, estimatedSizeBytes: 0 });
    const [pruneVal, setPruneVal] = useState<number>(7);
    const [pruneUnit, setPruneUnit] = useState<TimeUnit>("days");
    const [statusNotice, setStatusNotice] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);

    const refreshStats = async () => {
        try {
            const s = await getStats();
            setStats(s);
        } catch (e) {
            console.error("[ShadowLogs] Error refreshing stats:", e);
        }
    };

    useEffect(() => {
        refreshStats();
    }, []);

    const handlePrune = async () => {
        if (pruneVal <= 0) return;
        setLoading(true);
        setStatusNotice(null);
        try {
            const cutoff = calculateCutoff(pruneVal, pruneUnit);
            const deleted = await pruneOlderThan(cutoff);
            pruneInMemory(cutoff);
            await refreshStats();
            setStatusNotice("Successfully pruned " + deleted.toLocaleString() + " message(s) older than " + pruneVal + " " + pruneUnit + ".");
        } catch (e) {
            setStatusNotice("Error pruning logs: " + String(e));
        } finally {
            setLoading(false);
        }
    };

    const handleClearAll = async () => {
        if (!confirm("Are you sure you want to permanently clear all stored Shadow Logs? This action cannot be undone.")) {
            return;
        }
        setLoading(true);
        try {
            await clearAll();
            clearInMemory();
            await refreshStats();
            setStatusNotice("All database logs have been successfully cleared.");
        } finally {
            setLoading(false);
        }
    };

    const handleExport = async () => {
        try {
            const json = await exportAll();
            const blob = new Blob([json], { type: "application/json" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = "shadow-logs-backup-" + new Date().toISOString().slice(0, 10) + ".json";
            a.click();
            URL.revokeObjectURL(url);
            setStatusNotice("Database exported to JSON file.");
        } catch (e) {
            setStatusNotice("Export failed: " + String(e));
        }
    };

    return (
        <div className="shadowlogs-settings-card">
            <Heading tag="h3" style={{ marginBottom: "8px" }}>
                Database Retention & Storage Manager
            </Heading>
            <Paragraph style={{ color: "var(--text-muted)", marginBottom: "14px" }}>
                Messages are stored locally in IndexedDB as lightweight JSON records. You can prune old messages by custom timeframe or clear specific chats.
            </Paragraph>

            <div className="shadowlogs-stats-grid">
                <div className="shadowlogs-stat-box">
                    <span className="shadowlogs-stat-label">Total Stored</span>
                    <span className="shadowlogs-stat-value">{stats.count.toLocaleString()}</span>
                </div>
                <div className="shadowlogs-stat-box">
                    <span className="shadowlogs-stat-label">Deleted Messages</span>
                    <span className="shadowlogs-stat-value" style={{ color: "var(--text-danger, #f23f43)" }}>
                        {stats.deletedCount.toLocaleString()}
                    </span>
                </div>
                <div className="shadowlogs-stat-box">
                    <span className="shadowlogs-stat-label">Estimated Size</span>
                    <span className="shadowlogs-stat-value">{formatBytes(stats.estimatedSizeBytes)}</span>
                </div>
            </div>

            <Heading tag="h4" style={{ marginTop: "12px", marginBottom: "6px" }}>
                Prune Messages Older Than
            </Heading>

            <div className="shadowlogs-prune-row">
                <input
                    type="number"
                    min={1}
                    value={pruneVal}
                    onChange={e => setPruneVal(Math.max(1, parseInt(e.target.value) || 1))}
                    className="shadowlogs-input"
                    disabled={loading}
                />
                <select
                    value={pruneUnit}
                    onChange={e => setPruneUnit(e.target.value as TimeUnit)}
                    className="shadowlogs-select"
                    disabled={loading}
                >
                    <option value="seconds">Seconds</option>
                    <option value="minutes">Minutes</option>
                    <option value="hours">Hours</option>
                    <option value="days">Days</option>
                    <option value="months">Months</option>
                </select>

                <Button
                    variant="primary"
                    onClick={handlePrune}
                    disabled={loading}
                >
                    Prune Messages
                </Button>

                <Button
                    variant="secondary"
                    onClick={refreshStats}
                    disabled={loading}
                >
                    Refresh Stats
                </Button>
            </div>

            <div className="shadowlogs-prune-row" style={{ marginTop: "16px" }}>
                <Button
                    variant="dangerPrimary"
                    onClick={handleClearAll}
                    disabled={loading}
                >
                    Clear All Logs
                </Button>

                <Button
                    variant="secondary"
                    onClick={handleExport}
                    disabled={loading}
                >
                    Export to JSON
                </Button>
            </div>

            {statusNotice && (
                <div className="shadowlogs-notice">
                    {statusNotice}
                </div>
            )}
        </div>
    );
}
