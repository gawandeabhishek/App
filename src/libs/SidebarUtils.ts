import {Str} from 'expensify-common';
import type {OnyxCollection, OnyxEntry} from 'react-native-onyx';
import Onyx from 'react-native-onyx';
import type {ChatReportSelector, PolicySelector, ReportActionsSelector} from '@hooks/useReportIDs';
import CONST from '@src/CONST';
import ONYXKEYS from '@src/ONYXKEYS';
import type {PersonalDetails, PersonalDetailsList, ReportActions, TransactionViolation} from '@src/types/onyx';
import type Beta from '@src/types/onyx/Beta';
import type Policy from '@src/types/onyx/Policy';
import type PriorityMode from '@src/types/onyx/PriorityMode';
import type Report from '@src/types/onyx/Report';
import type ReportAction from '@src/types/onyx/ReportAction';
import type DeepValueOf from '@src/types/utils/DeepValueOf';
import * as CollectionUtils from './CollectionUtils';
import {hasValidDraftComment} from './DraftCommentUtils';
import localeCompare from './LocaleCompare';
import * as LocalePhoneNumber from './LocalePhoneNumber';
import * as Localize from './Localize';
import * as OptionsListUtils from './OptionsListUtils';
import * as PolicyUtils from './PolicyUtils';
import * as ReportActionsUtils from './ReportActionsUtils';
import * as ReportUtils from './ReportUtils';
import * as TaskUtils from './TaskUtils';

const visibleReportActionItems: ReportActions = {};
Onyx.connect({
    key: ONYXKEYS.COLLECTION.REPORT_ACTIONS,
    callback: (actions, key) => {
        if (!actions || !key) {
            return;
        }
        const reportID = CollectionUtils.extractCollectionItemID(key);

        const actionsArray: ReportAction[] = ReportActionsUtils.getSortedReportActions(Object.values(actions));

        // The report is only visible if it is the last action not deleted that
        // does not match a closed or created state.
        const reportActionsForDisplay = actionsArray.filter(
            (reportAction) => ReportActionsUtils.shouldReportActionBeVisibleAsLastAction(reportAction) && reportAction.actionName !== CONST.REPORT.ACTIONS.TYPE.CREATED,
        );

        visibleReportActionItems[reportID] = reportActionsForDisplay[reportActionsForDisplay.length - 1];
    },
});

function compareStringDates(a: string, b: string): 0 | 1 | -1 {
    if (a < b) {
        return -1;
    }
    if (a > b) {
        return 1;
    }
    return 0;
}

/**
 * A mini report object that contains only the necessary information to sort reports.
 * This is used to avoid copying the entire report object and only the necessary information.
 */
type MiniReport = {
    reportID?: string;
    displayName: string;
    lastVisibleActionCreated?: string;
};

/**
 * @returns An array of reportIDs sorted in the proper order
 */
