/**
 * Barrel re-exports for the scaffold module.
 */

export {
  SCAFFOLDER_REGISTRY,
  getScaffolder,
  findScaffoldersByTerms,
  resolveCommand,
  getInstallCommand,
  type ScaffolderEntry,
  type StackKey,
  type PostScaffoldInstaller,
} from "./registry.js"

export { extractProjectName } from "./project-name.js"

export {
  recommendScaffold,
  type RecommendArgs,
  type ScaffoldRecommendation,
  type ImplementBriefMinimal,
  type ReasoningEnvelopeMinimal,
} from "./recommender.js"

export {
  detectScaffoldingNeed,
  parseScaffoldResponse,
  buildScaffoldConfirmationMessage,
  storeScaffoldChoice,
  getScaffoldChoice,
  clearScaffoldState,
  type ScaffoldOption,
} from "./legacy-shims.js"
