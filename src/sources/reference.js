import {
  createBmkgEarthquakeSource,
  createCompositeEarthquakeSource,
  createUsgsEarthquakeSource,
} from '../layers/earthquakes/source.js';
import {
  createCompositeAirQualitySource,
  createEcccAirQualitySource,
  createSipongiAirQualitySource,
} from '../layers/airQuality/source.js';
import { createOpenMeteoMarineSource } from '../layers/marineWaves/source.js';
import { createPetaBencanaSource } from '../layers/disasterReports/source.js';
import { createMagmaVolcanoSource } from '../layers/volcanoes/source.js';
import { createGfwFishingSource } from '../layers/fishingActivity/source.js';
import { createWfigsPerimeterSource } from '../layers/perimeters/source.js';
import { createBundledCableSource } from '../layers/submarineCables/bundledSource.js';
import { createAdsbGnssSource } from '../layers/gnss/source.js';

/** Construct the existing reference feeds independently of application setup. */
export function createReferenceSources() {
  return {
    earthquakes: createCompositeEarthquakeSource({
      usgs: createUsgsEarthquakeSource(),
      bmkg: createBmkgEarthquakeSource(),
    }),
    'air-quality': createCompositeAirQualitySource([
      createSipongiAirQualitySource(),
      createEcccAirQualitySource(),
    ]),
    'marine-waves': createOpenMeteoMarineSource(),
    'disaster-reports': createPetaBencanaSource(),
    volcanoes: createMagmaVolcanoSource(),
    'fishing-activity': createGfwFishingSource(),
    'fire-perimeters': createWfigsPerimeterSource(),
    cables: createBundledCableSource(),
    'gnss-integrity': createAdsbGnssSource(),
  };
}
