import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import type { Dispatch } from "react";
import type { ComposerHandleRef } from "../../composerHandleContext";
import type { selectThreadTerminalUiState } from "../../terminalUiStateStore";
import { useStableCallback } from "../../hooks/useStableCallback";
import { useThreadTerminalActions } from "../terminal/useThreadTerminalActions";
import { getTerminalLabel } from "@t3tools/shared/terminalLabels";
import {
  AuthTerminalReadScope,
  AuthTerminalOperateScope,
  type EnvironmentId,
  type ProjectScript,
  type ScopedThreadRef,
  type ThreadId,
} from "@t3tools/contracts";
import { projectScriptTerminalInput } from "@t3tools/shared/projectScripts";
import { type SetStateAction } from "react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { MAX_TERMINALS_PER_GROUP } from "../../types";
import {
  selectThreadRightPanelState,
  type RightPanelSurface,
  useRightPanelStore,
} from "../../rightPanelStore";
import { openUrlInPreview } from "../../browser/openFileInPreview";
import { isPreviewAvailableFor } from "../../browser/previewRuntime";
import { resolveDiscoveredServerUrl } from "../../browser/browserTargetResolver";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { confirmTerminalClose } from "../../lib/terminalCloseConfirm";
import { findReusableProjectScriptTerminal } from "../../lib/projectScriptTerminal";
import { type TerminalContextSelection } from "../../lib/terminalContext";
import {
  focusActiveDrawerTerminal,
  focusActivePanelTerminal,
  focusTerminal,
} from "../../lib/terminalFocus";
import { useTerminalUiStateStore } from "../../terminalUiStateStore";
import {
  LAST_INVOKED_SCRIPT_BY_PROJECT_KEY,
  LastInvokedScriptByProjectSchema,
  makeThreadErrorSetter,
} from "../ChatView.logic";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import { previewEnvironment } from "../../state/preview";
import { readEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import type { ChatShortcutCommands } from "./useChatShortcuts";
const SCRIPT_TERMINAL_COLS = 120;
const SCRIPT_TERMINAL_ROWS = 30;

export interface TerminalLaunchContext {
  threadId: ThreadId;
  cwd: string;
  worktreePath: string | null;
}

interface ChatTerminalActionsInput {
  readonly environmentId: EnvironmentId;
  readonly composerRef: ComposerHandleRef;
  readonly terminalUiState: ReturnType<typeof selectThreadTerminalUiState>;
  readonly activeGroupTerminalRef: ScopedThreadRef | null;
  readonly groupRunningTerminalIds: ReadonlyArray<string>;
  readonly groupServerOrderedTerminalIds: ReadonlyArray<string>;
  readonly groupTerminalLabelsById: ReadonlyMap<string, string>;
  readonly activeThread: EnvironmentThreadShell | undefined;
  readonly activeThreadId: ThreadId | null;
  readonly activeThreadRef: ScopedThreadRef | null;
  readonly activeProject: EnvironmentProject | null;
  readonly activeRightPanelSurface: RightPanelSurface | null;
  readonly activeTerminalLabelsById: ReadonlyMap<string, string>;
  readonly canReuseTerminal: boolean;
  readonly gitCwd: string | null;
  readonly setTerminalUiLaunchContext: Dispatch<SetStateAction<TerminalLaunchContext | null>>;
  readonly setThreadError: ReturnType<typeof makeThreadErrorSetter>;
}

const EMPTY_PANEL_TERMINAL_IDS: ReadonlySet<string> = new Set();

/**
 * Project-group full-canvas terminals (plus project scripts and chat code blocks) run under
 * `activeGroupTerminalRef`, while thread-following right-panel terminals stay on `activeThreadRef`.
 */
export function useChatTerminalActions(input: ChatTerminalActionsInput) {
  const {
    environmentId,
    composerRef,
    terminalUiState,
    activeGroupTerminalRef,
    groupRunningTerminalIds,
    groupServerOrderedTerminalIds,
    groupTerminalLabelsById,
    activeThread,
    activeThreadId,
    activeThreadRef,
    activeProject,
    activeRightPanelSurface,
    activeTerminalLabelsById,
    canReuseTerminal,
    gitCwd,
    setTerminalUiLaunchContext,
    setThreadError,
  } = input;
  const openPreview = useAtomCommand(previewEnvironment.open, { reportFailure: false });

  const hasTerminalWriteAccess = () =>
    readEnvironmentScope(environmentId, AuthTerminalOperateScope);
  const [lastInvokedScriptByProjectId, setLastInvokedScriptByProjectId] = useLocalStorage(
    LAST_INVOKED_SCRIPT_BY_PROJECT_KEY,
    {},
    LastInvokedScriptByProjectSchema,
  );
  const storeSetTerminalOpen = useTerminalUiStateStore((s) => s.setTerminalOpen);
  const storeEnsureTerminal = useTerminalUiStateStore((state) => state.ensureTerminal);
  const storeSplitTerminal = useTerminalUiStateStore((s) => s.splitTerminal);
  const storeSplitTerminalVertical = useTerminalUiStateStore((s) => s.splitTerminalVertical);
  const storeNewTerminal = useTerminalUiStateStore((s) => s.newTerminal);
  const storeCloseTerminal = useTerminalUiStateStore((s) => s.closeTerminal);
  const groupTerminalActions = useThreadTerminalActions(activeGroupTerminalRef);
  const threadTerminalActions = useThreadTerminalActions(activeThreadRef);

  const resolveGroupLaunchLocation = () => {
    if (!activeProject) return null;
    return {
      cwd: activeProject.workspaceRoot,
      worktreePath: null,
    };
  };

  const activeTerminalGroup =
    terminalUiState.terminalGroups.find(
      (group) => group.id === terminalUiState.activeTerminalGroupId,
    ) ??
    terminalUiState.terminalGroups.find((group) =>
      group.terminalIds.includes(terminalUiState.activeTerminalId),
    ) ??
    null;
  const hasReachedSplitLimit =
    (activeTerminalGroup?.terminalIds.length ?? 0) >= MAX_TERMINALS_PER_GROUP;
  /*__HOOK__*/
  const addTerminalContextToDraft = (selection: TerminalContextSelection) => {
    composerRef.current?.addTerminalContext(selection);
  };
  const addTerminalContextToDraftStable = useStableCallback(addTerminalContextToDraft);
  const setTerminalOpen = (open: boolean) => {
    if (!activeGroupTerminalRef) return;
    storeSetTerminalOpen(activeGroupTerminalRef, open);
    focusActiveDrawerTerminal(activeGroupTerminalRef);
  };
  const setTerminalOpenStable = useStableCallback(setTerminalOpen);
  const toggleTerminalVisibility = () => {
    if (!activeGroupTerminalRef) return;
    const nextOpen = !terminalUiState.terminalOpen;
    if (
      nextOpen &&
      !readEnvironmentScope(environmentId, AuthTerminalReadScope) &&
      !hasTerminalWriteAccess()
    )
      return;
    if (nextOpen && hasTerminalWriteAccess() && terminalUiState.terminalIds.length === 0) {
      const existingTerminalId = groupRunningTerminalIds[0] ?? groupServerOrderedTerminalIds[0];
      if (existingTerminalId !== undefined) {
        storeEnsureTerminal(activeGroupTerminalRef, existingTerminalId, {
          open: true,
          active: true,
        });
        focusActiveDrawerTerminal(activeGroupTerminalRef);
        return;
      }
      const location = resolveGroupLaunchLocation();
      void groupTerminalActions.launchTerminal({
        place: (terminalId) =>
          storeEnsureTerminal(activeGroupTerminalRef, terminalId, { open: true }),
        ...(location ? { location } : {}),
      })?.result;
      focusActiveDrawerTerminal(activeGroupTerminalRef);
      return;
    }
    setTerminalOpen(nextOpen);
  };
  const toggleTerminalVisibilityStable = useStableCallback(toggleTerminalVisibility);
  const splitTerminal = (direction: "horizontal" | "vertical" = "horizontal") => {
    if (!activeGroupTerminalRef || hasReachedSplitLimit) return;
    const location = resolveGroupLaunchLocation();
    const launched = groupTerminalActions.launchTerminal({
      place: (terminalId) =>
        direction === "vertical"
          ? storeSplitTerminalVertical(activeGroupTerminalRef, terminalId)
          : storeSplitTerminal(activeGroupTerminalRef, terminalId),
      ...(location ? { location } : {}),
    });
    if (!launched) return;
    focusTerminal(activeGroupTerminalRef, launched.terminalId);
    void launched.result;
  };
  const splitTerminalStable = useStableCallback(splitTerminal);
  const createNewTerminal = () => {
    if (!activeGroupTerminalRef) return;
    const location = resolveGroupLaunchLocation();
    const launched = groupTerminalActions.launchTerminal({
      place: (terminalId) => storeNewTerminal(activeGroupTerminalRef, terminalId),
      ...(location ? { location } : {}),
    });
    if (!launched) return;
    focusTerminal(activeGroupTerminalRef, launched.terminalId);
    void launched.result;
  };
  const createNewTerminalStable = useStableCallback(createNewTerminal);
  const closeTerminal = (terminalId: string) => {
    if (!hasTerminalWriteAccess() || !activeGroupTerminalRef) return;
    groupTerminalActions.closeTerminalSession(terminalId, activeGroupTerminalRef);
    storeCloseTerminal(activeGroupTerminalRef, terminalId);
    focusActiveDrawerTerminal(activeGroupTerminalRef);
  };
  const runProjectScript = async (
    script: ProjectScript,
    options?: {
      cwd?: string;
      env?: Record<string, string>;
      worktreePath?: string | null;
      preferNewTerminal?: boolean;
      rememberAsLastInvoked?: boolean;
      shellHistory?: "preserve" | "suppress";
    },
  ) => {
    if (!hasTerminalWriteAccess() || !activeGroupTerminalRef || !activeProject || !activeThread)
      return;
    if (options?.rememberAsLastInvoked !== false) {
      setLastInvokedScriptByProjectId((current) => {
        if (current[activeProject.id] === script.id) return current;
        return { ...current, [activeProject.id]: script.id };
      });
    }
    const targetCwd = options?.cwd ?? gitCwd ?? activeProject.workspaceRoot;
    const reusableTerminalId =
      script.stopOnSettle ||
      options?.preferNewTerminal ||
      !canReuseTerminal ||
      !readEnvironmentScope(environmentId, AuthTerminalReadScope)
        ? null
        : findReusableProjectScriptTerminal({
            drawerTerminalIds: [
              ...new Set([...terminalUiState.terminalIds, ...groupServerOrderedTerminalIds]),
            ],
            activeTerminalId: terminalUiState.activeTerminalId,
            panelTerminalIds: EMPTY_PANEL_TERMINAL_IDS,
            runningTerminalIds: groupRunningTerminalIds,
          });
    const targetWorktreePath = options?.worktreePath ?? activeThread.worktreePath ?? null;

    setTerminalUiLaunchContext({
      threadId: activeGroupTerminalRef.threadId,
      cwd: targetCwd,
      worktreePath: targetWorktreePath,
    });

    const launched = groupTerminalActions.launchTerminal({
      place: (terminalId) =>
        reusableTerminalId === null
          ? storeNewTerminal(activeGroupTerminalRef, terminalId)
          : storeEnsureTerminal(activeGroupTerminalRef, terminalId, { open: true }),
      ...(reusableTerminalId === null
        ? { size: { cols: SCRIPT_TERMINAL_COLS, rows: SCRIPT_TERMINAL_ROWS } }
        : { terminalId: reusableTerminalId }),
      location: { cwd: targetCwd, worktreePath: targetWorktreePath },
      stopOnSettle: script.stopOnSettle ?? false,
      ...(options?.env ? { extraEnv: options.env } : {}),
    });
    if (!launched) return;
    const targetTerminalId = launched.terminalId;
    focusTerminal(activeGroupTerminalRef, targetTerminalId);
    const openResult = await launched.result;
    if (openResult._tag === "Failure") {
      if (!isAtomCommandInterrupted(openResult) && activeThreadId) {
        const error = squashAtomCommandFailure(openResult);
        setThreadError(
          activeThreadId,
          error instanceof Error ? error.message : `Failed to run script "${script.name}".`,
        );
      }
      return;
    }

    const writeResult = await groupTerminalActions.writeToTerminal(
      targetTerminalId,
      options?.shellHistory === "preserve"
        ? `${script.command}\r`
        : projectScriptTerminalInput(script.command),
    );
    if (!writeResult) return;
    if (writeResult._tag === "Failure") {
      if (!isAtomCommandInterrupted(writeResult) && activeThreadId) {
        const error = squashAtomCommandFailure(writeResult);
        setThreadError(
          activeThreadId,
          error instanceof Error ? error.message : `Failed to run script "${script.name}".`,
        );
      }
      return;
    }
    if (
      script.autoOpenPreview &&
      script.previewUrl &&
      activeThreadRef &&
      isPreviewAvailableFor(activeThreadRef.environmentId)
    ) {
      const previewResult = await openUrlInPreview({
        threadRef: activeThreadRef,
        url: resolveDiscoveredServerUrl(activeThreadRef.environmentId, script.previewUrl),
        openPreview,
      });
      if (previewResult._tag === "Failure" && !isAtomCommandInterrupted(previewResult)) {
        const error = squashAtomCommandFailure(previewResult);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not open preview",
            description: error instanceof Error ? error.message : "An unexpected error occurred.",
          }),
        );
      }
    }
  };
  const runProjectScriptStable = useStableCallback(runProjectScript);

  const runShellCommand = (command: string) => {
    void runProjectScript(
      {
        id: "chat-code-block",
        name: "Chat code block",
        command,
        icon: "play",
        runOnWorktreeCreate: false,
      },
      { rememberAsLastInvoked: false, shellHistory: "preserve" },
    );
  };
  const runShellCommandStable = useStableCallback(runShellCommand);
  const addTerminalSurface = () => {
    if (!activeThreadRef) return;
    const launched = threadTerminalActions.launchTerminal({
      place: (terminalId) =>
        useRightPanelStore.getState().openTerminal(activeThreadRef, terminalId),
    });
    if (!launched) return;
    focusTerminal(activeThreadRef, launched.terminalId);
    void launched.result;
  };
  const addTerminalSurfaceStable = useStableCallback(addTerminalSurface);
  const splitPanelTerminal = (direction: "horizontal" | "vertical" = "horizontal") => {
    if (
      !activeThreadRef ||
      activeRightPanelSurface?.kind !== "terminal" ||
      activeRightPanelSurface.terminalIds.length >= MAX_TERMINALS_PER_GROUP
    ) {
      return;
    }
    const surfaceId = activeRightPanelSurface.id;
    const launched = threadTerminalActions.launchTerminal({
      place: (terminalId) =>
        useRightPanelStore
          .getState()
          .splitTerminal(activeThreadRef, surfaceId, terminalId, direction),
    });
    if (!launched) return;
    focusTerminal(activeThreadRef, launched.terminalId);
    void launched.result;
  };
  const splitPanelTerminalStable = useStableCallback(splitPanelTerminal);
  const splitPanelTerminalVertical = () => {
    splitPanelTerminal("vertical");
  };
  const splitPanelTerminalVerticalStable = useStableCallback(splitPanelTerminalVertical);
  const activatePanelTerminal = (terminalId: string) => {
    if (!activeThreadRef || activeRightPanelSurface?.kind !== "terminal") return;
    useRightPanelStore
      .getState()
      .activateTerminal(activeThreadRef, activeRightPanelSurface.id, terminalId);
    focusTerminal(activeThreadRef, terminalId);
  };
  const activatePanelTerminalStable = useStableCallback(activatePanelTerminal);
  const closePanelTerminal = (terminalId: string, target = activeThreadRef) => {
    if (!target || !readEnvironmentScope(target.environmentId, AuthTerminalOperateScope)) return;
    const store = useRightPanelStore.getState();
    const surface = selectThreadRightPanelState(store.byThreadKey, target).surfaces.find(
      (entry) => entry.kind === "terminal" && entry.terminalIds.includes(terminalId),
    );
    if (!surface) return;
    threadTerminalActions.closeTerminalSession(terminalId, target);
    storeCloseTerminal(target, terminalId);
    store.closeTerminal(target, surface.id, terminalId);
    focusActivePanelTerminal(target);
  };
  const closePanelTerminalStable = useStableCallback(closePanelTerminal);
  const requestCloseTerminal = (terminalId: string) => {
    if (!hasTerminalWriteAccess()) return;
    const label = groupTerminalLabelsById.get(terminalId) ?? getTerminalLabel(terminalId);
    void confirmTerminalClose([label]).then((confirmed) => {
      if (confirmed && readEnvironmentScope(environmentId, AuthTerminalOperateScope)) {
        closeTerminal(terminalId);
      }
    });
  };
  const requestCloseTerminalStable = useStableCallback(requestCloseTerminal);
  const requestClosePanelTerminal = (terminalId: string) => {
    if (!hasTerminalWriteAccess()) return;
    const label = activeTerminalLabelsById.get(terminalId) ?? getTerminalLabel(terminalId);
    void confirmTerminalClose([label]).then((confirmed) => {
      if (confirmed && readEnvironmentScope(environmentId, AuthTerminalOperateScope)) {
        closePanelTerminal(terminalId);
      }
    });
  };
  const requestClosePanelTerminalStable = useStableCallback(requestClosePanelTerminal);
  const openTerminalIfClosed = () => {
    if (!terminalUiState.terminalOpen) setTerminalOpen(true);
  };
  // A focused right-panel terminal takes the split/new/close chords; otherwise they act on the drawer.
  const shortcuts = {
    "terminal.toggle": () => {
      if (
        !terminalUiState.terminalOpen &&
        !readEnvironmentScope(environmentId, AuthTerminalReadScope) &&
        !hasTerminalWriteAccess()
      )
        return false;
      toggleTerminalVisibility();
    },
    "terminal.split": ({ terminalFocusOwner }) => {
      if (!hasTerminalWriteAccess()) return false;
      if (terminalFocusOwner === "right-panel") return void splitPanelTerminal();
      openTerminalIfClosed();
      splitTerminal();
    },
    "terminal.splitVertical": ({ terminalFocusOwner }) => {
      if (!hasTerminalWriteAccess()) return false;
      if (terminalFocusOwner === "right-panel") return void splitPanelTerminal("vertical");
      openTerminalIfClosed();
      splitTerminal("vertical");
    },
    "terminal.close": ({ terminalFocusOwner }) => {
      if (!hasTerminalWriteAccess()) return false;
      if (terminalFocusOwner === "right-panel" && activeRightPanelSurface?.kind === "terminal") {
        requestClosePanelTerminal(activeRightPanelSurface.activeTerminalId);
        return;
      }
      if (terminalUiState.terminalOpen) requestCloseTerminal(terminalUiState.activeTerminalId);
    },
    "terminal.new": ({ terminalFocusOwner }) => {
      if (!hasTerminalWriteAccess()) return false;
      if (terminalFocusOwner === "right-panel") return void addTerminalSurface();
      openTerminalIfClosed();
      createNewTerminal();
    },
  } satisfies ChatShortcutCommands;
  return {
    shortcuts,
    activatePanelTerminalStable,
    addTerminalContextToDraftStable,
    addTerminalSurfaceStable,
    closePanelTerminalStable,
    createNewTerminalStable,
    lastInvokedScriptByProjectId,
    requestClosePanelTerminalStable,
    requestCloseTerminalStable,
    runProjectScriptStable,
    runShellCommandStable,
    setTerminalOpenStable,
    splitPanelTerminalStable,
    splitPanelTerminalVerticalStable,
    splitTerminalStable,
    toggleTerminalVisibilityStable,
  };
}
