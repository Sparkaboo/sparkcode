import type { ResolvedKeybindingsConfig } from "@t3tools/contracts";
import { parseScopedThreadKey, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { scopeProjectGroupTerminalRef } from "../../lib/projectGroupTerminal";
import type { TerminalContextSelection } from "../../lib/terminalContext";
import { useProjects } from "../../state/entities";
import { useTerminalUiStateStore } from "../../terminalUiStateStore";
import {
  MAX_HIDDEN_MOUNTED_TERMINAL_THREADS,
  reconcileMountedTerminalThreadIds,
} from "../ChatView.logic";
import {
  PersistentThreadTerminalDrawer,
  type PersistentTerminalLaunchContext,
} from "../PersistentThreadTerminals";

interface ChatTerminalDrawersProps {
  readonly activeGroupTerminalKey: string | null;
  readonly activeTerminalOpen: boolean;
  readonly launchContext: PersistentTerminalLaunchContext | null;
  readonly splitShortcutLabel: string | undefined;
  readonly splitVerticalShortcutLabel: string | undefined;
  readonly newShortcutLabel: string | undefined;
  readonly closeShortcutLabel: string | undefined;
  readonly keybindings: ResolvedKeybindingsConfig;
  readonly onAddTerminalContext: (selection: TerminalContextSelection) => void;
}

/**
 * Keeps project-group full-canvas terminals mounted across thread and project
 * switches so running dev servers and temporary shells stay instant.
 */
export function ChatTerminalDrawers(props: ChatTerminalDrawersProps) {
  const { activeGroupTerminalKey } = props;
  const liveGroupTerminalKeys = useTerminalUiStateStore(
    useShallow((state) =>
      Object.entries(state.terminalUiStateByThreadKey).flatMap(([nextKey, nextTerminalUiState]) =>
        nextTerminalUiState.terminalOpen || nextTerminalUiState.terminalIds.length > 0
          ? [nextKey]
          : [],
      ),
    ),
  );
  const projects = useProjects();
  const validProjectGroupKeys = new Set<string>(
    projects.map((project) =>
      scopedThreadKey(scopeProjectGroupTerminalRef(project.environmentId, project.id)),
    ),
  );
  const [mountedGroupTerminalKeys, setMountedGroupTerminalKeys] = useState<string[]>([]);
  const existingLiveGroupTerminalKeys = liveGroupTerminalKeys.filter((nextKey) =>
    validProjectGroupKeys.has(nextKey),
  );
  const reconciledMountedGroupTerminalKeys = reconcileMountedTerminalThreadIds({
    currentThreadIds: mountedGroupTerminalKeys,
    openThreadIds: existingLiveGroupTerminalKeys,
    activeThreadId: activeGroupTerminalKey,
    activeThreadTerminalOpen: props.activeTerminalOpen,
    maxHiddenThreadCount: MAX_HIDDEN_MOUNTED_TERMINAL_THREADS,
  });
  if (
    reconciledMountedGroupTerminalKeys.length !== mountedGroupTerminalKeys.length ||
    reconciledMountedGroupTerminalKeys.some(
      (groupKey, index) => groupKey !== mountedGroupTerminalKeys[index],
    )
  ) {
    setMountedGroupTerminalKeys(reconciledMountedGroupTerminalKeys);
  }
  const mountedGroupTerminalRefs = mountedGroupTerminalKeys.flatMap((mountedKey) => {
    const mountedRef = parseScopedThreadKey(mountedKey);
    return mountedRef ? [{ key: mountedKey, threadRef: mountedRef }] : [];
  });

  return mountedGroupTerminalRefs.map(({ key: mountedKey, threadRef: mountedRef }) => {
    const isActiveGroup = mountedKey === activeGroupTerminalKey;
    return (
      <PersistentThreadTerminalDrawer
        key={mountedKey}
        mode="canvas"
        threadRef={mountedRef}
        threadId={mountedRef.threadId}
        active={isActiveGroup}
        composerHeight={0}
        launchContext={isActiveGroup ? props.launchContext : null}
        splitShortcutLabel={props.splitShortcutLabel}
        splitVerticalShortcutLabel={props.splitVerticalShortcutLabel}
        newShortcutLabel={props.newShortcutLabel}
        closeShortcutLabel={props.closeShortcutLabel}
        keybindings={props.keybindings}
        onAddTerminalContext={props.onAddTerminalContext}
      />
    );
  });
}
