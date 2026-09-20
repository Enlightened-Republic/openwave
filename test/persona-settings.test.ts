import { expect, test } from "vitest";

import plugin from "../src/index.js";
import { makeMockApi } from "./mock-api.js";

test("registers the 3 persona-settings session actions", () => {
  const { api, rec } = makeMockApi({ enabled: true, config: { agents: ["main"] } });
  plugin.register(api as never);

  expect([...rec.sessionActions.keys()].sort()).toEqual([
    "clearPersonaOverride",
    "getPersonaConfig",
    "setPersonaOverride",
  ]);
  expect(rec.sessionActions.get("getPersonaConfig")?.requiredScopes).toEqual(["operator.read"]);
  expect(rec.sessionActions.get("setPersonaOverride")?.requiredScopes).toEqual(["operator.write"]);
  expect(rec.sessionActions.get("clearPersonaOverride")?.requiredScopes).toEqual(["operator.write"]);
});

test("getPersonaConfig with no override returns effective === base and an empty override", () => {
  const { api, rec, callAction } = makeMockApi({
    enabled: true,
    config: { agents: ["mila"], contextBudget: 2000, inhibitionStrength: 0.6 },
  });
  plugin.register(api as never);
  expect(rec.sessionActions.size).toBeGreaterThan(0);

  const result = callAction("getPersonaConfig", { agentId: "mila" });
  expect(result).toMatchObject({
    ok: true,
    result: {
      agentId: "mila",
      override: {},
      base: { contextBudget: 2000, inhibitionStrength: 0.6 },
      effective: { contextBudget: 2000, inhibitionStrength: 0.6 },
    },
  });
});

test("getPersonaConfig rejects a missing agentId without throwing", () => {
  const { api, callAction } = makeMockApi({ enabled: true, config: { agents: ["main"] } });
  plugin.register(api as never);

  const result = callAction("getPersonaConfig", {});
  expect(result).toMatchObject({ ok: false });
});

test("setPersonaOverride merges a patch, persists it, and getPersonaConfig reflects it", async () => {
  const { api, callAction, configFile } = makeMockApi({
    enabled: true,
    config: { agents: ["mila", "algen"], contextBudget: 2000, inhibitionStrength: 0.6 },
  });
  plugin.register(api as never);

  const setResult = await callAction("setPersonaOverride", {
    agentId: "mila",
    patch: { inhibitionStrength: 0.3, spreadingActivationHops: 2 },
  });
  expect(setResult).toMatchObject({
    ok: true,
    result: {
      agentId: "mila",
      override: { inhibitionStrength: 0.3, spreadingActivationHops: 2 },
      effective: { contextBudget: 2000, inhibitionStrength: 0.3, spreadingActivationHops: 2 },
    },
  });

  // Persisted into the config file draft under the documented path.
  expect(configFile.plugins.entries.openwave.config.personaOverrides.mila).toEqual({
    inhibitionStrength: 0.3,
    spreadingActivationHops: 2,
  });

  // A second agent is untouched.
  const algenResult = callAction("getPersonaConfig", { agentId: "algen" });
  expect(algenResult).toMatchObject({ ok: true, result: { override: {} } });

  // Re-reading mila reflects the update from the same running plugin instance.
  const rereadMila = callAction("getPersonaConfig", { agentId: "mila" });
  expect(rereadMila).toMatchObject({ ok: true, result: { override: { inhibitionStrength: 0.3, spreadingActivationHops: 2 } } });
});

test("setPersonaOverride merging preserves earlier fields not present in the new patch", async () => {
  const { api, callAction } = makeMockApi({
    enabled: true,
    config: { agents: ["mila"], contextBudget: 2000 },
  });
  plugin.register(api as never);

  await callAction("setPersonaOverride", { agentId: "mila", patch: { inhibitionStrength: 0.3 } });
  const second = await callAction("setPersonaOverride", { agentId: "mila", patch: { activationThreshold: 0.2 } });

  expect(second).toMatchObject({
    ok: true,
    result: { override: { inhibitionStrength: 0.3, activationThreshold: 0.2 } },
  });
});

test("clearPersonaOverride with a field name removes only that field", async () => {
  const { api, callAction } = makeMockApi({
    enabled: true,
    config: { agents: ["mila"], contextBudget: 2000 },
  });
  plugin.register(api as never);

  await callAction("setPersonaOverride", { agentId: "mila", patch: { inhibitionStrength: 0.3, activationThreshold: 0.2 } });
  const cleared = await callAction("clearPersonaOverride", { agentId: "mila", field: "inhibitionStrength" });

  expect(cleared).toMatchObject({ ok: true, result: { override: { activationThreshold: 0.2 } } });
});

test("clearPersonaOverride without a field removes the whole override", async () => {
  const { api, callAction, configFile } = makeMockApi({
    enabled: true,
    config: { agents: ["mila"], contextBudget: 2000 },
  });
  plugin.register(api as never);

  await callAction("setPersonaOverride", { agentId: "mila", patch: { inhibitionStrength: 0.3 } });
  const cleared = await callAction("clearPersonaOverride", { agentId: "mila" });

  expect(cleared).toMatchObject({ ok: true, result: { override: {} } });
  expect(configFile.plugins.entries.openwave.config.personaOverrides.mila).toBeUndefined();
});

test("setPersonaOverride fails closed (no throw) when the host has no config-mutation surface", async () => {
  const { api, callAction } = makeMockApi(
    { enabled: true, config: { agents: ["mila"] } },
    { withConfigMutation: false },
  );
  plugin.register(api as never);

  const result = await callAction("setPersonaOverride", { agentId: "mila", patch: { inhibitionStrength: 0.3 } });
  expect(result).toMatchObject({ ok: false });
});

test("register() does not throw and registers no session actions when the host has no session.controls surface", () => {
  const { api, rec } = makeMockApi(
    { enabled: true, config: { agents: ["main"] } },
    { withSessionControls: false },
  );
  expect(() => plugin.register(api as never)).not.toThrow();
  expect(rec.sessionActions.size).toBe(0);
});

test("emotionalProfile fields round-trip through set/get/clear (accepted, no runtime effect claimed)", async () => {
  const { api, callAction } = makeMockApi({
    enabled: true,
    config: { agents: ["mila"] },
  });
  plugin.register(api as never);

  const set = await callAction("setPersonaOverride", {
    agentId: "mila",
    patch: { emotionalProfile: { valenceBias: 0.4 } },
  });
  expect(set).toMatchObject({ ok: true, result: { override: { emotionalProfile: { valenceBias: 0.4 } } } });

  const second = await callAction("setPersonaOverride", {
    agentId: "mila",
    patch: { emotionalProfile: { arousalScale: 1.2 } },
  });
  // Nested emotionalProfile merges field-by-field rather than replacing wholesale.
  expect(second).toMatchObject({
    ok: true,
    result: { override: { emotionalProfile: { valenceBias: 0.4, arousalScale: 1.2 } } },
  });
});
