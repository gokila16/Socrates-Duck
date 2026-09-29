/**
 * The local profile, kept in VS Code's globalState under a versioned schema.
 * Nothing here throws: the profile must never get in the way of a session.
 */

import type { Resolution, SkillArea } from "../../shared/protocol";
import { assessProfile, SKILL_AREAS } from "./policy";
import type { SessionRecord } from "./record";

export const PROFILE_KEY = "socratesDuck.profile";
export const PROFILE_VERSION = 1;

/** Oldest sessions are dropped beyond this. */
export const MAX_STORED_SESSIONS = 50;

/** The part of vscode.Memento the store uses, so tests can pass a plain object. */
export interface KeyValueStore {
  get(key: string): unknown;
  update(key: string, value: unknown): PromiseLike<void>;
}

export interface LoadedProfile {
  sessions: SessionRecord[];
  notice: string | null;
  /** False when the saved data is from a newer version and must not be overwritten. */
  writable: boolean;
}

const UNREADABLE = "Your saved profile couldn't be read, so it starts fresh.";
const NEWER =
  "Your profile was saved by a newer version of Socrates' Duck, so it is left untouched.";
const SKIPPED = "Some saved sessions couldn't be read and were left out.";
const LOAD_FAILED =
  "Your saved profile couldn't be read just now. Nothing was changed; try again later.";

/** The top rung of the hint ladder. */
const MAX_HINT_LEVEL = 8;

/** Validates what was stored; anything unexpected is dropped rather than trusted. */
export function parseProfile(raw: unknown): LoadedProfile {
  if (raw === undefined) {
    return { sessions: [], notice: null, writable: true };
  }

  if (typeof raw !== "object" || raw === null) {
    return { sessions: [], notice: UNREADABLE, writable: true };
  }

  const stored = raw as Record<string, unknown>;
  const version = stored["version"];

  if (typeof version === "number" && Number.isInteger(version) && version > PROFILE_VERSION) {
    return { sessions: [], notice: NEWER, writable: false };
  }

  // Version 1 is the only schema so far. When it changes, migrate older
  // versions here, one case per version, before the records are checked.
  if (version !== PROFILE_VERSION || !Array.isArray(stored["sessions"])) {
    return { sessions: [], notice: UNREADABLE, writable: true };
  }

  const entries: unknown[] = stored["sessions"];
  const sessions = entries
    .map(parseRecord)
    .filter((record): record is SessionRecord => record !== null);

  return {
    sessions,
    notice: sessions.length < entries.length ? SKIPPED : null,
    writable: true,
  };
}

const RESOLUTIONS: readonly Resolution[] = [
  "yes",
  "partially",
  "no",
  "skipped",
  "not_asked",
];

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function counts<K extends string>(value: unknown, keys: readonly K[]): Record<K, number> | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  const source = value as Record<string, unknown>;
  const result = {} as Record<K, number>;

  for (const key of keys) {
    const count = source[key];

    if (!isCount(count)) {
      return null;
    }

    result[key] = count;
  }

  return result;
}

/** Copies known fields only, so nothing unexpected survives into the profile. */
function parseRecord(value: unknown): SessionRecord | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  const record = value as Record<string, unknown>;
  const {
    endedAt,
    durationSeconds,
    status,
    resolution,
    highestLevel,
    questions,
    evidenceSupplied,
    areas,
  } = record;
  const hints = counts(record["hints"], ["normal", "stronger", "stuck"] as const);
  const reports = counts(record["reports"], [
    "resolved",
    "still_stuck",
    "different_error",
  ] as const);

  if (
    typeof endedAt !== "string" ||
    Number.isNaN(Date.parse(endedAt)) ||
    !isCount(durationSeconds) ||
    (status !== "completed" && status !== "abandoned") ||
    !RESOLUTIONS.includes(resolution as Resolution) ||
    !isCount(highestLevel) ||
    highestLevel > MAX_HINT_LEVEL ||
    !isCount(questions) ||
    typeof evidenceSupplied !== "boolean" ||
    !Array.isArray(areas) ||
    hints === null ||
    reports === null
  ) {
    return null;
  }

  return {
    endedAt,
    durationSeconds,
    status,
    resolution: resolution as Resolution,
    hints,
    highestLevel,
    reports,
    questions,
    evidenceSupplied,
    // An area this version doesn't know is ignored, not guessed at.
    areas: areas.filter((area): area is SkillArea => SKILL_AREAS.includes(area as SkillArea)),
  };
}

/** Names the kind of failure without its message, which could carry anything. */
function failureName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

export class ProfileStore {
  public constructor(
    private readonly storage: KeyValueStore,
    private readonly warn: (message: string) => void = (message) => console.warn(message),
  ) {}

  public load(): LoadedProfile {
    try {
      return parseProfile(this.storage.get(PROFILE_KEY));
    } catch (error) {
      this.warn(`Socrates' Duck profile: load failed (${failureName(error)})`);

      return { sessions: [], notice: LOAD_FAILED, writable: false };
    }
  }

  /** Adds one finished session. Returns false, without throwing, if it wasn't saved. */
  public async append(record: SessionRecord): Promise<boolean> {
    const loaded = this.load();

    if (!loaded.writable) {
      this.warn("Socrates' Duck profile: not saved, stored profile is not writable");

      return false;
    }

    const sessions = [...loaded.sessions, record].slice(-MAX_STORED_SESSIONS);

    return this.write({ version: PROFILE_VERSION, sessions });
  }

  public async reset(): Promise<boolean> {
    return this.write(undefined);
  }

  /** The derived profile as JSON: records plus the summary the panel shows. */
  public exportJson(now: Date): string {
    const loaded = this.load();

    return JSON.stringify(
      {
        format: "socrates-duck-profile",
        version: PROFILE_VERSION,
        exportedAt: now.toISOString(),
        note: "A summary of activity observed in Socrates' Duck on this machine, not an assessment of ability.",
        summary: assessProfile(loaded.sessions),
        sessions: loaded.sessions,
      },
      null,
      2,
    );
  }

  private async write(value: unknown): Promise<boolean> {
    try {
      await this.storage.update(PROFILE_KEY, value);

      return true;
    } catch (error) {
      this.warn(`Socrates' Duck profile: save failed (${failureName(error)})`);

      return false;
    }
  }
}
