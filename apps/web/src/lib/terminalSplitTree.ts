export type TerminalSplitDirection = "horizontal" | "vertical";

export type TerminalSplitNode =
  | {
      readonly type: "leaf";
      readonly terminalId: string;
    }
  | {
      readonly type: "branch";
      readonly direction: TerminalSplitDirection;
      readonly ratio: number;
      readonly first: TerminalSplitNode;
      readonly second: TerminalSplitNode;
    };

export interface TerminalLeafBounds {
  readonly terminalId: string;
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export interface TerminalSplitDivider {
  readonly path: string;
  readonly direction: TerminalSplitDirection;
  readonly ratio: number;
  readonly branchLeft: number;
  readonly branchTop: number;
  readonly branchWidth: number;
  readonly branchHeight: number;
  readonly lineLeft: number;
  readonly lineTop: number;
  readonly lineWidth: number;
  readonly lineHeight: number;
}

const MIN_TERMINAL_SPLIT_RATIO = 0.15;
const MAX_TERMINAL_SPLIT_RATIO = 0.85;
export const DEFAULT_TERMINAL_SPLIT_RATIO = 0.5;

export function clampTerminalSplitRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) {
    return DEFAULT_TERMINAL_SPLIT_RATIO;
  }
  return Math.min(MAX_TERMINAL_SPLIT_RATIO, Math.max(MIN_TERMINAL_SPLIT_RATIO, ratio));
}

function isValidTerminalSplitNode(value: unknown): value is TerminalSplitNode {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.type === "leaf") {
    return typeof candidate.terminalId === "string" && candidate.terminalId.trim().length > 0;
  }
  if (candidate.type === "branch") {
    return (
      (candidate.direction === "horizontal" || candidate.direction === "vertical") &&
      typeof candidate.ratio === "number" &&
      Number.isFinite(candidate.ratio) &&
      isValidTerminalSplitNode(candidate.first) &&
      isValidTerminalSplitNode(candidate.second)
    );
  }
  return false;
}

export function cloneTerminalSplitTree(node: TerminalSplitNode): TerminalSplitNode {
  if (node.type === "leaf") {
    return { type: "leaf", terminalId: node.terminalId };
  }
  return {
    type: "branch",
    direction: node.direction,
    ratio: clampTerminalSplitRatio(node.ratio),
    first: cloneTerminalSplitTree(node.first),
    second: cloneTerminalSplitTree(node.second),
  };
}

export function terminalSplitTreesEqual(
  left: TerminalSplitNode | null | undefined,
  right: TerminalSplitNode | null | undefined,
): boolean {
  if (!left && !right) return true;
  if (!left || !right) return false;
  if (left.type !== right.type) return false;
  if (left.type === "leaf" && right.type === "leaf") {
    return left.terminalId === right.terminalId;
  }
  if (left.type === "branch" && right.type === "branch") {
    return (
      left.direction === right.direction &&
      Math.abs(clampTerminalSplitRatio(left.ratio) - clampTerminalSplitRatio(right.ratio)) < 1e-6 &&
      terminalSplitTreesEqual(left.first, right.first) &&
      terminalSplitTreesEqual(left.second, right.second)
    );
  }
  return false;
}

function buildLinearSplitTree(
  terminalIds: readonly string[],
  direction: TerminalSplitDirection = "horizontal",
): TerminalSplitNode | null {
  if (terminalIds.length === 0) return null;
  const firstId = terminalIds[0]!;
  if (terminalIds.length === 1) {
    return { type: "leaf", terminalId: firstId };
  }
  const restTree = buildLinearSplitTree(terminalIds.slice(1), direction);
  if (!restTree) {
    return { type: "leaf", terminalId: firstId };
  }
  return {
    type: "branch",
    direction,
    ratio: clampTerminalSplitRatio(1 / terminalIds.length),
    first: { type: "leaf", terminalId: firstId },
    second: restTree,
  };
}

