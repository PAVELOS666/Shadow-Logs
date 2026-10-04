/*
 * Shadow Logs - Edit History Modal
 */

import ErrorBoundary from "@components/ErrorBoundary";
import { Margins } from "@utils/margins";
import { classes } from "@utils/misc";
import { RenderModalProps } from "@vencord/discord-types";
import { findCssClassesLazy } from "@webpack";
import { Modal, openModal, TabBar, Timestamp, useState } from "@webpack/common";

import { parseEditContent } from "./index";
import { ShadowMessage } from "./types";

const CodeContainerClasses = findCssClassesLazy("markup", "codeContainer");
const MiscClasses = findCssClassesLazy("messageContent", "markupRtl");

export function openHistoryModal(message: ShadowMessage) {
    if (!message.editHistory?.length) return;

    openModal(props => (
        <ErrorBoundary>
            <HistoryModal modalProps={props} message={message} />
        </ErrorBoundary>
    ));
}

export function HistoryModal({ modalProps, message }: { modalProps: RenderModalProps; message: ShadowMessage; }) {
    const editHistory = message.editHistory || [];
    const [currentTab, setCurrentTab] = useState(editHistory.length);

    const firstTime = message.firstEditTimestamp ? new Date(message.firstEditTimestamp) : new Date(message.timestamp);
    const timestamps = [firstTime, ...editHistory.map(m => new Date(m.timestamp))];
    const contents = [...editHistory.map(m => m.content), message.content];

    return (
        <Modal {...modalProps} size="lg" title="Message Edit History">
            <TabBar
                type="top"
                look="brand"
                className="vc-settings-tab-bar"
                selectedItem={currentTab}
                onItemSelect={setCurrentTab}
            >
                {timestamps.map((timestamp, index) => (
                    <TabBar.Item
                        key={index}
                        className="vc-settings-tab-bar-item"
                        id={index}
                    >
                        <Timestamp
                            timestamp={timestamp}
                            isEdited={true}
                            isInline={false}
                        />
                    </TabBar.Item>
                ))}
            </TabBar>

            <div className={classes(CodeContainerClasses.markup, MiscClasses.messageContent, Margins.top20)}>
                {parseEditContent(contents[currentTab] ?? "", message)}
            </div>
        </Modal>
    );
}
