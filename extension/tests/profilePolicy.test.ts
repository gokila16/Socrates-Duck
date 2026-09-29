/** Levels, minimum samples, and the recommendation. */

import { describe, expect, it } from "vitest";

import type { Resolution, SkillArea } from "../shared/protocol";
import {
  assessProfile,
  MIN_SESSIONS,
  RECENT_SESSIONS,
} from "../src/profile/policy";
import {
  buildSessionRecord,
  startTally,
  withHint,
  type SessionRecord,
} from "../src/profile/record";

const START = Date.parse("2026-09-28T10:00:00Z");

/** A finished session that climbed normally to `level`. */
function session(
  level: number,
  resolution: Resolution = "yes",
  options: { stuck?: boolean } = {},
): SessionRecord {
  let tally = startTally(START, false);

  for (let rung = 1; rung <= level; rung += 1) {
    tally = withHint(tally, "normal", rung);
  }

  if (options.stuck === true) {
    tally = withHint(tally, "stuck", Math.max(level, 6));
  }

  return buildSessionRecord(tally, START + 60_000, "completed", resolution);
}

function area(sessions: SessionRecord[], name: SkillArea) {
  const found = assessProfile(sessions).areas.find((view) => view.area === name);

  if (found === undefined) {
    throw new Error(`no ${name} in the profile`);
  }

  return found;
}

describe("areas without a defensible signal", () => {
  it.each(["reading_errors", "forming_hypotheses"] as const)(
    "always shows %s as Not enough information, with a reason",
    (name) => {
      const many = Array.from({ length: 10 }, () => session(5));
      const view = area(many, name);

      expect(view.level).toBe("not_enough_information");
      expect(view.evidence).not.toBe("");
    },
  );
});

describe("minimum sample", () => {
  it("shows Not enough information below the minimum, saying how many it has", () => {
    const view = area([session(5), session(5)], "localizing_bugs");

    expect(view.level).toBe("not_enough_information");
    expect(view.evidence).toBe(
      `2 relevant sessions so far; ${MIN_SESSIONS} are needed before a level is shown.`,
    );
  });

  it("assesses an area once it reaches the minimum", () => {
    const view = area([session(5), session(5), session(5)], "localizing_bugs");

    expect(view.level).not.toBe("not_enough_information");
  });

  it("does not count unanswered sessions that never reached the rung", () => {
    const quiet = [session(2, "skipped"), session(2, "not_asked"), session(2, "no")];

    expect(area(quiet, "localizing_bugs").level).toBe("not_enough_information");
  });

  it("gives an empty profile no levels and no recommendation", () => {
    const profile = assessProfile([]);

    expect(profile.sessionCount).toBe(0);
    expect(profile.areas.every((view) => view.level === "not_enough_information")).toBe(true);
    expect(profile.recommendation).toBeNull();
  });
});

describe("level calculation", () => {
  it("is Emerging when a stronger hint was needed in most recent sessions", () => {
    const view = area([session(4), session(4), session(2)], "localizing_bugs");

    expect(view.level).toBe("emerging");
    expect(view.evidence).toBe(
      "Needed a hint pointing at a code region (level 4 or higher) in 2 of 3 recent sessions.",
    );
  });

  it("is Developing in between", () => {
    const view = area([session(4), session(4), session(2), session(2)], "localizing_bugs");

    expect(view.level).toBe("developing");
  });

  it("is Independent when the stronger hint was rarely needed", () => {
    const view = area(
      [session(4), session(2), session(2), session(1)],
      "localizing_bugs",
    );

    expect(view.level).toBe("independent");
  });

  it("looks only at the most recent sessions", () => {
    const old = Array.from({ length: 10 }, () => session(6));
    const recent = Array.from({ length: RECENT_SESSIONS }, () => session(2));

    const view = area([...old, ...recent], "localizing_bugs");

    expect(view.level).toBe("independent");
    expect(view.evidence).toContain(`0 of ${RECENT_SESSIONS}`);
  });

  it("counts I feel stuck against solving independently", () => {
    const sessions = [
      session(2, "yes", { stuck: true }),
      session(2, "yes", { stuck: true }),
      session(2, "yes"),
    ];

    expect(area(sessions, "solving_independently").evidence).toBe(
      'Fixed it with hints at level 3 or below, without "I feel stuck", in 1 of 3 recent sessions.',
    );
  });

  it("does not count a Partially as solving independently", () => {
    const sessions = [session(1, "partially"), session(1, "partially"), session(1, "no")];

    expect(area(sessions, "solving_independently").level).toBe("emerging");
  });

  it("never shows a numeric score", () => {
    const profile = assessProfile([session(4), session(5), session(2)]);

    for (const view of profile.areas) {
      expect(view.evidence).not.toMatch(/\d+\s*\/\s*100|%/);
    }
  });
});

describe("recommendation", () => {
  it("picks the assessed area where help was needed most often", () => {
    const sessions = [session(5), session(5), session(4), session(2)];

    const recommendation = assessProfile(sessions).recommendation;

    expect(recommendation?.area).toBe("localizing_bugs");
    expect(recommendation?.evidence).toContain("3 of 4");
    expect(recommendation?.tryNext).not.toBe("");
    expect(recommendation?.reason).not.toBe("");
  });

  it("breaks a tie by the fixed area order", () => {
    const sessions = [session(5), session(5), session(5)];

    expect(assessProfile(sessions).recommendation?.area).toBe("localizing_bugs");
  });

  it("needs the behaviour more than once", () => {
    const sessions = [session(4), session(1), session(1)];
    const profile = assessProfile(sessions);

    expect(area(sessions, "localizing_bugs").level).toBe("developing");
    expect(profile.recommendation).toBeNull();
  });

  it("needs the minimum number of sessions", () => {
    const sessions = [session(6, "no"), session(6, "no")];

    expect(assessProfile(sessions).recommendation).toBeNull();
  });

  it("does not recommend an Independent area", () => {
    const sessions = Array.from({ length: 8 }, (_, index) => session(index < 2 ? 4 : 1));

    expect(area(sessions, "localizing_bugs").level).toBe("independent");
    expect(assessProfile(sessions).recommendation?.area).not.toBe("localizing_bugs");
  });
});

describe("unknown skill categories", () => {
  it("ignores an area it does not know", () => {
    const odd = { ...session(5), areas: ["guessing" as SkillArea] };

    expect(area([odd, odd, odd], "localizing_bugs").level).toBe("not_enough_information");
  });
});
