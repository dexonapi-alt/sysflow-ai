/**
 * Phase 12 animation primitives barrel.
 *
 * Each primitive is a small React component (<80 LoC) plus a pure shape
 * function used by tests. Import from this index so component callsites
 * don't have to know each file name.
 */

export { Breath, computeBreathColor, type BreathProps } from "./Breath.js"
export { Pulse, computePulseColor, type PulseProps } from "./Pulse.js"
export { Shimmer, computeShimmerColors, type ShimmerProps } from "./Shimmer.js"
export { Fade, computeFadeColor, type FadeProps, type FadeDirection } from "./Fade.js"
export { Typewriter, computeTypewriterCount, type TypewriterProps } from "./Typewriter.js"
