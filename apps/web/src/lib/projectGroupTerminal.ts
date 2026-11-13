import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { ProjectId, ThreadId, type EnvironmentId, type ScopedThreadRef } from "@t3tools/contracts";

const PROJECT_GROUP_TERMINAL_PREFIX = "project-group-";

export function makeProjectGroupTerminalThreadId(projectId: ProjectId): ThreadId {
  return ThreadId.make(`${PROJECT_GROUP_TERMINAL_PREFIX}${projectId}`);
}

export function scopeProjectGroupTerminalRef(
  environmentId: EnvironmentId,
  projectId: ProjectId,
): ScopedThreadRef {
  return scopeThreadRef(environmentId, makeProjectGroupTerminalThreadId(projectId));
}

export function parseProjectIdFromTerminalThreadId(threadId: string): ProjectId | null {
  if (!threadId.startsWith(PROJECT_GROUP_TERMINAL_PREFIX)) {
    return null;
  }
  const rawProjectId = threadId.slice(PROJECT_GROUP_TERMINAL_PREFIX.length).trim();
  if (rawProjectId.length === 0) {
    return null;
  }
  return ProjectId.make(rawProjectId);
}

export function isProjectGroupTerminalThreadId(threadId: string): boolean {
  return parseProjectIdFromTerminalThreadId(threadId) !== null;
}