function pruneSplitTree(
  node: TerminalSplitNode,
  validIds: ReadonlySet<string>,
  seenIds: Set<string>,
): TerminalSplitNode | null {
  if (node.type === "leaf") {
    const trimmed = node.terminalId.trim();
    if (!validIds.has(trimmed) || seenIds.has(trimmed)) {
      return null;
    }
    seenIds.add(trimmed);
    return { type: "leaf", terminalId: trimmed };
  }

  const nextFirst = pruneSplitTree(node.first, validIds, seenIds);
  const nextSecond = pruneSplitTree(node.second, validIds, seenIds);
  if (!nextFirst && !nextSecond) return null;
  if (!nextFirst) return nextSecond;
  if (!nextSecond) return nextFirst;
  return {
    type: "branch",
    direction: node.direction,
    ratio: clampTerminalSplitRatio(node.ratio),
    first: nextFirst,
    second: nextSecond,
  };
}

function appendLeafToRightmost(
  node: TerminalSplitNode,
  newTerminalId: string,
  direction: TerminalSplitDirection,
): TerminalSplitNode {
  if (node.type === "leaf") {
    return {
      type: "branch",
      direction,
      ratio: DEFAULT_TERMINAL_SPLIT_RATIO,
      first: node,
      second: { type: "leaf", terminalId: newTerminalId },
    };
  }
  return {
    ...node,
    second: appendLeafToRightmost(node.second, newTerminalId, direction),
  };
}

export function reconcileTerminalSplitTree(
  tree: TerminalSplitNode | null | undefined,
  terminalIds: readonly string[],
  fallbackDirection: TerminalSplitDirection = "horizontal",
): TerminalSplitNode | null {
  if (terminalIds.length === 0) return null;
  if (terminalIds.length === 1) {
    return { type: "leaf", terminalId: terminalIds[0]! };
  }

  if (!isValidTerminalSplitNode(tree)) {
    return buildLinearSplitTree(terminalIds, fallbackDirection);
  }

  const validIds = new Set(terminalIds);
  const seenIds = new Set<string>();
  let nextTree = pruneSplitTree(tree, validIds, seenIds);

  for (const terminalId of terminalIds) {
    if (seenIds.has(terminalId)) continue;
    seenIds.add(terminalId);
    nextTree = nextTree
      ? appendLeafToRightmost(nextTree, terminalId, fallbackDirection)
      : { type: "leaf", terminalId };
  }

  return nextTree;
}

function replaceAnchorLeafWithSplit(
  node: TerminalSplitNode,
  anchorTerminalId: string,
  newTerminalId: string,
  direction: TerminalSplitDirection,
): { readonly node: TerminalSplitNode; readonly replaced: boolean } {
  if (node.type === "leaf") {
    if (node.terminalId !== anchorTerminalId) {
      return { node, replaced: false };
    }
    return {
      replaced: true,
      node: {
        type: "branch",
        direction,
        ratio: DEFAULT_TERMINAL_SPLIT_RATIO,
        first: node,
        second: { type: "leaf", terminalId: newTerminalId },
      },
    };
  }

  const firstAttempt = replaceAnchorLeafWithSplit(
    node.first,
    anchorTerminalId,
    newTerminalId,
    direction,
  );
  if (firstAttempt.replaced) {
    return {
      replaced: true,
      node: { ...node, first: firstAttempt.node },
    };
  }

  const secondAttempt = replaceAnchorLeafWithSplit(
    node.second,
    anchorTerminalId,
    newTerminalId,
    direction,
  );
  if (secondAttempt.replaced) {
    return {
      replaced: true,
      node: { ...node, second: secondAttempt.node },
    };
  }

  return { node, replaced: false };
}

export function splitTerminalLeafInTree(input: {
  readonly tree: TerminalSplitNode | null | undefined;
  readonly existingTerminalIds: readonly string[];
  readonly anchorTerminalId: string;
  readonly newTerminalId: string;
  readonly direction: TerminalSplitDirection;
  readonly fallbackDirection?: TerminalSplitDirection;
}): TerminalSplitNode {
  const baseIds = input.existingTerminalIds.filter((id) => id !== input.newTerminalId);
  const baseTree = reconcileTerminalSplitTree(
    input.tree,
    baseIds,
    input.fallbackDirection ?? "horizontal",
  );
  if (!baseTree) {
    return { type: "leaf", terminalId: input.newTerminalId };
  }

  const attempt = replaceAnchorLeafWithSplit(
    baseTree,
    input.anchorTerminalId,
    input.newTerminalId,
    input.direction,
  );
  if (attempt.replaced) {
    return attempt.node;
  }

  return appendLeafToRightmost(baseTree, input.newTerminalId, input.direction);
}

