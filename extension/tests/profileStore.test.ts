/** Storage schema, validation, reset, export, and storage failures. */

import { describe, expect, it } from "vitest";

import {
  MAX_STORED_SESSIONS,
  parseProfile,
  PROFILE_KEY,
  PROFILE_VERSION,
  ProfileStore,
  type KeyValueStore,
} from "../src/profile/store";
import {
  buildSessionRecord,
  startTally,
  withHint,
  type SessionRecord,
} from "../src/profile/record";

const START = Date.parse("2026-09-28T10:00:00Z");

function record(level = 4): SessionRecord {
  return buildSessionRecord(
    withHint(startTally(START, true), "normal", level),
    START + 30_000,
    "completed",
    "yes",
  );
}

/** An in-memory globalState. */
class FakeStorage implements KeyValueStore {
  public values = new Map<string, unknown>();
  public failWrites = false;
  public failReads = false;

  public get(key: string): unknown {
    if (this.failReads) {
      throw new Error("disk says /Users/dev/secret.py");
    }

    return this.values.get(key);
  }

  public update(key: string, value: unknown): Promise<void> {
    if (this.failWrites) {
      return Promise.reject(new Error("quota exceeded for /Users/dev/secret.py"));
    }

    if (value === undefined) {
      this.values.delete(key);
    } else {
      this.values.set(key, JSON.parse(JSON.stringify(value)));
    }

    return Promise.resolve();
  }
}

function storeWith(storage = new FakeStorage()) {
  const warnings: string[] = [];
  const store = new ProfileStore(storage, (message) => warnings.push(message));

  return { storage, store, warnings };
}

describe("storage schema", () => {
  it("starts empty when nothing was ever saved", () => {
    expect(parseProfile(undefined)).toEqual({ sessions: [], notice: null, writable: true });
  });

  it("saves under a versioned schema and reads it back", async () => {
    const { storage, store } = storeWith();

    expect(await store.append(record())).toBe(true);

    expect(storage.values.get(PROFILE_KEY)).toMatchObject({ version: PROFILE_VERSION });
    expect(store.load().sessions).toEqual([record()]);
  });

  it("keeps only the most recent sessions", async () => {
    const { store } = storeWith();

    for (let index = 0; index < MAX_STORED_SESSIONS + 5; index += 1) {
      await store.append(record());
    }

    expect(store.load().sessions).toHaveLength(MAX_STORED_SESSIONS);
  });

  it.each([
    ["a string", "hello"],
    ["no version", { sessions: [] }],
    ["version 0", { version: 0, sessions: [] }],
    ["sessions that are not a list", { version: 1, sessions: "many" }],
  ])("starts fresh, with a notice, from %s", (_name, raw) => {
    const loaded = parseProfile(raw);

    expect(loaded.sessions).toEqual([]);
    expect(loaded.notice).not.toBeNull();
    expect(loaded.writable).toBe(true);
  });

  it("leaves a profile from a newer version untouched", async () => {
    const newer = { version: PROFILE_VERSION + 1, sessions: [{ anything: true }] };
    const storage = new FakeStorage();
    storage.values.set(PROFILE_KEY, newer);
    const { store } = storeWith(storage);

    expect(store.load().writable).toBe(false);
    expect(await store.append(record())).toBe(false);
    expect(storage.values.get(PROFILE_KEY)).toEqual(newer);
  });

  it("drops invalid records and says some were skipped", () => {
    const loaded = parseProfile({
      version: 1,
      sessions: [record(), { ...record(), highestLevel: 12 }, { ...record(), status: "paused" }, null],
    });

    expect(loaded.sessions).toEqual([record()]);
    expect(loaded.notice).not.toBeNull();
  });

  it("drops fields it does not know, so stray content never survives", () => {
    const loaded = parseProfile({
      version: 1,
      sessions: [{ ...record(), problem: "def average(xs): ..." }],
    });

    expect(loaded.sessions[0]).not.toHaveProperty("problem");
  });

  it("drops unknown skill areas but keeps the record", () => {
    const loaded = parseProfile({
      version: 1,
      sessions: [{ ...record(), areas: ["localizing_bugs", "speed_typing", 7] }],
    });

    expect(loaded.sessions[0]?.areas).toEqual(["localizing_bugs"]);
  });
});

describe("reset and export", () => {
  it("reset removes every stored session", async () => {
    const { store } = storeWith();
    await store.append(record());

    expect(await store.reset()).toBe(true);
    expect(store.load().sessions).toEqual([]);
  });

  it("exports the derived records and summary as JSON", async () => {
    const { store } = storeWith();
    await store.append(record());

    const exported = JSON.parse(store.exportJson(new Date(START))) as Record<string, unknown>;

    expect(exported["format"]).toBe("socrates-duck-profile");
    expect(exported["version"]).toBe(PROFILE_VERSION);
    expect(exported["exportedAt"]).toBe("2026-09-28T10:00:00.000Z");
    expect(exported["sessions"]).toEqual([record()]);
    expect(exported["summary"]).toMatchObject({ sessionCount: 1 });
    expect(exported["note"]).toContain("not an assessment");
  });
});

describe("storage failures", () => {
  it("reports a failed write without throwing", async () => {
    const { storage, store, warnings } = storeWith();
    storage.failWrites = true;

    await expect(store.append(record())).resolves.toBe(false);
    await expect(store.reset()).resolves.toBe(false);
    expect(warnings).toHaveLength(2);
  });

  it("reports a failed read without throwing, and refuses to overwrite", async () => {
    const { storage, store, warnings } = storeWith();
    storage.failReads = true;

    expect(store.load()).toMatchObject({ sessions: [], writable: false });
    expect(await store.append(record())).toBe(false);
    expect(warnings.length).toBeGreaterThan(0);
  });

  it("logs the kind of failure but never its message", async () => {
    const { storage, store, warnings } = storeWith();
    storage.failWrites = true;
    await store.append(record());

    expect(warnings.join("\n")).not.toContain("secret.py");
    expect(warnings.join("\n")).toContain("Error");
  });
});
