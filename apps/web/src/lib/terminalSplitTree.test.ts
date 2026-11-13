import { describe, expect, it } from "vite-plus/test";

import {
  computeTerminalSplitLayout,
  reconcileTerminalSplitTree,
  splitTerminalLeafInTree,
  summarizeSplitTreeDirections,
  updateTerminalSplitRatioAtPath,
} from "./terminalSplitTree";

describe("terminalSplitTree", () => {
  it("splits only the active leaf along the requested axis without flipping existing splits", () => {
    // Start with pane-1, split horizontally -> [pane-1 | pane-2]
    const horizontalSplit = splitTerminalLeafInTree({
      tree: { type: "leaf", terminalId: "pane-1" },
      existingTerminalIds: ["pane-1"],
      anchorTerminalId: "pane-1",
      newTerminalId: "pane-2",
      direction: "horizontal",
    });

    // Focus pane-2 (right side) and split vertically -> [pane-1 | (pane-2 / pane-3)]
    const nestedSplit = splitTerminalLeafInTree({
      tree: horizontalSplit,
      existingTerminalIds: ["pane-1", "pane-2"],
      anchorTerminalId: "pane-2",
      newTerminalId: "pane-3",
      direction: "vertical",
    });

    expect(summarizeSplitTreeDirections(nestedSplit)).toBe("mixed");

    const layout = computeTerminalSplitLayout(nestedSplit);
    expect(layout.leaves).toEqual([
      { terminalId: "pane-1", left: 0, top: 0, width: 0.5, height: 1 },
      { terminalId: "pane-2", left: 0.5, top: 0, width: 0.5, height: 0.5 },
      { terminalId: "pane-3", left: 0.5, top: 0.5, width: 0.5, height: 0.5 },
    ]);
    expect(layout.dividers).toHaveLength(2);
    expect(layout.dividers[0]).toMatchObject({
      path: "",
      direction: "horizontal",
      lineLeft: 0.5,
      lineTop: 0,
      lineHeight: 1,
    });
    expect(layout.dividers[1]).toMatchObject({
      path: "1",
      direction: "vertical",
      lineLeft: 0.5,
      lineTop: 0.5,
      lineWidth: 0.5,
    });
  });

  it("collapses only the closed leaf branch while preserving sibling split orientations", () => {
    const horizontalSplit = splitTerminalLeafInTree({
      tree: { type: "leaf", terminalId: "pane-1" },
      existingTerminalIds: ["pane-1"],
      anchorTerminalId: "pane-1",
      newTerminalId: "pane-2",
      direction: "horizontal",
    });
    const nestedSplit = splitTerminalLeafInTree({
      tree: horizontalSplit,
      existingTerminalIds: ["pane-1", "pane-2"],
      anchorTerminalId: "pane-2",
      newTerminalId: "pane-3",
      direction: "vertical",
    });

    // Close pane-1 -> pane-2 and pane-3 remain vertically stacked across the full canvas
    const afterClosingLeft = reconcileTerminalSplitTree(nestedSplit, ["pane-2", "pane-3"]);
    expect(summarizeSplitTreeDirections(afterClosingLeft)).toBe("vertical");
    expect(computeTerminalSplitLayout(afterClosingLeft).leaves).toEqual([
      { terminalId: "pane-2", left: 0, top: 0, width: 1, height: 0.5 },
      { terminalId: "pane-3", left: 0, top: 0.5, width: 1, height: 0.5 },
    ]);
  });

  it("updates nested branch split ratios and clamps bounds", () => {
    const tree = splitTerminalLeafInTree({
      tree: splitTerminalLeafInTree({
        tree: { type: "leaf", terminalId: "pane-1" },
        existingTerminalIds: ["pane-1"],
        anchorTerminalId: "pane-1",
        newTerminalId: "pane-2",
        direction: "horizontal",
      }),
      existingTerminalIds: ["pane-1", "pane-2"],
      anchorTerminalId: "pane-2",
      newTerminalId: "pane-3",
      direction: "vertical",
    });

    const resizedRoot = updateTerminalSplitRatioAtPath(tree, "", 0.3);
    const resizedNested = updateTerminalSplitRatioAtPath(resizedRoot, "1", 0.99);
    const layout = computeTerminalSplitLayout(resizedNested);

    expect(layout.leaves[0]).toMatchObject({ terminalId: "pane-1", width: 0.3 });
    expect(layout.leaves[1]).toMatchObject({
      terminalId: "pane-2",
      left: 0.3,
      width: 0.7,
      height: 0.85,
    });
    expect(layout.leaves[2]).toMatchObject({
      terminalId: "pane-3",
      left: 0.3,
      top: 0.85,
      width: 0.7,
    });
    expect(layout.leaves[2]?.height).toBeCloseTo(0.15, 6);
  });
});
