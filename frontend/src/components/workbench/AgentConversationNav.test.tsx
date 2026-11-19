import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createRef, useRef } from "react";
import { AgentScrollToLatest, AgentTurnTimeline, magnetStrength, type TurnTimelineHandle } from "./AgentConversationNav";
import type { ConversationTurn } from "@/lib/agentConversationNav";

afterEach(cleanup);

const turns: ConversationTurn[] = [0, 1, 2].map((index) => ({ index, userMessageId: `u${index}`, question: `问题 ${index + 1}`, answer: `回答 ${index + 1}` }));

function Harness({ handle, onJump, list = turns }: { handle?: React.Ref<TurnTimelineHandle>; onJump?: () => void; list?: ConversationTurn[] }) {
  const scroller = useRef<HTMLDivElement>(null);
  return (
    <div>
      <div ref={scroller}>
        {list.map((turn) => <div key={turn.userMessageId} data-turn-index={turn.index}>{turn.question}</div>)}
      </div>
      <AgentTurnTimeline ref={handle} scrollerRef={scroller} turns={list} onJump={onJump} />
    </div>
  );
}

describe("AgentTurnTimeline", () => {
  it("is hidden for a single turn", () => {
    render(<Harness list={turns.slice(0, 1)} />);
    expect(screen.queryByTestId("agent-turn-rail")).toBeNull();
  });

  it("renders one tick per turn, previews on focus, and moves with the arrow keys", () => {
    const onJump = vi.fn();
    render(<Harness onJump={onJump} />);
    const ticks = screen.getAllByRole("button");
    expect(ticks).toHaveLength(3);
    expect(ticks[1].getAttribute("aria-label")).toBe("第 2 轮：问题 2");
    ticks[0].focus();
    fireEvent.focus(ticks[0]);
    expect(screen.getByRole("tooltip").textContent).toContain("回答 1");
    fireEvent.keyDown(ticks[0], { key: "ArrowDown" });
    expect(document.activeElement).toBe(ticks[1]);
    expect(onJump).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(ticks[1], { key: "End" });
    expect(document.activeElement).toBe(ticks[2]);
    expect(ticks[2].getAttribute("aria-current")).toBe("true");
  });

  it("steps through turns from the panel shortcut handle", () => {
    const handle = createRef<TurnTimelineHandle>();
    const onJump = vi.fn();
    render(<Harness handle={handle} onJump={onJump} />);
    handle.current?.step(-1);
    expect(onJump).toHaveBeenCalled();
  });

  it("magnet strength fades with distance", () => {
    expect(magnetStrength(0)).toBe(1);
    expect(magnetStrength(40)).toBe(0);
    expect(magnetStrength(Number.NaN)).toBe(0);
  });
});

describe("AgentScrollToLatest", () => {
  it("only shows when away from the bottom", () => {
    const onClick = vi.fn();
    const { rerender } = render(<AgentScrollToLatest visible={false} onClick={onClick} />);
    expect(screen.queryByTestId("agent-scroll-latest")).toBeNull();
    rerender(<AgentScrollToLatest visible onClick={onClick} />);
    fireEvent.click(screen.getByTestId("agent-scroll-latest"));
    expect(onClick).toHaveBeenCalled();
  });
});