export function updateTerminalSplitRatioAtPath(
  tree: TerminalSplitNode,
  path: string,
  ratio: number,
): TerminalSplitNode {
  if (tree.type === "leaf") return tree;
  if (path === "") {
    return {
      ...tree,
      ratio: clampTerminalSplitRatio(ratio),
    };
  }
  const [step, ...rest] = path.split(".");
  const childPath = rest.join(".");
  if (step === "0") {
    const nextFirst = updateTerminalSplitRatioAtPath(tree.first, childPath, ratio);
    return nextFirst === tree.first ? tree : { ...tree, first: nextFirst };
  }
  if (step === "1") {
    const nextSecond = updateTerminalSplitRatioAtPath(tree.second, childPath, ratio);
    return nextSecond === tree.second ? tree : { ...tree, second: nextSecond };
  }
  return tree;
}

export function summarizeSplitTreeDirections(
  tree: TerminalSplitNode | null | undefined,
): "single" | "horizontal" | "vertical" | "mixed" {
  if (!tree || tree.type === "leaf") return "single";
  let hasHorizontal = false;
  let hasVertical = false;
  const walk = (node: TerminalSplitNode) => {
    if (node.type === "leaf") return;
    if (node.direction === "horizontal") hasHorizontal = true;
    if (node.direction === "vertical") hasVertical = true;
    walk(node.first);
    walk(node.second);
  };
  walk(tree);
  if (hasHorizontal && hasVertical) return "mixed";
  if (hasVertical) return "vertical";
  return "horizontal";
}

export function computeTerminalSplitLayout(tree: TerminalSplitNode | null): {
  readonly leaves: ReadonlyArray<TerminalLeafBounds>;
  readonly dividers: ReadonlyArray<TerminalSplitDivider>;
} {
  if (!tree) {
    return { leaves: [], dividers: [] };
  }
  const leaves: TerminalLeafBounds[] = [];
  const dividers: TerminalSplitDivider[] = [];

  const walk = (
    node: TerminalSplitNode,
    left: number,
    top: number,
    width: number,
    height: number,
    path: string,
  ) => {
    if (node.type === "leaf") {
      leaves.push({ terminalId: node.terminalId, left, top, width, height });
      return;
    }

    const ratio = clampTerminalSplitRatio(node.ratio);
    const firstPath = path === "" ? "0" : `${path}.0`;
    const secondPath = path === "" ? "1" : `${path}.1`;

    if (node.direction === "horizontal") {
      const firstWidth = width * ratio;
      const secondLeft = left + firstWidth;
      const secondWidth = width - firstWidth;
      dividers.push({
        path,
        direction: "horizontal",
        ratio,
        branchLeft: left,
        branchTop: top,
        branchWidth: width,
        branchHeight: height,
        lineLeft: secondLeft,
        lineTop: top,
        lineWidth: 0,
        lineHeight: height,
      });
      walk(node.first, left, top, firstWidth, height, firstPath);
      walk(node.second, secondLeft, top, secondWidth, height, secondPath);
      return;
    }

    const firstHeight = height * ratio;
    const secondTop = top + firstHeight;
    const secondHeight = height - firstHeight;
    dividers.push({
      path,
      direction: "vertical",
      ratio,
      branchLeft: left,
      branchTop: top,
      branchWidth: width,
      branchHeight: height,
      lineLeft: left,
      lineTop: secondTop,
      lineWidth: width,
      lineHeight: 0,
    });
    walk(node.first, left, top, width, firstHeight, firstPath);
    walk(node.second, left, secondTop, width, secondHeight, secondPath);
  };

  walk(tree, 0, 0, 1, 1, "");
  return { leaves, dividers };
}
