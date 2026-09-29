/**
 * What one finished session contributes to the local profile: derived numbers
 * only. No code, problem text, errors, hints, file names, or session ids.
 */

import type {
  HintKind,
  Outcome,
  Resolution,
  SkillArea,
} from "../../shared/protocol";
import { applicableAreas } from "./policy";

/** One finished session, as stored. */
export interface SessionRecord {
  endedAt: string;
  durationSeconds: number;
  status: "completed" | "abandoned";
  resolution: Resolution;
  hints: Record<HintKind, number>;
  highestLevel: number;
  reports: Record<Outcome, number>;
  questions: number;
  evidenceSupplied: boolean;
  /** The areas this session gives evidence about, decided when it ended. */
  areas: SkillArea[];
}

/** What the extension host counts while a session is running. */
export interface SessionTally {
  startedAt: number;
  evidenceSupplied: boolean;
  hints: Record<HintKind, number>;
  highestLevel: number;
  reports: Record<Outcome, number>;
  questions: number;
}

export function startTally(startedAt: number, evidenceSupplied: boolean): SessionTally {
  return {
    startedAt,
    evidenceSupplied,
    hints: { normal: 0, stronger: 0, stuck: 0 },
    highestLevel: 0,
    reports: { resolved: 0, still_stuck: 0, different_error: 0 },
    questions: 0,
  };
}

/** Counts a hint the developer actually received; failed requests never reach here. */
export function withHint(tally: SessionTally, kind: HintKind, level: number): SessionTally {
  return {
    ...tally,
    hints: { ...tally.hints, [kind]: tally.hints[kind] + 1 },
    highestLevel: Math.max(tally.highestLevel, level),
  };
}

export function withReport(tally: SessionTally, outcome: Outcome): SessionTally {
  return {
    ...tally,
    reports: { ...tally.reports, [outcome]: tally.reports[outcome] + 1 },
  };
}

export function withQuestion(tally: SessionTally): SessionTally {
  return { ...tally, questions: tally.questions + 1 };
}

export function buildSessionRecord(
  tally: SessionTally,
  endedAt: number,
  status: "completed" | "abandoned",
  resolution: Resolution,
): SessionRecord {
  const record: Omit<SessionRecord, "areas"> = {
    endedAt: new Date(endedAt).toISOString(),
    durationSeconds: Math.max(0, Math.round((endedAt - tally.startedAt) / 1000)),
    status,
    resolution,
    hints: { ...tally.hints },
    highestLevel: tally.highestLevel,
    reports: { ...tally.reports },
    questions: tally.questions,
    evidenceSupplied: tally.evidenceSupplied,
  };

  return { ...record, areas: applicableAreas(record) };
}
