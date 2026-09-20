// Openwave's Control UI settings page: a real sidebar page (not a session
// dashboard widget) that reads/writes the per-agent persona overrides
// described in settings-contract.ts. Built separately from dist/index.js by
// `openclaw plugins build` (docs/plugins/feature-plugins.md "Build and
// reload") -- this file is never bundled into openwave's own backend build.
//
// Only renders once an operator has enabled Settings -> Labs -> Custom
// plugin UI (openwave is a locally-installed plugin, not bundled), and only
// while openwave is actually installed and enabled -- neither of which is
// true on this machine right now (openwave is deliberately out of
// openclaw.json pending the memory-slot work). This is scaffolding to build
// and typecheck against today; wiring it back into a live gateway is a
// separate, later step.

import { defineControlUiPlugin, type ControlUiHost, type ControlUiView } from "openclaw/plugin-sdk/control-ui";
import { createFeatureClient, defineFeatureContract } from "openclaw/plugin-sdk/feature-contract";

import { OPENWAVE_SETTINGS_CONTRACT, type PersonaOverrideFields } from "./settings-contract.js";

const CONTRACT = defineFeatureContract(OPENWAVE_SETTINGS_CONTRACT);

const NUMBER_FIELDS: Array<{
  key: keyof PersonaOverrideFields;
  label: string;
  step?: string;
  min?: number;
  max?: number;
}> = [
  { key: "contextBudget", label: "Context budget", step: "50", min: 0 },
  { key: "workingMemorySlots", label: "Working memory slots", step: "1", min: 1, max: 32 },
  { key: "spreadingActivationHops", label: "Spreading activation hops", step: "1", min: 0, max: 4 },
  { key: "activationThreshold", label: "Activation threshold", step: "0.01", min: 0, max: 1 },
  { key: "inhibitionStrength", label: "Inhibition strength", step: "0.01", min: 0, max: 1 },
  { key: "efDefault", label: "FSRS ease factor default", step: "0.1", min: 0 },
  { key: "retrievabilityFloor", label: "Retrievability floor", step: "0.01", min: 0, max: 1 },
  { key: "consolidationTimeGateHours", label: "Consolidation time gate (hours)", step: "1", min: 0 },
  { key: "consolidationEpisodeGate", label: "Consolidation episode gate", step: "1", min: 0 },
  { key: "pruneAfterDays", label: "Prune after (days)", step: "1", min: 0 },
];

// Reserved fields: accepted and stored today, but sharpwave-core has no
// valence/arousal split yet (research/emotional-memory-openclaw-integration.md
// proposal 3) so these have no runtime effect. Rendered disabled with a note
// rather than hidden, so the shape is visible ahead of the engine work.
const RESERVED_EMOTIONAL_FIELDS: Array<{ key: "valenceBias" | "arousalScale"; label: string; step: string; min: number; max: number }> = [
  { key: "valenceBias", label: "Valence bias (reserved)", step: "0.05", min: -1, max: 1 },
  { key: "arousalScale", label: "Arousal scale (reserved)", step: "0.05", min: 0, max: 2 },
];

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

