/** Turning what the host counted during a session into a profile record. */

import { describe, expect, it } from "vitest";

import {
  buildSessionRecord,
  startTally,
  withHint,
  withQuestion,
  withReport,
} from "../src/profile/record";

const START = Date.parse("2026-09-28T10:00:00Z");

function busySession() {
  let tally = startTally(START, true);
  tally = withHint(tally, "normal", 1);
  tally = withHint(tally, "stronger", 2);
  tally = withReport(tally, "still_stuck");
  tally = withHint(tally, "normal", 3);
  tally = withQuestion(tally);
  tally = withHint(tally, "stuck", 6);
  tally = withReport(tally, "resolved");

  return tally;
}

describe("buildSessionRecord", () => {
  it("counts hints by kind, reports by outcome, and questions", () => {
    const record = buildSessionRecord(busySession(), START + 90_000, "completed", "yes");

    expect(record.hints).toEqual({ normal: 2, stronger: 1, stuck: 1 });
    expect(record.reports).toEqual({ resolved: 1, still_stuck: 1, different_error: 0 });
    expect(record.questions).toBe(1);
    expect(record.highestLevel).toBe(6);
  });

  it("records the duration in whole seconds and when it ended", () => {
    const record = buildSessionRecord(busySession(), START + 90_400, "completed", "yes");

    expect(record.durationSeconds).toBe(90);
    expect(record.endedAt).toBe("2026-09-28T10:01:30.400Z");
  });

  it("never records a negative duration if the clock moved backwards", () => {
    const record = buildSessionRecord(startTally(START, false), START - 5_000, "abandoned", "not_asked");

    expect(record.durationSeconds).toBe(0);
  });

  it("does not change the tally it was built from", () => {
    const tally = startTally(START, false);
    withHint(tally, "normal", 1);

    expect(tally.hints.normal).toBe(0);
    expect(tally.highestLevel).toBe(0);
  });

  it("tags the areas the session gives evidence about", () => {
    const record = buildSessionRecord(busySession(), START + 1_000, "completed", "yes");

    expect(record.areas).toEqual([
      "localizing_bugs",
      "testing_assumptions",
      "solving_independently",
    ]);
  });

  it("tags nothing for a session closed early without an answer", () => {
    const tally = withHint(startTally(START, false), "normal", 1);
    const record = buildSessionRecord(tally, START + 1_000, "abandoned", "not_asked");

    expect(record.areas).toEqual([]);
  });

  it("holds only derived fields: no text, file names, or session ids", () => {
    const record = buildSessionRecord(busySession(), START + 1_000, "completed", "partially");

    expect(Object.keys(record).sort()).toEqual([
      "areas",
      "durationSeconds",
      "endedAt",
      "evidenceSupplied",
      "highestLevel",
      "hints",
      "questions",
      "reports",
      "resolution",
      "status",
    ]);
  });
});
