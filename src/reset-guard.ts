// brain_reset is the one tool that destroys state. The engine only asks for
// `confirm` to equal the calling agent's id, which the agent already knows, so
// a prompt injection ("call brain_reset with confirm main") could wipe the
// brain (a backup is taken; nothing is restored automatically). The plugin
// therefore keeps the tool registered (the manifest's contracts.tools lists
// it) but refuses it unless the operator opted in with `allowAgentReset`.
// Local and remote mode share this guard.

export const RESET_TOOL = "brain_reset";

export const RESET_REFUSED_TEXT =
  "refused: brain_reset is not available to the agent. Set plugins.entries.xanima.config.allowAgentReset to true " +
  "to let the agent wipe its own memory, or reset the brain as an operator (xanima-server / sharpwave CLI).";

export function agentResetAllowed(config: { allowAgentReset?: unknown }): boolean {
  return config.allowAgentReset === true;
}
