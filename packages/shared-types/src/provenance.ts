/**
 * Provenance (spec §20, §33: "every generated artifact must be traceable to a
 * configuration and seed").
 *
 * Also the place where synthetic content is labelled as synthetic. A consumer
 * must be able to tell, from the artifact alone, which elevations are LOLA
 * measurements and which this generator invented.
 */

export interface GeneratorIdentity {
  name: string;
  version: string;
  /** Schema version of the emitted artifacts. */
  schemaVersion: string;
}

/** A real dataset that contributed measured elevations. */
export interface DataSource {
  /** Short identifier used in manifests, e.g. `LDEM_75S_120M`. */
  id: string;
  /** Human-readable description. */
  description: string;
  /** Where the bytes came from on this machine. */
  path: string;
  /** Mission / instrument / product identifiers, for citation. */
  citation: string;
  /** Ground sample distance of the product, metres. */
  resolutionMeters: number;
  /**
   * Effective (feature-resolving) resolution, metres, when it differs from the
   * grid spacing. Synthetic detail is only injected below this scale.
   */
  effectiveResolutionMeters?: number;
  /** SHA-256 of the source file, so a stale input is detectable. */
  sha256?: string;
}

/**
 * A model whose parameters come from published literature.
 *
 * Recorded so a reader can tell a sourced crater population from an invented
 * one, and can find the paper.
 */
export interface LiteratureModel {
  /** Identifier used in code, e.g. `neukum_production`. */
  id: string;
  /** What the model does. */
  description: string;
  /** Full citation. */
  citation: string;
}

export interface TerrainProvenance {
  generator: GeneratorIdentity;
  /** ISO-8601 instant the dataset was generated. */
  generatedAt: string;
  /** Master seed and every derived channel actually used. */
  seeds: { master: string; derived: Record<string, string> };
  /** Real datasets that contributed measured elevation. Empty if fully synthetic. */
  dataSources: DataSource[];
  /** Literature-sourced models used. */
  literatureModels: LiteratureModel[];
  /**
   * Statements that are synthetic heuristics rather than validated physical
   * predictions (spec §22, §33). Emitted verbatim into every manifest.
   */
  syntheticHeuristics: string[];
  /** Known limitations that apply to this specific dataset. */
  limitations: string[];
  /** SHA-256 of the canonicalised configuration that produced this dataset. */
  configurationHash: string;
}
