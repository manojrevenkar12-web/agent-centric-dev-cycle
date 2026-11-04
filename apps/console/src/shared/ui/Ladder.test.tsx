import { act, render, screen } from "@testing-library/react";
import { describe as describeEvent } from "../../features/loop/LoopScreen";
import { Ladder } from "./Ladder";

test("the ladder puts most autonomy on top and marks where a change landed", async () => {
  vi.useFakeTimers();
  render(
    <Ladder
      label="Autonomy"
      rows={[{ level: "agent_reviewed", note: "the issue allowed" }]}
      marker={{ from: "agent_reviewed", to: "agent_draft" }}
    />,
  );
  const rungs = screen.getAllByRole("listitem");
  expect(rungs.map((r) => r.getAttribute("data-level"))).toEqual([
    "auto_approvable",
    "agent_reviewed",
    "agent_draft",
    "human_only",
  ]);
  expect(rungs[2]?.getAttribute("aria-current")).toBe("step");
  expect(rungs[1]?.querySelector(".marker")).not.toBeNull(); // starts where the issue allowed
  await act(async () => {
    vi.advanceTimersByTime(1000);
  });
  expect(rungs[2]?.querySelector(".marker")).not.toBeNull(); // and drops to where the change landed
  vi.useRealTimers();
});

test("events read as sentences", () => {
  expect(describeEvent("pr_opened", { pr: 12, draft: true })).toBe("Pull request #12 opened as a draft");
  expect(describeEvent("preflight", { allowed: false, category: "security" })).toBe(
    "Preflight: security work is for a person",
  );
  expect(describeEvent("review", { reviewer: "ana", state: "changes_requested" })).toBe(
    "Review by ana: changes requested",
  );
});