function getOrderedReportIDs(
    currentReportId: string | null,
    allReports: OnyxCollection<ChatReportSelector>,
    betas: OnyxEntry<Beta[]>,
    policies: OnyxCollection<PolicySelector>,
    priorityMode: OnyxEntry<PriorityMode>,
    allReportActions: OnyxCollection<ReportActionsSelector>,
    transactionViolations: OnyxCollection<TransactionViolation[]>,
    currentPolicyID = '',
    policyMemberAccountIDs: number[] = [],
): string[] {
    const isInFocusMode = priorityMode === CONST.PRIORITY_MODE.GSD;
    const isInDefaultMode = !isInFocusMode;
    const allReportsDictValues = Object.values(allReports ?? {});

    // Filter out all the reports that shouldn't be displayed
    let reportsToDisplay: Array<ChatReportSelector & {hasErrorsOtherThanFailedReceipt?: boolean}> = [];
    allReportsDictValues.forEach((report) => {
        if (!report) {
            return;
        }
        const reportActions = allReportActions?.[`${ONYXKEYS.COLLECTION.REPORT_ACTIONS}${report.reportID}`] ?? {};
        const doesReportHaveViolations = OptionsListUtils.shouldShowViolations(report, betas ?? [], transactionViolations);
        const isHidden = report.notificationPreference === CONST.REPORT.NOTIFICATION_PREFERENCE.HIDDEN;
        const isFocused = report.reportID === currentReportId;
        const allReportErrors = OptionsListUtils.getAllReportErrors(report, reportActions) ?? {};
        const hasErrorsOtherThanFailedReceipt =
            doesReportHaveViolations || Object.values(allReportErrors).some((error) => error?.[0] !== Localize.translateLocal('iou.error.genericSmartscanFailureMessage'));
        if (ReportUtils.isOneTransactionThread(report.reportID, report.parentReportID ?? '0')) {
            return;
        }
        if (hasErrorsOtherThanFailedReceipt) {
            reportsToDisplay.push({
                ...report,
                hasErrorsOtherThanFailedReceipt: true,
            });
            return;
        }
        const isSystemChat = ReportUtils.isSystemChat(report);
        const shouldOverrideHidden = hasErrorsOtherThanFailedReceipt || isFocused || isSystemChat || report.isPinned;
        if (isHidden && !shouldOverrideHidden) {
            return;
        }

        if (
            ReportUtils.shouldReportBeInOptionList({
                report,
                currentReportId: currentReportId ?? '-1',
                isInFocusMode,
                betas,
                policies: policies as OnyxCollection<Policy>,
                excludeEmptyChats: true,
                doesReportHaveViolations,
                includeSelfDM: true,
            })
        ) {
            reportsToDisplay.push(report);
        }
    });

    // The LHN is split into four distinct groups, and each group is sorted a little differently. The groups will ALWAYS be in this order:
    // 1. Pinned/GBR - Always sorted by reportDisplayName
    // 2. Drafts - Always sorted by reportDisplayName
    // 3. Non-archived reports and settled IOUs
    //      - Sorted by lastVisibleActionCreated in default (most recent) view mode
    //      - Sorted by reportDisplayName in GSD (focus) view mode
    // 4. Archived reports
    //      - Sorted by lastVisibleActionCreated in default (most recent) view mode
    //      - Sorted by reportDisplayName in GSD (focus) view mode

    const pinnedAndGBRReports: MiniReport[] = [];
    const draftReports: MiniReport[] = [];
    const nonArchivedReports: MiniReport[] = [];
    const archivedReports: MiniReport[] = [];
    const errorReports: MiniReport[] = [];

    if (currentPolicyID || policyMemberAccountIDs.length > 0) {
        reportsToDisplay = reportsToDisplay.filter(
            (report) => report?.reportID === currentReportId || ReportUtils.doesReportBelongToWorkspace(report, policyMemberAccountIDs, currentPolicyID),
        );
    }
    // There are a few properties that need to be calculated for the report which are used when sorting reports.
    reportsToDisplay.forEach((reportToDisplay) => {
        const report = reportToDisplay;
        const miniReport: MiniReport = {
            reportID: report?.reportID,
            displayName: ReportUtils.getReportName(report),
            lastVisibleActionCreated: report?.lastVisibleActionCreated,
        };

        const isPinned = report?.isPinned ?? false;
        const reportAction = ReportActionsUtils.getReportAction(report?.parentReportID ?? '-1', report?.parentReportActionID ?? '-1');
        if (isPinned || ReportUtils.requiresAttentionFromCurrentUser(report, reportAction)) {
            pinnedAndGBRReports.push(miniReport);
        } else if (hasValidDraftComment(report?.reportID ?? '-1')) {
            draftReports.push(miniReport);
        } else if (ReportUtils.isArchivedRoom(report)) {
            archivedReports.push(miniReport);
        } else if (report?.hasErrorsOtherThanFailedReceipt) {
            errorReports.push(miniReport);
        } else {
            nonArchivedReports.push(miniReport);
        }
    });

    // Sort each group of reports accordingly
    pinnedAndGBRReports.sort((a, b) => (a?.displayName && b?.displayName ? localeCompare(a.displayName, b.displayName) : 0));
    errorReports.sort((a, b) => (a?.displayName && b?.displayName ? localeCompare(a.displayName, b.displayName) : 0));
    draftReports.sort((a, b) => (a?.displayName && b?.displayName ? localeCompare(a.displayName, b.displayName) : 0));

    if (isInDefaultMode) {
        nonArchivedReports.sort((a, b) => {
            const compareDates = a?.lastVisibleActionCreated && b?.lastVisibleActionCreated ? compareStringDates(b.lastVisibleActionCreated, a.lastVisibleActionCreated) : 0;
            if (compareDates) {
                return compareDates;
            }
            const compareDisplayNames = a?.displayName && b?.displayName ? localeCompare(a.displayName, b.displayName) : 0;
            return compareDisplayNames;
        });
        // For archived reports ensure that most recent reports are at the top by reversing the order
        archivedReports.sort((a, b) => (a?.lastVisibleActionCreated && b?.lastVisibleActionCreated ? compareStringDates(b.lastVisibleActionCreated, a.lastVisibleActionCreated) : 0));
    } else {
        nonArchivedReports.sort((a, b) => (a?.displayName && b?.displayName ? localeCompare(a.displayName, b.displayName) : 0));
        archivedReports.sort((a, b) => (a?.displayName && b?.displayName ? localeCompare(a.displayName, b.displayName) : 0));
    }

    // Now that we have all the reports grouped and sorted, they must be flattened into an array and only return the reportID.
    // The order the arrays are concatenated in matters and will determine the order that the groups are displayed in the sidebar.

    const LHNReports = [...pinnedAndGBRReports, ...errorReports, ...draftReports, ...nonArchivedReports, ...archivedReports].map((report) => report?.reportID ?? '-1');

    return LHNReports;
}

