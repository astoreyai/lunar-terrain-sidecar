/**
 * Configuration presets (spec §24).
 *
 * Each is a complete, generatable configuration — not a fragment. The
 * south-polar preset is the default because polar illumination is the case this
 * system exists for.
 */

export interface PresetLayer {
  role: 'context' | 'mission' | 'operational';
  widthMeters: number;
  lengthMeters: number;
  resolutionMeters: number;
}

export interface Preset {
  id: string;
  label: string;
  description: string;
  layers: PresetLayer[];
  site: { latitudeDeg: number; longitudeDeg: number };
  demEnabled: boolean;
  demPath: string;
  demEffectiveResolutionMeters: number;
  craters: {
    model: 'production_csfd' | 'power_law';
    minimumDiameterMeters: number;
    maximumDiameterMeters: number;
    surfaceAgeGyr: number;
    meanDegradation: number;
  };
  rocks: {
    model: 'golombek_sfd' | 'power_law';
    cumulativeFractionalAreaCovered: number;
    minimumDiameterMeters: number;
    maximumDiameterMeters: number;
    physicalMinimumDiameterMeters: number;
  };
  regolith: { enabled: boolean; microreliefAmplitudeM: number };
  regionalSlopeDeg: number;
  epochUtc: string;
}

const SITE01 = '/mnt/projects/datasets/lola_5mpp/Site01_final_adj_5mpp_surf.tif';

