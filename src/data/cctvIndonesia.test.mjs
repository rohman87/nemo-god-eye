import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  loadJakartaSourcesFromOpenData,
  loadWestJavaSourcesFromOpenData,
  loadDepokSourcesFromOpenData,
  loadBogorSourcesFromOpenData,
} from '../../server/providers/cctv/sources.js';
import { createCctvCatalog } from '../../server/providers/cctv/catalog.js';
import { CITY_POIS } from '../cityPois.js';
import { CAMERA_SEEDS } from '../layers/cctv/policy.js';

test('Jakarta catalog registers curated traffic cameras across major corridors', (t) => {
  t.mock.method(console, 'log', () => {});
  const cameras = loadJakartaSourcesFromOpenData();
  assert.ok(cameras.length >= 10, 'Expected at least 10 Jakarta cameras');

  for (const camera of cameras) {
    assert.equal(camera.city, 'Jakarta');
    assert.equal(camera.cityId, 'jakarta');
    assert.equal(camera.feedType, 'hls');
    assert.ok(
      camera.lat >= -6.5 && camera.lat <= -5.9,
      `Latitude out of bounds: ${camera.lat}`,
    );
    assert.ok(
      camera.lon >= 106.2 && camera.lon <= 107.2,
      `Longitude out of bounds: ${camera.lon}`,
    );
    assert.ok(camera.url.includes('.m3u8'), `URL must be HLS stream: ${camera.url}`);
    assert.ok(Number.isFinite(camera.headingDeg));
    assert.ok(camera.headingDeg >= 0 && camera.headingDeg < 360);
  }

  const ids = new Set(cameras.map((c) => c.id));
  assert.ok(ids.has('jakarta-cmnp-cawang'), 'Interchange Cawang should be registered');
  assert.ok(ids.has('jakarta-cmnp-priok'), 'Interchange Priok should be registered');
  assert.ok(ids.has('jakarta-cmnp-pluit'), 'Interchange Pluit should be registered');
  assert.ok(ids.has('jakarta-jtd-kelapa-gading'), 'Kelapa Gading should be registered');
  assert.ok(ids.has('jakarta-kkdm-wiyoto-wiyono'), 'Becakayu should be registered');
});

test('Jakarta loader tolerates missing file and skips malformed rows', (t) => {
  t.mock.method(console, 'warn', () => {});
  assert.deepEqual(
    loadJakartaSourcesFromOpenData({ sourceRoot: '/nonexistent-root' }),
    [],
  );

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gev-jakarta-'));
  fs.mkdirSync(path.join(dir, 'config'));
  fs.writeFileSync(
    path.join(dir, 'config', 'cctv_sources.jakarta.json'),
    JSON.stringify([
      null,
      { id: '' },
      { id: 'bad-coords', lat: 999, lon: 999, url: 'https://example.com/stream.m3u8' },
      { id: 'outside-bounds', lat: 10.0, lon: 10.0, url: 'https://example.com/stream.m3u8' },
      { id: 'no-url', lat: -6.2, lon: 106.8 },
      { id: 'unpinned-host', lat: -6.2, lon: 106.8, url: 'https://example.com/stream.m3u8' },
      { id: 'valid-cam', lat: -6.2, lon: 106.8, url: 'https://cctv.citramarga.com/stream.m3u8' },
    ]),
  );

  t.mock.method(console, 'log', () => {});
  const res = loadJakartaSourcesFromOpenData({ sourceRoot: dir });
  assert.equal(res.length, 1);
  assert.equal(res[0].id, 'valid-cam');
});

test('West Java loader registers Bandung city and regional cameras', async (t) => {
  t.mock.method(console, 'log', () => {});
  const cameras = await loadWestJavaSourcesFromOpenData();
  assert.ok(cameras.length >= 10, 'Expected at least 10 West Java cameras');

  for (const camera of cameras) {
    assert.ok(
      camera.city === 'Bandung' || camera.city === 'West Java',
      `Unexpected city: ${camera.city}`,
    );
    assert.ok(
      camera.cityId === 'bandung' || camera.cityId === 'westjava',
      `Unexpected cityId: ${camera.cityId}`,
    );
    assert.equal(camera.feedType, 'hls');
    assert.ok(
      camera.lat >= -7.2 && camera.lat <= -6.2,
      `Latitude out of bounds: ${camera.lat}`,
    );
    assert.ok(
      camera.lon >= 106.5 && camera.lon <= 107.8,
      `Longitude out of bounds: ${camera.lon}`,
    );
    assert.ok(camera.url.includes('.m3u8'), `URL must be HLS: ${camera.url}`);
  }

  const ids = new Set(cameras.map((c) => c.id));
  assert.ok(ids.has('bandung-braga-1'), 'Braga 01 should be registered');
  assert.ok(ids.has('bandung-cibeureum'), 'Cibeureum should be registered');
  assert.ok(ids.has('westjava-cct-jatikarya'), 'GT Jatikarya should be registered');
});

