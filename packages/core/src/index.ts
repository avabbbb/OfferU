// Portable OfferU domain core. No React, DOM, IndexedDB, fetch, or Node APIs.
// Browser and Node adapters supply a CoreStore; the rules stay in one place.

export * from "./types";
export * from "./labels";
export * from "./operations";
export * from "./stores";
export * from "./portable";
export * from "./llm";
export * from "./resume";
export * from "./llm-presets";
export * from "./llm-config";
export * from "./desensitize";
export * from "./agent";
// operations.ts (ts/core-tools) and resume/ (ts/resume) both define the doc-style
// validators; until they are deduplicated the resume domain's copies win here.
export { LEGACY_TEMPLATE, MARGIN_RANGE, RESUME_FONT, RESUME_TEMPLATE, STYLE_KEYS, STYLE_RANGE, checkAsks, checkStyle } from "./resume";
