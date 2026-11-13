/**
 * Antigravity native-model observation cache (the Cursor pattern).
 *
 * The agent's `session/new` result carries the model selector the signed-in
 * Google account may actually use — the ONLY authoritative source: plan
 * gating is decided by the agent per auth method (a Claude id the account
 * lacks is refused with -32602), not by the quota endpoints. Every
 * `session/new` the daemon already issues (each inference turn, and the
 * sign-in flow's own spawn) records it here; automatic model discovery reads
 * it and never spawns the agent, so no extra probe ever fires.
 *
 * Keyed by a hash of the token file's refresh token, so a sign-in to another
 * account never inherits the previous account's list.
 */
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { TProviderModelEntry } from "@openllmsh/sdk/protocol";
import { antigravityTokenPath } from "./antigravity-acp";

type TObservation = {
  readonly identity: string;
  readonly entries: ReadonlyArray<TProviderModelEntry>;
  readonly recordedAtMs: number;
};

/** Freshness limit for persisted model observations from disk (1 hour). */
export const ANTIGRAVITY_OBSERVATION_FRESHNESS_MS = 60 * 60 * 1000;

const cacheFile = (geminiHome: string): string =>
  join(geminiHome, "models_cache.json");

export type TAntigravityModelObservationStore = {
  readonly record: (
    geminiHome: string,
    rows: ReadonlyArray<{
      readonly value: string;
      readonly name: string | null;
    }>,
  ) => void;
  readonly read: (
    geminiHome: string,
  ) => ReadonlyArray<TProviderModelEntry> | null;
  readonly clear: (geminiHome?: string) => void;
};

/** Stable identity of the current sign-in, or null when not signed in. */
export const antigravitySignInIdentity = (
  geminiHome: string,
): string | null => {
  try {
    const raw = JSON.parse(
      readFileSync(antigravityTokenPath(geminiHome), "utf8"),
    ) as { readonly refresh_token?: unknown };
    if (typeof raw.refresh_token !== "string" || raw.refresh_token === "") {
      return null;
    }
    return createHash("sha256").update(raw.refresh_token).digest("hex");
  } catch {
    return null;
  }
};

export const createAntigravityModelObservationStore =
  (): TAntigravityModelObservationStore => {
    let observation: TObservation | null = null;

    const clear = (geminiHome?: string): void => {
      observation = null;
      if (geminiHome !== undefined && geminiHome.length > 0) {
        try {
          const file = cacheFile(geminiHome);
          if (existsSync(file)) unlinkSync(file);
        } catch {
          // best-effort cache cleanup
        }
      }
    };

    const record = (
      geminiHome: string,
      rows: ReadonlyArray<{
        readonly value: string;
        readonly name: string | null;
      }>,
    ): void => {
      const identity = antigravitySignInIdentity(geminiHome);
      if (identity === null) {
        clear(geminiHome);
        return;
      }
      if (rows.length === 0) return;
      const entries = rows.map((row) => ({
        provider_model_id: row.value,
        ...(row.name !== null ? { display_name: row.name } : {}),
      }));
      const now = Date.now();
      observation = {
        identity,
        entries,
        recordedAtMs: now,
      };
      try {
        mkdirSync(geminiHome, { recursive: true, mode: 0o700 });
        writeFileSync(
          cacheFile(geminiHome),
          JSON.stringify({
            identity,
            entries,
            recordedAtMs: now,
          }),
          "utf8",
        );
      } catch {
        // memory observation still holds
      }
    };

    const read = (
      geminiHome: string,
    ): ReadonlyArray<TProviderModelEntry> | null => {
      const identity = antigravitySignInIdentity(geminiHome);
      if (identity === null) {
        clear(geminiHome);
        return null;
      }
      if (
        observation !== null &&
        identity === observation.identity &&
        Date.now() - observation.recordedAtMs <=
          ANTIGRAVITY_OBSERVATION_FRESHNESS_MS
      ) {
        return observation.entries;
      }
      try {
        const file = cacheFile(geminiHome);
        if (existsSync(file)) {
          const parsed = JSON.parse(readFileSync(file, "utf8")) as {
            readonly identity?: unknown;
            readonly entries?: unknown;
            readonly recordedAtMs?: unknown;
          };
          const ageMs =
            typeof parsed.recordedAtMs === "number" &&
            Number.isFinite(parsed.recordedAtMs)
              ? Date.now() - parsed.recordedAtMs
              : Infinity;
          if (ageMs > ANTIGRAVITY_OBSERVATION_FRESHNESS_MS) {
            clear(geminiHome);
            return null;
          }
          if (
            parsed.identity === identity &&
            Array.isArray(parsed.entries) &&
            parsed.entries.length > 0 &&
            parsed.entries.every(
              (e: unknown): e is TProviderModelEntry =>
                e !== null &&
                typeof e === "object" &&
                typeof (e as { provider_model_id?: unknown })
                  .provider_model_id === "string" &&
                (e as { provider_model_id: string }).provider_model_id.length >
                  0 &&
                ((e as { display_name?: unknown }).display_name ===
                  undefined ||
                  typeof (e as { display_name?: unknown }).display_name ===
                    "string"),
            )
          ) {
            observation = {
              identity,
              entries: parsed.entries,
              recordedAtMs:
                typeof parsed.recordedAtMs === "number"
                  ? parsed.recordedAtMs
                  : Date.now(),
            };
            return observation.entries;
          }
        }
      } catch {
        // fallback to null on read error
      }
      return null;
    };

    return { record, read, clear };
  };

const defaultStore = createAntigravityModelObservationStore();

/** Record the selector rows from a `session/new` result. */
export const recordAntigravityModels = (
  geminiHome: string,
  rows: ReadonlyArray<{ readonly value: string; readonly name: string | null }>,
): void => {
  defaultStore.record(geminiHome, rows);
};

/** The observed list for the CURRENT sign-in, or null (never observed). */
export const readAntigravityModels = (
  geminiHome: string,
): ReadonlyArray<TProviderModelEntry> | null => {
  return defaultStore.read(geminiHome);
};

/** Clear the model observation cache in memory and on disk. */
export const clearAntigravityModels = (geminiHome: string): void => {
  defaultStore.clear(geminiHome);
};