export const PRESETS: Record<string, Preset> = {
  south_pole_navigation: {
    id: 'south_pole_navigation',
    label: 'South-Pole Navigation Site',
    description:
      '1 km context, 200 m mission, 30 m operational on the real Site01 polar DEM, ' +
      'at a low solar elevation with high shadow contrast.',
    layers: [
      { role: 'context', widthMeters: 1000, lengthMeters: 1000, resolutionMeters: 2.0 },
      { role: 'mission', widthMeters: 200, lengthMeters: 200, resolutionMeters: 0.2 },
      { role: 'operational', widthMeters: 30, lengthMeters: 30, resolutionMeters: 0.01 },
    ],
    site: { latitudeDeg: -89.4631639, longitudeDeg: -137.4895528 },
    demEnabled: true,
    demPath: SITE01,
    demEffectiveResolutionMeters: 17.5,
    craters: {
      model: 'production_csfd',
      minimumDiameterMeters: 0.2,
      maximumDiameterMeters: 35,
      surfaceAgeGyr: 3.5,
      meanDegradation: 0.45,
    },
    rocks: {
      model: 'golombek_sfd',
      cumulativeFractionalAreaCovered: 0.05,
      minimumDiameterMeters: 0.05,
      maximumDiameterMeters: 2.5,
      physicalMinimumDiameterMeters: 0.15,
    },
    regolith: { enabled: true, microreliefAmplitudeM: 0.012 },
    regionalSlopeDeg: 0,
    epochUtc: '2026-08-03T00:00:00Z',
  },

  rover_test_pad: {
    id: 'rover_test_pad',
    label: 'Rover Test Pad',
    description: '25 m at 0.01 m, low crater density, moderate rocks, minor microrelief.',
    layers: [
      { role: 'context', widthMeters: 200, lengthMeters: 200, resolutionMeters: 0.5 },
      { role: 'operational', widthMeters: 25, lengthMeters: 25, resolutionMeters: 0.01 },
    ],
    site: { latitudeDeg: -89.4631639, longitudeDeg: -137.4895528 },
    demEnabled: true,
    demPath: SITE01,
    demEffectiveResolutionMeters: 17.5,
    craters: {
      model: 'production_csfd',
      minimumDiameterMeters: 0.15,
      maximumDiameterMeters: 6,
      surfaceAgeGyr: 2.0,
      meanDegradation: 0.6,
    },
    rocks: {
      model: 'golombek_sfd',
      cumulativeFractionalAreaCovered: 0.04,
      minimumDiameterMeters: 0.04,
      maximumDiameterMeters: 1.2,
      physicalMinimumDiameterMeters: 0.12,
    },
    regolith: { enabled: true, microreliefAmplitudeM: 0.008 },
    regionalSlopeDeg: 0,
    epochUtc: '2026-08-03T00:00:00Z',
  },

  excavation_test_site: {
    id: 'excavation_test_site',
    label: 'Excavation Test Site',
    description:
      '40 m at 0.02 m with an excavation pit, berm target and spoil area; ' +
      'mass conservation enabled on editing operations.',
    layers: [
      { role: 'context', widthMeters: 300, lengthMeters: 300, resolutionMeters: 1.0 },
      { role: 'operational', widthMeters: 40, lengthMeters: 40, resolutionMeters: 0.02 },
    ],
    site: { latitudeDeg: -89.4631639, longitudeDeg: -137.4895528 },
    demEnabled: true,
    demPath: SITE01,
    demEffectiveResolutionMeters: 17.5,
    craters: {
      model: 'production_csfd',
      minimumDiameterMeters: 0.2,
      maximumDiameterMeters: 8,
      surfaceAgeGyr: 3.0,
      meanDegradation: 0.5,
    },
    rocks: {
      model: 'golombek_sfd',
      cumulativeFractionalAreaCovered: 0.03,
      minimumDiameterMeters: 0.05,
      maximumDiameterMeters: 1.0,
      physicalMinimumDiameterMeters: 0.12,
    },
    regolith: { enabled: true, microreliefAmplitudeM: 0.01 },
    regionalSlopeDeg: 2,
    epochUtc: '2026-08-03T00:00:00Z',
  },

  roughness_stress: {
    id: 'roughness_stress',
    label: 'Roughness Stress Test',
    description: 'High rock density, high microrelief, overlapping crater rims, steep local slopes.',
    layers: [
      { role: 'context', widthMeters: 300, lengthMeters: 300, resolutionMeters: 1.0 },
      { role: 'operational', widthMeters: 30, lengthMeters: 30, resolutionMeters: 0.02 },
    ],
    site: { latitudeDeg: -89.4631639, longitudeDeg: -137.4895528 },
    demEnabled: true,
    demPath: SITE01,
    demEffectiveResolutionMeters: 17.5,
    craters: {
      model: 'production_csfd',
      minimumDiameterMeters: 0.1,
      maximumDiameterMeters: 15,
      surfaceAgeGyr: 4.1,
      meanDegradation: 0.2,
    },
    rocks: {
      model: 'golombek_sfd',
      cumulativeFractionalAreaCovered: 0.18,
      minimumDiameterMeters: 0.04,
      maximumDiameterMeters: 3.0,
      physicalMinimumDiameterMeters: 0.1,
    },
    regolith: { enabled: true, microreliefAmplitudeM: 0.035 },
    regionalSlopeDeg: 6,
    epochUtc: '2026-08-03T00:00:00Z',
  },

  flat_baseline: {
    id: 'flat_baseline',
    label: 'Flat Construction Baseline',
    description: 'Nearly flat, low microrelief, no large craters, few physical rocks.',
    layers: [
      { role: 'context', widthMeters: 200, lengthMeters: 200, resolutionMeters: 1.0 },
      { role: 'operational', widthMeters: 30, lengthMeters: 30, resolutionMeters: 0.02 },
    ],
    site: { latitudeDeg: -89.4631639, longitudeDeg: -137.4895528 },
    demEnabled: false,
    demPath: SITE01,
    demEffectiveResolutionMeters: 17.5,
    craters: {
      model: 'production_csfd',
      minimumDiameterMeters: 0.2,
      maximumDiameterMeters: 2.0,
      surfaceAgeGyr: 0.5,
      meanDegradation: 0.8,
    },
    rocks: {
      model: 'golombek_sfd',
      cumulativeFractionalAreaCovered: 0.01,
      minimumDiameterMeters: 0.05,
      maximumDiameterMeters: 0.5,
      physicalMinimumDiameterMeters: 0.25,
    },
    regolith: { enabled: true, microreliefAmplitudeM: 0.004 },
    regionalSlopeDeg: 0,
    epochUtc: '2026-08-03T00:00:00Z',
  },
};