test('Depok loader registers Depok municipal traffic cameras', (t) => {
  t.mock.method(console, 'log', () => {});
  const cameras = loadDepokSourcesFromOpenData();
  assert.ok(cameras.length >= 10, 'Expected at least 10 Depok cameras');

  for (const camera of cameras) {
    assert.equal(camera.city, 'Depok');
    assert.equal(camera.cityId, 'depok');
    assert.equal(camera.pack, 'depok');
    assert.equal(camera.feedType, 'hls');
    assert.ok(
      camera.lat >= -6.55 && camera.lat <= -6.30,
      `Latitude out of bounds: ${camera.lat}`,
    );
    assert.ok(
      camera.lon >= 106.70 && camera.lon <= 106.95,
      `Longitude out of bounds: ${camera.lon}`,
    );
    assert.ok(camera.url.includes('.m3u8'), `URL must be HLS: ${camera.url}`);
  }

  const ids = new Set(cameras.map((c) => c.id));
  assert.ok(ids.has('depok-dishub-margo-city-1'), 'Margo City should be registered');
  assert.ok(ids.has('depok-dishub-balai-kota'), 'Balai Kota Depok should be registered');
  assert.ok(ids.has('depok-dishub-dewi-sartika'), 'Dewi Sartika should be registered');
});

test('Bogor loader registers Bogor municipal traffic cameras (BSW)', (t) => {
  t.mock.method(console, 'log', () => {});
  const cameras = loadBogorSourcesFromOpenData();
  assert.ok(cameras.length >= 10, 'Expected at least 10 Bogor cameras');

  for (const camera of cameras) {
    assert.equal(camera.city, 'Bogor');
    assert.equal(camera.cityId, 'bogor');
    assert.equal(camera.pack, 'bogor');
    assert.equal(camera.feedType, 'hls');
    assert.ok(
      camera.lat >= -6.75 && camera.lat <= -6.45,
      `Latitude out of bounds: ${camera.lat}`,
    );
    assert.ok(
      camera.lon >= 106.70 && camera.lon <= 106.90,
      `Longitude out of bounds: ${camera.lon}`,
    );
    assert.ok(camera.url.includes('.m3u8'), `URL must be HLS: ${camera.url}`);
  }

  const ids = new Set(cameras.map((c) => c.id));
  assert.ok(ids.has('bogor-bsw-79'), 'Tugu Kujang should be registered');
  assert.ok(ids.has('bogor-bsw-82'), 'Alun-Alun Bogor should be registered');
  assert.ok(ids.has('bogor-bsw-134'), 'Balai Kota Bogor should be registered');
});

test('Catalog integration includes Indonesian packs in merge order', async (t) => {
  t.mock.method(console, 'log', () => {});
  const priorJakarta = process.env.CCTV_JAKARTA_ENABLED;
  const priorWestJava = process.env.CCTV_WESTJAVA_ENABLED;
  const priorDepok = process.env.CCTV_DEPOK_ENABLED;
  const priorBogor = process.env.CCTV_BOGOR_ENABLED;
  try {
    process.env.CCTV_JAKARTA_ENABLED = '1';
    process.env.CCTV_WESTJAVA_ENABLED = '1';
    process.env.CCTV_DEPOK_ENABLED = '1';
    process.env.CCTV_BOGOR_ENABLED = '1';

    const getCctvSources = createCctvCatalog({ sourceRoot: process.cwd() });
    const sources = await getCctvSources();

    const jakarta = sources.filter((s) => s.cityId === 'jakarta');
    assert.ok(jakarta.length > 0, 'Jakarta sources must be present in catalog');

    const westjava = sources.filter(
      (s) => s.cityId === 'bandung' || s.cityId === 'westjava',
    );
    assert.ok(westjava.length > 0, 'West Java sources must be present in catalog');

    const depok = sources.filter((s) => s.cityId === 'depok');
    assert.ok(depok.length > 0, 'Depok sources must be present in catalog');

    const bogor = sources.filter((s) => s.cityId === 'bogor');
    assert.ok(bogor.length > 0, 'Bogor sources must be present in catalog');
  } finally {
    if (priorJakarta === undefined) delete process.env.CCTV_JAKARTA_ENABLED;
    else process.env.CCTV_JAKARTA_ENABLED = priorJakarta;
    if (priorWestJava === undefined) delete process.env.CCTV_WESTJAVA_ENABLED;
    else process.env.CCTV_WESTJAVA_ENABLED = priorWestJava;
    if (priorDepok === undefined) delete process.env.CCTV_DEPOK_ENABLED;
    else process.env.CCTV_DEPOK_ENABLED = priorDepok;
    if (priorBogor === undefined) delete process.env.CCTV_BOGOR_ENABLED;
    else process.env.CCTV_BOGOR_ENABLED = priorBogor;
  }
});

test('Jakarta and Bandung preset locations are defined in CITY_POIS', () => {
  assert.ok(CITY_POIS.jakarta, 'CITY_POIS.jakarta must exist');
  assert.equal(CITY_POIS.jakarta.name, 'Jakarta');
  assert.equal(CITY_POIS.jakarta.pois.length, 5);
  assert.ok(CITY_POIS.jakarta.pois[0].name.includes('Monas'));

  assert.ok(CITY_POIS.bandung, 'CITY_POIS.bandung must exist');
  assert.equal(CITY_POIS.bandung.name, 'Bandung');
  assert.equal(CITY_POIS.bandung.pois.length, 5);
  assert.ok(CITY_POIS.bandung.pois[0].name.includes('Gedung Sate'));
});

test('Jakarta and Bandung seeds are configured in CAMERA_SEEDS', () => {
  const jakartaSeeds = CAMERA_SEEDS.filter((s) => s.cityId === 'jakarta');
  assert.ok(jakartaSeeds.length >= 2, 'Must have at least 2 Jakarta seeds');

  const bandungSeeds = CAMERA_SEEDS.filter((s) => s.cityId === 'bandung');
  assert.ok(bandungSeeds.length >= 2, 'Must have at least 2 Bandung seeds');
});