/**
 * Gets all the data necessary for rendering an OptionRowLHN component
 */
function getOptionData({
    report,
    reportActions,
    personalDetails,
    preferredLocale,
    policy,
    parentReportAction,
    hasViolations,
}: {
    report: OnyxEntry<Report>;
    reportActions: OnyxEntry<ReportActions>;
    personalDetails: OnyxEntry<PersonalDetailsList>;
    preferredLocale: DeepValueOf<typeof CONST.LOCALES>;
    policy: OnyxEntry<Policy> | undefined;
    parentReportAction: OnyxEntry<ReportAction> | undefined;
    hasViolations: boolean;
}): ReportUtils.OptionData | undefined {
    // When a user signs out, Onyx is cleared. Due to the lazy rendering with a virtual list, it's possible for
    // this method to be called after the Onyx data has been cleared out. In that case, it's fine to do
    // a null check here and return early.
    if (!report || !personalDetails) {
        return;
    }

    const result: ReportUtils.OptionData = {
        text: '',
        alternateText: undefined,
        allReportErrors: OptionsListUtils.getAllReportErrors(report, reportActions),
        brickRoadIndicator: null,
        tooltipText: null,
        subtitle: undefined,
        login: undefined,
        accountID: undefined,
        reportID: '',
        phoneNumber: undefined,
        isUnread: null,
        isUnreadWithMention: null,
        hasDraftComment: false,
        keyForList: undefined,
        searchText: undefined,
        isPinned: false,
        hasOutstandingChildRequest: false,
        hasOutstandingChildTask: false,
        hasParentAccess: undefined,
        isIOUReportOwner: null,
        isChatRoom: false,
        isArchivedRoom: false,
        shouldShowSubscript: false,
        isPolicyExpenseChat: false,
        isMoneyRequestReport: false,
        isExpenseRequest: false,
        isWaitingOnBankAccount: false,
        isAllowedToComment: true,
        isDeletedParentAction: false,
    };

    const participantAccountIDs = ReportUtils.getParticipantsAccountIDsForDisplay(report);
    const visibleParticipantAccountIDs = ReportUtils.getParticipantsAccountIDsForDisplay(report, true);

    const participantPersonalDetailList = Object.values(OptionsListUtils.getPersonalDetailsForAccountIDs(participantAccountIDs, personalDetails)) as PersonalDetails[];
    const personalDetail = participantPersonalDetailList[0] ?? {};
    const hasErrors = Object.keys(result.allReportErrors ?? {}).length !== 0;

    result.isThread = ReportUtils.isChatThread(report);
    result.isChatRoom = ReportUtils.isChatRoom(report);
    result.isTaskReport = ReportUtils.isTaskReport(report);
    result.isInvoiceReport = ReportUtils.isInvoiceReport(report);
    result.parentReportAction = parentReportAction;
    result.isArchivedRoom = ReportUtils.isArchivedRoom(report);
    result.isPolicyExpenseChat = ReportUtils.isPolicyExpenseChat(report);
    result.isExpenseRequest = ReportUtils.isExpenseRequest(report);
    result.isMoneyRequestReport = ReportUtils.isMoneyRequestReport(report);
    result.shouldShowSubscript = ReportUtils.shouldReportShowSubscript(report);
    result.pendingAction = report.pendingFields?.addWorkspaceRoom ?? report.pendingFields?.createChat;
    result.brickRoadIndicator = hasErrors || hasViolations ? CONST.BRICK_ROAD_INDICATOR_STATUS.ERROR : '';
    result.ownerAccountID = report.ownerAccountID;
    result.managerID = report.managerID;
    result.reportID = report.reportID;
    result.policyID = report.policyID;
    result.stateNum = report.stateNum;
    result.statusNum = report.statusNum;
    // When the only message of a report is deleted lastVisibileActionCreated is not reset leading to wrongly
    // setting it Unread so we add additional condition here to avoid empty chat LHN from being bold.
    result.isUnread = ReportUtils.isUnread(report) && !!report.lastActorAccountID;
    result.isUnreadWithMention = ReportUtils.isUnreadWithMention(report);
    result.isPinned = report.isPinned;
    result.iouReportID = report.iouReportID;
    result.keyForList = String(report.reportID);
    result.hasOutstandingChildRequest = report.hasOutstandingChildRequest;
    result.parentReportID = report.parentReportID ?? '-1';
    result.isWaitingOnBankAccount = report.isWaitingOnBankAccount;
    result.notificationPreference = report.notificationPreference;
    result.isAllowedToComment = ReportUtils.canUserPerformWriteAction(report);
    result.chatType = report.chatType;
    result.isDeletedParentAction = report.isDeletedParentAction;
    result.isSelfDM = ReportUtils.isSelfDM(report);
    result.tooltipText = ReportUtils.getReportParticipantsTitle(visibleParticipantAccountIDs);
    result.hasOutstandingChildTask = report.hasOutstandingChildTask;
    result.hasParentAccess = report.hasParentAccess;

    const hasMultipleParticipants = participantPersonalDetailList.length > 1 || result.isChatRoom || result.isPolicyExpenseChat || ReportUtils.isExpenseReport(report);
    const subtitle = ReportUtils.getChatRoomSubtitle(report);

    const login = Str.removeSMSDomain(personalDetail?.login ?? '');
    const status = personalDetail?.status ?? '';
    const formattedLogin = Str.isSMSLogin(login) ? LocalePhoneNumber.formatPhoneNumber(login) : login;

    // We only create tooltips for the first 10 users or so since some reports have hundreds of users, causing performance to degrade.
    const displayNamesWithTooltips = ReportUtils.getDisplayNamesWithTooltips(
        (participantPersonalDetailList || []).slice(0, 10),
        hasMultipleParticipants,
        undefined,
        ReportUtils.isSelfDM(report),
    );

    // If the last actor's details are not currently saved in Onyx Collection,
    // then try to get that from the last report action if that action is valid
    // to get data from.
    let lastActorDetails: Partial<PersonalDetails> | null = report.lastActorAccountID && personalDetails?.[report.lastActorAccountID] ? personalDetails[report.lastActorAccountID] : null;

    if (!lastActorDetails && visibleReportActionItems[report.reportID]) {
        const lastActorDisplayName = visibleReportActionItems[report.reportID]?.person?.[0]?.text;
        lastActorDetails = lastActorDisplayName
            ? {
                  displayName: lastActorDisplayName,
                  accountID: report.lastActorAccountID,
              }
            : null;
    }

    const lastActorDisplayName = OptionsListUtils.getLastActorDisplayName(lastActorDetails, hasMultipleParticipants);
    const lastMessageTextFromReport = OptionsListUtils.getLastMessageTextForReport(report, lastActorDetails, policy);

    // We need to remove sms domain in case the last message text has a phone number mention with sms domain.
    let lastMessageText = Str.removeSMSDomain(lastMessageTextFromReport);

    const lastAction = visibleReportActionItems[report.reportID];

    const isThreadMessage =
        ReportUtils.isThread(report) && lastAction?.actionName === CONST.REPORT.ACTIONS.TYPE.ADD_COMMENT && lastAction?.pendingAction !== CONST.RED_BRICK_ROAD_PENDING_ACTION.DELETE;

    if ((result.isChatRoom || result.isPolicyExpenseChat || result.isThread || result.isTaskReport || isThreadMessage) && !result.isArchivedRoom) {
        const lastActionName = lastAction?.actionName ?? report.lastActionType;

        if (ReportActionsUtils.isRenamedAction(lastAction)) {
            const newName = ReportActionsUtils.getOriginalMessage(lastAction)?.newName ?? '';
            result.alternateText = Localize.translate(preferredLocale, 'newRoomPage.roomRenamedTo', {newName});
        } else if (ReportActionsUtils.isTaskAction(lastAction)) {
            result.alternateText = ReportUtils.formatReportLastMessageText(TaskUtils.getTaskReportActionMessage(lastAction).text);
        } else if (ReportActionsUtils.isRoomChangeLogAction(lastAction)) {
            const lastActionOriginalMessage = lastAction?.actionName ? ReportActionsUtils.getOriginalMessage(lastAction) : null;
            const targetAccountIDs = lastActionOriginalMessage?.targetAccountIDs ?? [];
            const targetAccountIDsLength = targetAccountIDs.length !== 0 ? targetAccountIDs.length : report.lastMessageHtml?.match(/<mention-user[^>]*><\/mention-user>/g)?.length ?? 0;
            const verb =
                lastActionName === CONST.REPORT.ACTIONS.TYPE.ROOM_CHANGE_LOG.INVITE_TO_ROOM || lastActionName === CONST.REPORT.ACTIONS.TYPE.POLICY_CHANGE_LOG.INVITE_TO_ROOM
                    ? Localize.translate(preferredLocale, 'workspace.invite.invited')
                    : Localize.translate(preferredLocale, 'workspace.invite.removed');
            const users = Localize.translate(preferredLocale, targetAccountIDsLength > 1 ? 'workspace.invite.users' : 'workspace.invite.user');
            result.alternateText = `${lastActorDisplayName} ${verb} ${targetAccountIDsLength} ${users}`.trim();

            const roomName = lastActionOriginalMessage?.roomName ?? '';
            if (roomName) {
                const preposition =
                    lastAction.actionName === CONST.REPORT.ACTIONS.TYPE.ROOM_CHANGE_LOG.INVITE_TO_ROOM || lastAction.actionName === CONST.REPORT.ACTIONS.TYPE.POLICY_CHANGE_LOG.INVITE_TO_ROOM
                        ? ` ${Localize.translate(preferredLocale, 'workspace.invite.to')}`
                        : ` ${Localize.translate(preferredLocale, 'workspace.invite.from')}`;
                result.alternateText += `${preposition} ${roomName}`;
            }
            if (lastActionName === CONST.REPORT.ACTIONS.TYPE.ROOM_CHANGE_LOG.UPDATE_ROOM_DESCRIPTION) {
                result.alternateText = `${lastActorDisplayName} ${Localize.translate(preferredLocale, 'roomChangeLog.updateRoomDescription')} ${
                    lastActionOriginalMessage?.description
                }`.trim();
            }
        } else if (lastAction?.actionName === CONST.REPORT.ACTIONS.TYPE.POLICY_CHANGE_LOG.LEAVE_POLICY) {
            result.alternateText = Localize.translateLocal('workspace.invite.leftWorkspace');
        } else if (lastAction?.actionName !== CONST.REPORT.ACTIONS.TYPE.REPORT_PREVIEW && lastActorDisplayName && lastMessageTextFromReport) {
            result.alternateText = `${lastActorDisplayName}: ${lastMessageText}`;
        } else if (lastAction?.actionName === CONST.REPORT.ACTIONS.TYPE.POLICY_CHANGE_LOG.ADD_TAG) {
            result.alternateText = PolicyUtils.getCleanedTagName(ReportActionsUtils.getReportActionMessage(lastAction)?.text ?? '');
        } else {
            result.alternateText = lastMessageTextFromReport.length > 0 ? lastMessageText : ReportActionsUtils.getLastVisibleMessage(report.reportID, {}, lastAction)?.lastMessageText;
            if (!result.alternateText) {
                result.alternateText = Localize.translate(preferredLocale, 'report.noActivityYet');
            }
        }
    } else {
        if (!lastMessageText) {
            if (ReportUtils.isSystemChat(report)) {
                lastMessageText = Localize.translate(preferredLocale, 'reportActionsView.beginningOfChatHistorySystemDM');
            } else if (ReportUtils.isSelfDM(report)) {
                lastMessageText = Localize.translate(preferredLocale, 'reportActionsView.beginningOfChatHistorySelfDM');
            } else {
                // Here we get the beginning of chat history message and append the display name for each user, adding pronouns if there are any.
                // We also add a fullstop after the final name, the word "and" before the final name and commas between all previous names.
                lastMessageText =
                    Localize.translate(preferredLocale, 'reportActionsView.beginningOfChatHistory') +
                    displayNamesWithTooltips
                        .map(({displayName, pronouns}, index) => {
                            const formattedText = !pronouns ? displayName : `${displayName} (${pronouns})`;

                            if (index === displayNamesWithTooltips.length - 1) {
                                return `${formattedText}.`;
                            }
                            if (index === displayNamesWithTooltips.length - 2) {
                                return `${formattedText} ${Localize.translate(preferredLocale, 'common.and')}`;
                            }
                            if (index < displayNamesWithTooltips.length - 2) {
                                return `${formattedText},`;
                            }

                            return '';
                        })
                        .join(' ');
            }
        }

        result.alternateText =
            (ReportUtils.isGroupChat(report) || ReportUtils.isDeprecatedGroupDM(report)) && lastActorDisplayName
                ? `${lastActorDisplayName}: ${lastMessageText}`
                : lastMessageText || formattedLogin;
    }

    result.isIOUReportOwner = ReportUtils.isIOUOwnedByCurrentUser(result as Report);

    if (ReportUtils.isJoinRequestInAdminRoom(report)) {
        result.isPinned = true;
        result.isUnread = true;
        result.brickRoadIndicator = CONST.BRICK_ROAD_INDICATOR_STATUS.INFO;
    }

    if (!hasMultipleParticipants) {
        result.accountID = personalDetail?.accountID;
        result.login = personalDetail?.login;
        result.phoneNumber = personalDetail?.phoneNumber;
    }

    const reportName = ReportUtils.getReportName(report, policy);

    result.text = reportName;
    result.subtitle = subtitle;
    result.participantsList = participantPersonalDetailList;

    result.icons = ReportUtils.getIcons(report, personalDetails, personalDetail?.avatar, personalDetail?.login, personalDetail?.accountID, policy);
    result.searchText = OptionsListUtils.getSearchText(report, reportName, participantPersonalDetailList, result.isChatRoom || result.isPolicyExpenseChat, result.isThread);
    result.displayNamesWithTooltips = displayNamesWithTooltips;

    if (status) {
        result.status = status;
    }
    result.type = report.type;

    return result;
}

export default {
    getOptionData,
    getOrderedReportIDs,
};