/** Build a full sidecar configuration object from a preset plus UI overrides. */
export function presetToConfig(
  preset: Preset,
  overrides: {
    terrainId: string;
    seed: string;
    outputDirectory: string;
    latitudeDeg?: number;
    longitudeDeg?: number;
    epochUtc?: string;
    demEnabled?: boolean;
    demPath?: string;
    demEffectiveResolutionMeters?: number;
    craterModel?: 'production_csfd' | 'power_law';
    craterAgeGyr?: number;
    craterMinDiameterM?: number;
    craterMaxDiameterM?: number;
    craterMeanDegradation?: number;
    rockModel?: 'golombek_sfd' | 'power_law';
    rockAreaCoverage?: number;
    rockMinDiameterM?: number;
    rockPhysicalMinDiameterM?: number;
  },
): Record<string, unknown> {
  const demEnabled = overrides.demEnabled ?? preset.demEnabled;
  return {
    schemaVersion: '1.0.0',
    terrainId: overrides.terrainId,
    seed: overrides.seed,
    outputDirectory: overrides.outputDirectory,
    site: {
      latitudeDeg: overrides.latitudeDeg ?? preset.site.latitudeDeg,
      longitudeDeg: overrides.longitudeDeg ?? preset.site.longitudeDeg,
    },
    layers: preset.layers,
    tileSizeSamples: 256,
    dem: {
      enabled: demEnabled,
      path: overrides.demPath ?? preset.demPath,
      applyToRoles: preset.layers.map((l) => l.role),
      effectiveResolutionMeters:
        overrides.demEffectiveResolutionMeters ?? preset.demEffectiveResolutionMeters,
    },
    proceduralStack: [
      {
        id: 'sub_dem_relief',
        model: 'warped_fbm',
        enabled: true,
        fractal: {
          octaves: 6,
          lacunarity: 2.0,
          persistence: 0.5,
          frequency: 0.2,
          amplitude: 0.12,
          anisotropy: 1.0,
        },
        warpStrengthM: 1.5,
        warpFrequency: 0.06,
      },
      {
        id: 'fine_roughness',
        model: 'fbm',
        enabled: true,
        fractal: {
          octaves: 5,
          lacunarity: 2.1,
          persistence: 0.55,
          frequency: 2.0,
          amplitude: 0.02,
          anisotropy: 1.0,
        },
      },
    ],
    regionalSlopeDeg: preset.regionalSlopeDeg,
    regionalSlopeAzimuthDeg: 0,
    craters: {
      enabled: true,
      model: overrides.craterModel ?? preset.craters.model,
      minimumDiameterMeters: overrides.craterMinDiameterM ?? preset.craters.minimumDiameterMeters,
      maximumDiameterMeters: overrides.craterMaxDiameterM ?? preset.craters.maximumDiameterMeters,
      surfaceAgeGyr: overrides.craterAgeGyr ?? preset.craters.surfaceAgeGyr,
      meanDegradation: overrides.craterMeanDegradation ?? preset.craters.meanDegradation,
      degradationSpread: 0.3,
      ellipticalFraction: 0.15,
    },
    rocks: {
      enabled: true,
      model: overrides.rockModel ?? preset.rocks.model,
      cumulativeFractionalAreaCovered:
        overrides.rockAreaCoverage ?? preset.rocks.cumulativeFractionalAreaCovered,
      minimumDiameterMeters: overrides.rockMinDiameterM ?? preset.rocks.minimumDiameterMeters,
      maximumDiameterMeters: preset.rocks.maximumDiameterMeters,
      physicalMinimumDiameterMeters:
        overrides.rockPhysicalMinDiameterM ?? preset.rocks.physicalMinimumDiameterMeters,
      meanBuriedFraction: 0.35,
      angularity: 0.6,
      craterRimEnhancement: 4,
      maximumSlopeDeg: 35,
    },
    regolith: {
      enabled: preset.regolith.enabled,
      microreliefAmplitudeM: preset.regolith.microreliefAmplitudeM,
      microreliefWavelengthM: 0.35,
      maximumResolutionMeters: 0.1,
    },
    solar: {
      mode: 'ephemeris',
      epochUtc: overrides.epochUtc ?? preset.epochUtc,
      computeHorizon: true,
      horizonAzimuthBins: 360,
    },
    limits: {
      profile: 'safe',
      maxBytes: 2147483648,
      maxSamplesPerLayer: 400000000,
      maxTiles: 65536,
    },
    bulkDensityKgM3: 1500,
  };
}