const mountSettingsPage: ControlUiView = (container, context) => {
  const host: ControlUiHost = context.host;
  const client = createFeatureClient(CONTRACT, host);

  const root = el("div", "openwave-settings");
  root.style.padding = "16px";
  root.style.maxWidth = "480px";
  root.style.display = "flex";
  root.style.flexDirection = "column";
  root.style.gap = "12px";

  const heading = el("h2");
  heading.textContent = "Openwave — persona overrides";
  const subheading = el("p");
  subheading.textContent =
    "Per-agent tuning layered over openwave's flat plugin config. Missing fields inherit the flat default.";
  subheading.style.opacity = "0.75";
  subheading.style.fontSize = "0.9em";

  const agentRow = el("label");
  agentRow.textContent = "Agent";
  const agentSelect = el("select");
  agentRow.appendChild(document.createElement("br"));
  agentRow.appendChild(agentSelect);

  const status = el("div");
  status.style.fontSize = "0.85em";
  status.style.minHeight = "1.2em";

  const fieldsForm = el("div");
  fieldsForm.style.display = "grid";
  fieldsForm.style.gridTemplateColumns = "1fr auto";
  fieldsForm.style.gap = "8px 12px";
  fieldsForm.style.alignItems = "center";

  const inputByKey = new Map<string, HTMLInputElement>();
  const overriddenByKey = new Set<string>();

  function addFieldRow(key: string, label: string, opts: { step?: string; min?: number; max?: number; disabled?: boolean; note?: string }) {
    const labelEl = el("label");
    labelEl.textContent = label + (opts.note ? ` — ${opts.note}` : "");
    labelEl.style.fontSize = "0.9em";

    const wrap = el("div");
    wrap.style.display = "flex";
    wrap.style.gap = "6px";

    const input = el("input");
    input.type = "number";
    if (opts.step) input.step = opts.step;
    if (opts.min !== undefined) input.min = String(opts.min);
    if (opts.max !== undefined) input.max = String(opts.max);
    input.disabled = !!opts.disabled;
    input.style.width = "8em";
    inputByKey.set(key, input);

    const clearBtn = el("button");
    clearBtn.type = "button";
    clearBtn.textContent = "Reset";
    clearBtn.title = "Clear this field's override, reverting to the flat default";
    clearBtn.disabled = !!opts.disabled;
    clearBtn.addEventListener("click", () => void clearField(key));

    wrap.appendChild(input);
    wrap.appendChild(clearBtn);
    fieldsForm.appendChild(labelEl);
    fieldsForm.appendChild(wrap);
  }

  for (const field of NUMBER_FIELDS) {
    addFieldRow(field.key, field.label, { step: field.step, min: field.min, max: field.max });
  }
  for (const field of RESERVED_EMOTIONAL_FIELDS) {
    addFieldRow(`emotionalProfile.${field.key}`, field.label, {
      step: field.step,
      min: field.min,
      max: field.max,
      disabled: true,
      note: "no runtime effect yet",
    });
  }

  const saveBtn = el("button");
  saveBtn.type = "button";
  saveBtn.textContent = "Save overrides";
  saveBtn.addEventListener("click", () => void save());

  root.append(heading, subheading, agentRow, fieldsForm, saveBtn, status);
  container.appendChild(root);

  let currentAgentId = host.agents.selectedId ?? host.agents.rows[0]?.id ?? "";
  let disposed = false;

  function renderAgentOptions() {
    agentSelect.innerHTML = "";
    for (const agent of host.agents.rows) {
      const opt = document.createElement("option");
      opt.value = agent.id;
      const displayName = agent.identity?.name;
      opt.textContent = displayName ? `${displayName} (${agent.id})` : agent.id;
      if (agent.id === currentAgentId) opt.selected = true;
      agentSelect.appendChild(opt);
    }
  }

  function applyResult(result: { override: PersonaOverrideFields; effective: PersonaOverrideFields }) {
    overriddenByKey.clear();
    for (const field of NUMBER_FIELDS) {
      const input = inputByKey.get(field.key)!;
      const value = result.effective[field.key];
      input.value = value === undefined ? "" : String(value);
      if (result.override[field.key] !== undefined) overriddenByKey.add(field.key);
    }
    for (const field of RESERVED_EMOTIONAL_FIELDS) {
      const key = `emotionalProfile.${field.key}` as const;
      const input = inputByKey.get(key)!;
      const value = result.effective.emotionalProfile?.[field.key];
      input.value = value === undefined ? "" : String(value);
    }
  }

  async function load() {
    if (!currentAgentId) {
      status.textContent = "No agents configured on this gateway.";
      return;
    }
    status.textContent = "Loading…";
    try {
      const result = await client.invoke("getPersonaConfig", { agentId: currentAgentId });
      if (disposed) return;
      applyResult(result);
      status.textContent = "";
    } catch (err) {
      status.textContent = `Failed to load: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  async function save() {
    const patch: PersonaOverrideFields = {};
    for (const field of NUMBER_FIELDS) {
      const raw = inputByKey.get(field.key)!.value;
      if (raw !== "") patch[field.key] = Number(raw);
    }
    status.textContent = "Saving…";
    try {
      const result = await client.invoke("setPersonaOverride", { agentId: currentAgentId, patch });
      if (disposed) return;
      applyResult(result);
      status.textContent = "Saved.";
    } catch (err) {
      status.textContent = `Failed to save: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  async function clearField(key: string) {
    if (key.startsWith("emotionalProfile.")) return; // reserved fields have nothing persisted to clear yet
    status.textContent = "Clearing…";
    try {
      const result = await client.invoke("clearPersonaOverride", {
        agentId: currentAgentId,
        field: key as keyof PersonaOverrideFields,
      });
      if (disposed) return;
      applyResult(result);
      status.textContent = "Reset to default.";
    } catch (err) {
      status.textContent = `Failed to reset: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  renderAgentOptions();
  agentSelect.addEventListener("change", () => {
    currentAgentId = agentSelect.value;
    void load();
  });
  const unsubscribeAgents = host.subscribe(() => {
    renderAgentOptions();
  });
  void load();

  return {
    dispose() {
      disposed = true;
      unsubscribeAgents();
    },
  };
};

export default defineControlUiPlugin({
  id: "openwave",
  activate(host) {
    const disposePage = host.ui.registerPage({
      id: "openwave-settings",
      label: "Openwave",
      mount: mountSettingsPage,
    });
    const disposeNav = host.ui.registerNavigation({
      id: "openwave-settings-nav",
      label: "Openwave",
      page: { id: "openwave-settings" },
      icon: "brain",
    });
    return () => {
      disposeNav();
      disposePage();
    };
  },
});
