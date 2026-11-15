/**
 * Golden: extraction and the catalogue agree on real events.
 *
 * Each fixture is one event from the lab's Splunk (index main), with the
 * sourcetype it is stored under. Everything the extractor finds that is worth a
 * Splunk search must resolve to a field in that index — via a catalogue role or a
 * common name the catalogue lists. A type that cannot is either a gap in
 * catalog/splunk-catalog.json or catalog/indicator-types.json, or is named in the
 * fixture's `unaimedTypes` with the reason it is acceptable.
 *
 * This is the check that would have caught `php-webshell.php` being extracted as
 * a domain and then failing to aim at a web log, which has no domain field.
 *
 * Runs against the build: npm run test:golden
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readdirSync, readFileSync } = require('node:fs');
const { join } = require('node:path');

const ROOT = join(__dirname, '..', '..');
process.env.SPLUNK_CATALOG_FILE ??= join(ROOT, 'catalog', 'splunk-catalog.json');
process.env.INDICATOR_TYPES_FILE ??= join(ROOT, 'catalog', 'indicator-types.json');

const { IocService } = require(join(ROOT, 'dist/modules/enrichment/ioc.service'));
const { CatalogService } = require(join(ROOT, 'dist/modules/enrichment/catalog.service'));
const { indicatorRegistry } = require(join(ROOT, 'dist/modules/enrichment/indicator-registry'));

const config = { get: () => [] };
const ioc = new IocService(config);
const catalog = new CatalogService();
catalog.onModuleInit();

const FIXTURES = join(__dirname, 'fixtures');

test('the catalogue loaded', () => {
  assert.ok(catalog.loaded, `no catalogue at ${process.env.SPLUNK_CATALOG_FILE}`);
});

test('every role the catalogue uses is one the indicator types know', () => {
  const registry = indicatorRegistry();
  const known = new Set([
    ...Object.values(registry.types).flatMap((t) => t.roles),
    ...Object.values(registry.detailKeys).flat(),
  ]);
  const raw = JSON.parse(readFileSync(process.env.SPLUNK_CATALOG_FILE, 'utf8'));
  for (const [index, entry] of Object.entries(raw.indexes ?? {})) {
    for (const [st, s] of Object.entries(entry.sourcetypes ?? {})) {
      for (const role of Object.keys(s.roles ?? {})) {
        assert.ok(known.has(role), `${index}/${st} has role "${role}", which no indicator type or detail key uses`);
      }
    }
  }
});

for (const file of readdirSync(FIXTURES).filter((f) => f.endsWith('.json')).sort()) {
  const fx = JSON.parse(readFileSync(join(FIXTURES, file), 'utf8'));

  test(`${file}: every searchable value is aimed in ${fx.index}/${fx.sourcetype}`, () => {
    const { indicators, skipped } = ioc.extract(fx.raw);
    const searchable = [...indicators, ...skipped.filter((s) => s.searchable)];
    assert.ok(searchable.length > 0, 'nothing searchable was extracted');

    const unaimed = [];
    for (const i of searchable) {
      if (fx.unaimedTypes?.[i.type]) continue;
      const where = catalog.resolveIndicator(i.type, fx.index, fx.sourcetype);
      // Aimed somewhere else in the estate is not aimed at this event's data.
      if (where.fields.length === 0 || where.scope === 'estate') unaimed.push(`${i.type} ${i.value} (${where.scope})`);
    }
    assert.deepEqual(unaimed, [], 'values with no field in this index — add a role or a cim name, or list the type in unaimedTypes');
  });

  test(`${file}: expected values land in the expected fields`, () => {
    const { indicators, skipped } = ioc.extract(fx.raw);
    const all = [...indicators, ...skipped.filter((s) => s.searchable)];
    for (const want of fx.expect ?? []) {
      const got = all.find((i) => i.value.toLowerCase() === want.value.toLowerCase());
      assert.ok(got, `${want.value} was not extracted as searchable`);
      assert.equal(got.type, want.type, `${want.value} extracted as ${got.type}`);
      const where = catalog.resolveIndicator(got.type, fx.index, fx.sourcetype);
      assert.deepEqual(where.fields, want.fields, `${want.value} aimed at ${where.fields.join(', ') || 'nothing'}`);
    }
  });
}
