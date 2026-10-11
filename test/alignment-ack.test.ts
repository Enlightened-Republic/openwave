import { expect, test } from "vitest";
import { AlignmentAckTracker } from "../src/alignment-ack.js";

test("alignment ack: only a real reply acks; memory-tool-only turns, empty replies and no-offer turns don't", () => {
  const t = new AlignmentAckTracker();
  expect(t.replied("a", "hi")).toBeNull(); // nothing offered
  t.offer("a", 7);
  t.toolCall("a", "tool_call", { id: "brain_status" });
  t.toolCall("a", "brain_list_goals", {});
  expect(t.replied("a", "TOOL brain_status RESULT")).toBeNull(); // memory tools only
  t.offer("a", 7);
  expect(t.replied("a", "   ")).toBeNull(); // empty reply
  t.offer("a", 7);
  t.toolCall("a", "tool_call", { id: "brain_query" });
  t.toolCall("a", "web_search", {});
  expect(t.replied("a", "Here's what I found")).toBe(7); // a real tool + reply
  expect(t.replied("a", "again")).toBeNull(); // cleared
  t.offer("b", 9);
  expect(t.replied("b", "Plain answer")).toBe(9);
  t.offer("c", 3); t.offer("c", null);
  expect(t.pending("c")).toBeUndefined();
});

test("0.3.0: several offered notes (alignment note + commitment nudge) are acked together", () => {
  const t = new AlignmentAckTracker();
  t.offer("a", [4, 5]);
  t.toolCall("a", "brain_status", {});
  expect(t.repliedAll("a", "TOOL brain_status RESULT")).toEqual([]);
  t.offer("a", [4, 5]);
  expect(t.repliedAll("a", "A real answer")).toEqual([4, 5]);
  t.offer("a", []);
  expect(t.pending("a")).toBeUndefined();
  t.offer("b", [9]);
  expect(t.replied("b", "ok")).toBe(9);
});
