import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseCycloneStatus,
  parseJtwcFeed,
  parseJtwcWarning,
} from './cyclones.js';

const NOW = Date.parse('2026-01-06T13:00:00Z');

const WARNING = `
   WARNING POSITION:
   061200Z --- NEAR 12.0N 113.5E
     MOVEMENT PAST SIX HOURS - 285 DEGREES AT 13 KTS
   POSITION ACCURATE TO WITHIN 030 NM
   MAX SUSTAINED WINDS - 090 KT, GUSTS 110 KT
   MINIMUM CENTRAL PRESSURE AT 061200Z IS 960 MB.
`;

const feed = (
  title,
  url = 'https://www.metoc.navy.mil/jtwc/products/wp0126web.txt',
) =>
  `<rss><channel><item><description><![CDATA[<b>${title} 01W (Test) Warning #5</b> Issued at 06/1200Z<ul><a href='${url}'>text</a></ul>]]></description></item></channel></rss>`;

test('parseJtwcWarning reads position, wind, pressure and movement', () => {
  const parsed = parseJtwcWarning(WARNING);
  assert.deepEqual(parsed.position, { longitude: 113.5, latitude: 12 });
  assert.equal(parsed.windKt, 90);
  assert.equal(parsed.pressureHpa, 960);
  assert.deepEqual(parsed.movement, { directionDegrees: 285, speedKt: 13 });
});

test('parseJtwcWarning applies hemisphere signs', () => {
  const parsed = parseJtwcWarning(
    'WARNING POSITION:\n 061200Z --- NEAR 15.2S 120.7W\n',
  );
  assert.deepEqual(parsed.position, { longitude: -120.7, latitude: -15.2 });
  assert.equal(parsed.windKt, null);
  assert.equal(parsed.pressureHpa, null);
  assert.deepEqual(parsed.movement, {
    directionDegrees: null,
    speedKt: null,
  });
});

test('parseJtwcWarning rejects garbage and out-of-range values', () => {
  assert.equal(parseJtwcWarning('nothing to see'), null);
  assert.equal(parseJtwcWarning(null), null);
  assert.equal(parseJtwcWarning('NEAR 12.0N 113.5E'), null);
  assert.equal(
    parseJtwcWarning('WARNING POSITION:\n --- NEAR 95.0N 113.5E'),
    null,
  );
  const odd = parseJtwcWarning(
    `${WARNING}`.replace('IS 960 MB', 'IS 100 MB').replace('090 KT', '999 KT'),
  );
  assert.equal(odd.pressureHpa, null);
  assert.equal(odd.windKt, null);
});

test('parseJtwcFeed returns no placeholder position or intensity', () => {
  const [storm] = parseJtwcFeed(feed('Typhoon'), NOW);
  assert.equal(storm.name, 'Test');
  assert.equal(storm.position, null);
  assert.equal(storm.windKt, null);
  assert.equal(storm.pressureHpa, null);
  assert.equal(
    storm.advisoryUrl,
    'https://www.metoc.navy.mil/jtwc/products/wp0126web.txt',
  );
});

test('parseJtwcFeed skips unsafe names and drops unsafe links', () => {
  const bad = feed('Typhoon').replace('(Test)', '(Te&lt;st&gt;)');
  assert.deepEqual(parseJtwcFeed(bad, NOW), []);
  const [noLink] = parseJtwcFeed(
    feed('Typhoon', 'https://evil.example/jtwc/products/x.txt'),
    NOW,
  );
  assert.equal(noLink.advisoryUrl, null);
});

function status(url) {
  return {
    activeStorms: [
      {
        id: 'al012026',
        name: 'Test',
        classification: 'TS',
        latitudeNumeric: 20,
        longitudeNumeric: -60,
        lastUpdate: '2026-01-06T12:00:00Z',
        forecastAdvisory: {
          issuance: '2026-01-06T12:00:00Z',
          advNum: '001',
          url,
        },
      },
    ],
  };
}

test('server advisory links allow NHC text and JTWC warning files only', () => {
  const link = (url) => parseCycloneStatus(status(url), NOW)[0].advisoryUrl;
  assert.equal(
    link('https://www.nhc.noaa.gov/text/MIATCPAT1.shtml'),
    'https://www.nhc.noaa.gov/text/MIATCPAT1.shtml',
  );
  assert.equal(
    link('https://www.metoc.navy.mil/jtwc/products/wp0126web.txt'),
    'https://www.metoc.navy.mil/jtwc/products/wp0126web.txt',
  );
  for (const bad of [
    'https://s3.amazonaws.com/www.metoc.navy.mil/jtwc/jtwc.html',
    'http://www.bom.gov.au/cyclone/',
    'https://www.bom.gov.au/cyclone/',
    'https://tcwc.bmkg.go.id/x',
    'http://www.nhc.noaa.gov/text/MIATCPAT1.shtml',
    'https://www.nhc.noaa.gov/text/MIATCPAT1.shtml?x=1',
    'https://www.metoc.navy.mil/jtwc/products/wp0126web.txt?x=1',
    'https://user@www.metoc.navy.mil/jtwc/products/wp0126web.txt',
    'https://www.metoc.navy.mil/jtwc/products/a/b.txt',
  ])
    assert.equal(link(bad), null, bad);
});
