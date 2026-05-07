/**
 * Barrel re-exports for the memory-store module.
 */

export {
  memoryEntrySchema,
  entryKindSchema,
  entryStatusSchema,
  entryId,
  makeEntry,
  type MemoryEntry,
  type EntryKind,
  type EntryStatus,
  type NewEntryInput,
} from "./entry-schema.js"

export {
  serialiseEntries,
  parseEntries,
} from "./file-format.js"

export {
  loadMemoryEntries,
  saveMemoryEntries,
  upsertEntry,
  deleteEntry,
  memoryPathFor,
} from "./store.js"

export {
  validateFileRefs,
  validateDepRefs,
  validateAge,
  runAllValidators,
  type ValidatedEntry,
  type ValidatorOptions,
  type PartitionResult,
} from "./validators.js"

export {
  noteAgreement,
  noteContradiction,
  noteAccessed,
} from "./confirmation-tracker.js"

export {
  applyMemoryFeedback,
  validateConfirmation,
  validateContradiction,
  type MemoryFeedback,
  type ApplyMemoryFeedbackResult,
} from "./feedback.js"

export {
  compactIfNeeded,
  type CompactOptions,
  type CompactResult,
} from "./compaction.js"

export {
  recallForReasoning,
  type RecallArgs,
  type RecallResult,
} from "./recall.js"

export {
  recordDecision,
  recordImplementSummary,
  recordUserCorrection,
  recordBugPattern,
  recordChunkSummary,
  recordOriginalIntent,
} from "./recorder.js"
