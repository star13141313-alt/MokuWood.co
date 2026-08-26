/*
 * Phase 1: Copy product images from Supabase Storage to Cloudflare R2
 * through the mokuwood-images Worker.
 * This script does NOT update Supabase database rows or delete source files.
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const required = [
  'SUPABASE_URL',
  'SUPABASE_SECRET_KEY',
  'WORKER_URL',
  'MIGRATION_TOKEN',
];

const missing = required.filter((key) => !process.env[key]);
if (missing.length) {
  throw new Error(`Missing environment variables: ${missing.join(', ')}`);
}

const SOURCE_BUCKET = 'product-images';
const IMAGE_COLUMNS = ['image', 'image_2', 'image_3'];
const SOURCE_PREFIX = `${process.env.SUPABASE_URL}/storage/v1/object/public/${SOURCE_BUCKET}/`;
const WORKER_URL = process.env.WORKER_URL.replace(/\/+$/, '');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SECRET_KEY,
  { auth: { persistSession: false } }
);

function keyFromUrl(value) {
  if (!value || typeof value !== 'string') return null;
  if (!value.startsWith(SOURCE_PREFIX)) return null;
  return decodeURIComponent(value.slice(SOURCE_PREFIX.length));
}

function workerUrlForKey(key) {
  return `${WORKER_URL}/${key.split('/').map(encodeURIComponent).join('/')}`;
}

async function listAllProducts() {
  const all = [];
  const pageSize = 1000;
  let from = 0;

  while (true) {
    const { data, error } = await supabase
      .from('products')
      .select(`id, ${IMAGE_COLUMNS.join(', ')}`)
      .range(from, from + pageSize - 1);

    if (error) throw error;
    all.push(...data);

    if (data.length < pageSize) break;
    from += pageSize;
  }

  return all;
}

async function copyOne(key) {
  const { data, error } = await supabase.storage.from(SOURCE_BUCKET).download(key);
  if (error) throw new Error(`${key}: ${error.message}`);

  const body = new Uint8Array(await data.arrayBuffer());
  const contentType = data.type || 'application/octet-stream';

  const response = await fetch(workerUrlForKey(key), {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${process.env.MIGRATION_TOKEN}`,
      'Content-Type': contentType,
    },
    body,
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Worker upload failed (${response.status}): ${detail}`);
  }

  return { key, bytes: body.byteLength };
}

console.log(`Worker endpoint: ${WORKER_URL}`);
console.log('Testing Worker connection...');
const healthResponse = await fetch(WORKER_URL);
if (!healthResponse.ok) {
  throw new Error(`Worker health check failed (${healthResponse.status})`);
}
console.log(`Worker connection OK (${healthResponse.status}).`);

const products = await listAllProducts();
const keys = new Set();

for (const product of products) {
  for (const column of IMAGE_COLUMNS) {
    const key = keyFromUrl(product[column]);
    if (key) keys.add(key);
  }
}

console.log(`Found ${products.length} products.`);
console.log(`Found ${keys.size} unique Supabase product images.`);

const results = { copied: [], failed: [] };

for (const key of keys) {
  try {
    const result = await copyOne(key);
    results.copied.push(result);
    console.log(`COPIED: ${key}`);
  } catch (error) {
    results.failed.push({ key, error: error.message });
    console.error(`FAILED: ${key}`, error.message);
  }
}

console.log('\nMigration summary');
console.log(`Copied : ${results.copied.length}`);
console.log(`Failed : ${results.failed.length}`);

if (results.failed.length) process.exitCode = 1;
