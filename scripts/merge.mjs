#!/usr/bin/env node
// Slår ihop exporter från importverktyget med data/listings.json.
// Användning: node scripts/merge.mjs fil1.json [fil2.json ...]
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const target = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'listings.json');
const files = process.argv.slice(2);
if (!files.length) {
  console.error('Användning: node scripts/merge.mjs <export.json> [fler.json ...]');
  process.exit(1);
}

const read = (p) => {
  const d = JSON.parse(readFileSync(p, 'utf8'));
  return Array.isArray(d) ? d : d.listings || [];
};
const valid = (l) => l && l.id && Number(l.soldPrice) > 0 && Array.isArray(l.images) && l.images.length;

const byId = new Map();
if (existsSync(target)) for (const l of read(target)) byId.set(l.id, l);
const before = byId.size;
for (const f of files) {
  let added = 0;
  for (const l of read(f).filter(valid)) {
    if (!byId.has(l.id)) added++;
    byId.set(l.id, { ...byId.get(l.id), ...l });
  }
  console.log(`${f}: ${added} nya`);
}
const listings = [...byId.values()].sort((a, b) => String(b.soldDate).localeCompare(String(a.soldDate)));
writeFileSync(target, JSON.stringify({ version: 1, updated: new Date().toISOString(), listings }) + '\n');
console.log(`data/listings.json: ${before} → ${listings.length} bostäder`);
