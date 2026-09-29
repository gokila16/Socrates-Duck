/**
 * How the local profile turns stored session records into levels and one
 * recommendation. Every threshold lives here so it is easy to change later.
 *
 * The profile describes activity seen in Socrates' Duck, not ability. An area is
 * only assessed from signals the extension actually observes; the rest say
 * "Not enough information".
 */

import type {
  AreaView,
  ProfileView,
  RecommendationView,
  SkillArea,
  SkillLevel,
} from "../../shared/protocol";
import type { SessionRecord } from "./record";

/** How many of the most recent relevant sessions an area looks at. */
export const RECENT_SESSIONS = 8;

/** Fewer relevant sessions than this and an area is not assessed. */
export const MIN_SESSIONS = 3;

/** Needed help in at least this share of recent sessions: "Emerging". */
export const EMERGING_SHARE = 2 / 3;

/** Needed help in at most this share of recent sessions: "Independent". */
export const INDEPENDENT_SHARE = 1 / 4;

/** A recommendation needs the behaviour in at least this many sessions. */
export const MIN_OCCURRENCES = 2;

/** Rung 4 is "suspicious code region". */
export const LOCALIZING_LEVEL = 4;

/** Rung 5 is "incorrect assumption to reconsider". */
export const ASSUMPTION_LEVEL = 5;

/** Rungs 1–3 point at no code, so a fix after them was found by the developer. */
export const INDEPENDENT_MAX_LEVEL = 3;

type SessionFacts = Omit<SessionRecord, "areas">;

interface AreaRule {
  area: SkillArea;
  label: string;
  /** null when the extension has no defensible signal for this area yet. */
  measured: {
    relevant: (session: SessionFacts) => boolean;
    neededHelp: (session: SessionFacts) => boolean;
    evidence: (needed: number, total: number) => string;
    tryNext: string;
  } | null;
  unmeasuredReason?: string;
}

function madeProgress(session: SessionFacts): boolean {
  return session.resolution === "yes" || session.resolution === "partially";
}

function answered(session: SessionFacts): boolean {
  return madeProgress(session) || session.resolution === "no";
}

/** Relevant when the rung was needed, or when the developer got somewhere without it. */
function neededLevel(level: number) {
  return {
    relevant: (session: SessionFacts) =>
      session.highestLevel >= level || madeProgress(session),
    neededHelp: (session: SessionFacts) => session.highestLevel >= level,
  };
}

/** In display order; ties in the recommendation go to the earlier area. */
export const AREA_RULES: readonly AreaRule[] = [
  {
    area: "reading_errors",
    label: "Reading errors",
    measured: null,
    unmeasuredReason:
      "Socrates' Duck can't yet tell how you read an error, so it doesn't guess.",
  },
  {
    area: "localizing_bugs",
    label: "Localizing bugs",
    measured: {
      ...neededLevel(LOCALIZING_LEVEL),
      evidence: (needed, total) =>
        `Needed a hint pointing at a code region (level ${LOCALIZING_LEVEL} or higher) in ${needed} of ${total} recent sessions.`,
      tryNext:
        "During your next problem, find the first line where a value stops being what you expect before changing any code.",
    },
  },
  {
    area: "forming_hypotheses",
    label: "Forming hypotheses",
    measured: null,
    unmeasuredReason:
      "Your guesses are written in your own words, and Socrates' Duck doesn't score them.",
  },
  {
    area: "testing_assumptions",
    label: "Testing assumptions",
    measured: {
      ...neededLevel(ASSUMPTION_LEVEL),
      evidence: (needed, total) =>
        `Needed a hint naming an assumption to reconsider (level ${ASSUMPTION_LEVEL} or higher) in ${needed} of ${total} recent sessions.`,
      tryNext:
        "Before your next change, write down one thing you assume about the code, then print or check it.",
    },
  },
  {
    area: "solving_independently",
    label: "Solving independently",
    measured: {
      relevant: answered,
      neededHelp: (session) =>
        !(
          session.resolution === "yes" &&
          session.highestLevel <= INDEPENDENT_MAX_LEVEL &&
          session.hints.stuck === 0
        ),
      evidence: (needed, total) =>
        `Fixed it with hints at level ${INDEPENDENT_MAX_LEVEL} or below, without "I feel stuck", in ${total - needed} of ${total} recent sessions.`,
      tryNext:
        "Before asking for a stronger hint, write down your current guess and check one thing that could prove it wrong.",
    },
  },
];

export const SKILL_AREAS: readonly SkillArea[] = AREA_RULES.map((rule) => rule.area);

/** Which areas one session gives evidence about. */
export function applicableAreas(session: SessionFacts): SkillArea[] {
  return AREA_RULES.filter((rule) => rule.measured?.relevant(session) ?? false).map(
    (rule) => rule.area,
  );
}

interface Assessment {
  view: AreaView;
  needed: number;
  total: number;
  tryNext: string | null;
}

function levelFor(needed: number, total: number): SkillLevel {
  if (total < MIN_SESSIONS) {
    return "not_enough_information";
  }

  const share = needed / total;

  if (share >= EMERGING_SHARE) {
    return "emerging";
  }

  return share <= INDEPENDENT_SHARE ? "independent" : "developing";
}

function assess(rule: AreaRule, newestFirst: readonly SessionRecord[]): Assessment {
  const measured = rule.measured;

  if (measured === null) {
    return {
      view: {
        area: rule.area,
        label: rule.label,
        level: "not_enough_information",
        evidence: rule.unmeasuredReason ?? "",
      },
      needed: 0,
      total: 0,
      tryNext: null,
    };
  }

  const recent = newestFirst
    .filter((session) => session.areas.includes(rule.area))
    .slice(0, RECENT_SESSIONS);
  const needed = recent.filter(measured.neededHelp).length;
  const level = levelFor(needed, recent.length);

  return {
    view: {
      area: rule.area,
      label: rule.label,
      level,
      evidence:
        level === "not_enough_information"
          ? `${recent.length} relevant ${recent.length === 1 ? "session" : "sessions"} so far; ${MIN_SESSIONS} are needed before a level is shown.`
          : measured.evidence(needed, recent.length),
    },
    needed,
    total: recent.length,
    tryNext: measured.tryNext,
  };
}

/** At most one area: assessed, not independent, seen more than once, highest share. */
function recommend(assessments: readonly Assessment[]): RecommendationView | null {
  let best: Assessment | null = null;

  for (const candidate of assessments) {
    const { level } = candidate.view;

    if (
      candidate.tryNext === null ||
      (level !== "emerging" && level !== "developing") ||
      candidate.needed < MIN_OCCURRENCES
    ) {
      continue;
    }

    if (best === null || candidate.needed / candidate.total > best.needed / best.total) {
      best = candidate;
    }
  }

  if (best === null || best.tryNext === null) {
    return null;
  }

  return {
    area: best.view.area,
    label: best.view.label,
    reason:
      "Of the areas with enough sessions, this is where you most often needed a stronger hint.",
    evidence: best.view.evidence,
    tryNext: best.tryNext,
  };
}

/** Sessions are stored oldest first. */
export function assessProfile(
  sessions: readonly SessionRecord[],
  notice: string | null = null,
): ProfileView {
  const newestFirst = [...sessions].reverse();
  const assessments = AREA_RULES.map((rule) => assess(rule, newestFirst));

  return {
    sessionCount: sessions.length,
    areas: assessments.map((assessment) => assessment.view),
    recommendation: recommend(assessments),
    notice,
  };
}
