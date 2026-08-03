/**
 * `@lts/lunar-features` — literature-anchored lunar surface features.
 *
 * Crater populations follow Neukum production capped by Xiao & Werner
 * equilibrium; boulder populations follow the Golombek exponential SFD. The
 * free parametric models of spec §8/§9 remain available as overrides.
 */

export * from './craterModels.js';
export * from './craters.js';
export * from './rocks.js';
