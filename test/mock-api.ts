// Minimal stand-in for the OpenClaw plugin API surface openwave registers
// against. Records everything the plugin wires so tests can assert on it and
// fire hooks by name.
//
// eslint-disable @typescript-eslint/no-explicit-any

export type Recorded = {
  hooks: Map<string, Array<(e: any, c: any) => any>>;
  tools: any[];
  injections: any[];
  lifecycles: any[];
  sessionActions: Map<string, { id: string; description?: string; schema?: unknown; requiredScopes?: string[]; handler: (ctx: any) => any }>;
};

export type MockApiOptions = {
  /** Omit to simulate an older host with no session.controls surface. */
  withSessionControls?: boolean;
  /** Omit to simulate a host with no api.runtime.config surface. */
  withConfigMutation?: boolean;
  /** Backing store mutateConfigFile writes into; defaults to a fresh {}. */
  configFile?: Record<string, any>;
};

export function makeMockApi(pluginConfig: Record<string, unknown>, opts: MockApiOptions = {}) {
  const rec: Recorded = { hooks: new Map(), tools: [], injections: [], lifecycles: [], sessionActions: new Map() };
  const withSessionControls = opts.withSessionControls ?? true;
  const withConfigMutation = opts.withConfigMutation ?? true;
  const configFile: Record<string, any> = opts.configFile ?? {};

  const session: Record<string, unknown> = {
    workflow: {
      async enqueueNextTurnInjection(inj: any) {
        rec.injections.push(inj);
        return { enqueued: true, id: "mock", sessionKey: inj.sessionKey };
      },
    },
  };
  if (withSessionControls) {
    session["controls"] = {
      registerSessionAction(action: any) { rec.sessionActions.set(action.id, action); },
    };
  }

  const runtime: Record<string, unknown> = {};
  if (withConfigMutation) {
    runtime["config"] = {
      current: () => configFile,
      async mutateConfigFile({ mutate }: { mutate: (draft: Record<string, any>) => void }) {
        mutate(configFile);
        return { afterWrite: { mode: "auto" }, followUp: {} };
      },
    };
  }

  const api = {
    pluginConfig,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    runtime,
    session,
    lifecycle: {
      registerRuntimeLifecycle(l: any) { rec.lifecycles.push(l); },
    },
    registerTool(t: any) { rec.tools.push(t); },
    registerMemoryEmbeddingProvider() {},
    registerMemoryPromptSupplement() {},
    registerMemoryCorpusSupplement() {},
    on(name: string, handler: (e: any, c: any) => any) {
      if (!rec.hooks.has(name)) rec.hooks.set(name, []);
      rec.hooks.get(name)!.push(handler);
    },
  };
  const fire = (name: string, event: any, ctx: any) =>
    Promise.all((rec.hooks.get(name) ?? []).map((h) => h(event, ctx)));
  const callAction = (id: string, payload: Record<string, unknown>) => {
    const action = rec.sessionActions.get(id);
    if (!action) throw new Error(`session action not registered: ${id}`);
    return action.handler({ pluginId: "openwave", actionId: id, payload });
  };
  return { api, rec, fire, callAction, configFile };
}
