/**
 * `@lts/shared-types` — the canonical terrain model, coordinate conventions,
 * feature manifests, provenance records and configuration schema.
 *
 * Nothing here imports Three.js. The renderer consumes these types; it does not
 * define them (spec §33).
 */

export * from './coordinates.js';
export * from './terrain.js';
export * from './features.js';
export * from './provenance.js';
export * from './config.js';
