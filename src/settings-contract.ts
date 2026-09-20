// Shared, browser-safe operation contract for openwave's Control UI settings
// page. Imported by both `src/index.ts` (backend handlers, registered via
// `api.session.controls.registerSessionAction`) and `src/control-ui.ts` (the
// native page, via `createFeatureClient` from `openclaw/plugin-sdk/feature-contract`).
//
// This file intentionally does NOT import anything from the `openclaw`
// package -- `src/index.ts` bundles this file into `dist/index.js` via
// openwave's own esbuild.mjs, and openwave deliberately avoids taking a
// build-time dependency on the (large) `openclaw` package for that bundle
// (see the comment above `definePluginEntry` in src/index.ts). The shape
// below is structurally compatible with `openclaw/plugin-sdk/feature-contract`'s
// `FeatureContract` type -- TypeScript checks that by structure, not by
// importing the type -- so `control-ui.ts` can still pass it straight into
// `createFeatureClient` unmodified.
//
// The tunable fields here are exactly the flat config keys already shipped
// in `openclaw.plugin.json` (contextBudget, workingMemorySlots, ...): today
// these are the only knobs that actually shape retrieval/consolidation
// behavior per agent. `emotionalProfile` (valenceBias/arousalScale) is
// accepted and stored ahead of time but has no runtime effect yet -- see
// research/emotional-memory-openclaw-integration.md proposal 3
// (sharpwave-core's valence/arousal split is not shipped). Do not wire a UI
// affordance that implies it already changes behavior.

import { Type, type Static } from "typebox";

export const PERSONA_OVERRIDE_FIELDS = Type.Object(
  {
    contextBudget: Type.Optional(Type.Number({ minimum: 0 })),
    workingMemorySlots: Type.Optional(Type.Number({ minimum: 1, maximum: 32 })),
    spreadingActivationHops: Type.Optional(Type.Number({ minimum: 0, maximum: 4 })),
    activationThreshold: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
    inhibitionStrength: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
    efDefault: Type.Optional(Type.Number({ minimum: 0 })),
    retrievabilityFloor: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
    consolidationTimeGateHours: Type.Optional(Type.Number({ minimum: 0 })),
    consolidationEpisodeGate: Type.Optional(Type.Number({ minimum: 0 })),
    pruneAfterDays: Type.Optional(Type.Number({ minimum: 0 })),
    emotionalProfile: Type.Optional(
      Type.Object(
        {
          valenceBias: Type.Optional(Type.Number({ minimum: -1, maximum: 1 })),
          arousalScale: Type.Optional(Type.Number({ minimum: 0, maximum: 2 })),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);
export type PersonaOverrideFields = Static<typeof PERSONA_OVERRIDE_FIELDS>;

const GetPersonaConfigInput = Type.Object({ agentId: Type.String({ minLength: 1 }) });
const GetPersonaConfigOutput = Type.Object({
  agentId: Type.String(),
  base: PERSONA_OVERRIDE_FIELDS,
  override: PERSONA_OVERRIDE_FIELDS,
  effective: PERSONA_OVERRIDE_FIELDS,
});

const SetPersonaOverrideInput = Type.Object({
  agentId: Type.String({ minLength: 1 }),
  patch: PERSONA_OVERRIDE_FIELDS,
});

const ClearPersonaOverrideInput = Type.Object({
  agentId: Type.String({ minLength: 1 }),
  field: Type.Optional(Type.String({ minLength: 1 })),
});

export const OPENWAVE_SETTINGS_CONTRACT = {
  pluginId: "openwave",
  operations: {
    getPersonaConfig: {
      kind: "query",
      description: "Read openwave's flat config defaults plus one agent's persona override and the merged effective config.",
      input: GetPersonaConfigInput,
      output: GetPersonaConfigOutput,
    },
    setPersonaOverride: {
      kind: "action",
      description: "Merge a patch into one agent's persona override and persist it to plugins.entries.openwave.config.personaOverrides.<agentId>.",
      input: SetPersonaOverrideInput,
      output: GetPersonaConfigOutput,
    },
    clearPersonaOverride: {
      kind: "action",
      description: "Remove one field (or the whole override) for an agent, reverting it to the flat default.",
      input: ClearPersonaOverrideInput,
      output: GetPersonaConfigOutput,
    },
  },
  events: {},
} as const;
