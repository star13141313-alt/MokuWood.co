/*
 * Phase 1: Copy product images from Supabase Storage to Cloudflare R2.
 * This script DOES NOT update Supabase database rows or delete source files.
 *
 * Requirements:
 *   npm install @supabase/supabase-js @aws-sdk/client-s3 dotenv
 *
 * Create a local .env file (do NOT commit it):
 *   SUPABASE_URL=...
 *   SUPABASE_SECRET_KEY=sb_secret_...
 *   R2_ACCOUNT_ID=...
 *   R2_ACCESS_KEY_ID=...
 *   R2_SECRET_ACCESS_KEY=...
 *   R2_BUCKET=mokuwood-images
 *
 * Run:
 *   node scripts/migrate-images-to-r2.mjs
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { S3Client, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';

const required = [
  'SUPABASE_URL',
  'SUPABASE_SECRET_KEY',
  'R2_ACCOUNT_ID',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
];

const missing = required.filter((key) => !process.env[key]);
if (missing.length) {
  throw new Error(`Missing environment variables: ${missing.join(', ')}`);
}

const BUCKET = process.env.R2_BUCKET || 'mokuwood-images';
const SOURCE_BUCKET = 'product-images';
const IMAGE_COLUMNS = ['image', 'image_2', 'image_3'];
const SOURCE_PREFIX = `${process.env.SUPABASE_URL}/storage/v1/object/public/${SOURCE_BUCKET}/`;

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SECRET_KEY,
  { auth: { persistSession: false } }
);

const r2 = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

function keyFromUrl(value) {
  if (!value || typeof value !== 'string') return null;
  if (!value.startsWith(SOURCE_PREFIX)) return null;
  return decodeURIComponent(value.slice(SOURCE_PREFIX.length));
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

async function alreadyExists(key) {
  try {
    await r2.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
    return true;
  } catch (error) {
    if (error?.$metadata?.httpStatusCode === 404 || error?.name === 'NotFound') return false;
    return false;
  }
}

async function copyOne(key) {
  if (await alreadyExists(key)) {
    return { key, status: 'skipped' };
  }

  const { data, error } = await supabase.storage.from(SOURCE_BUCKET).download(key);
  if (error) throw new Error(`${key}: ${error.message}`);

  const body = new Uint8Array(await data.arrayBuffer());
  const contentType = data.type || 'application/octet-stream';

  await r2.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: body,
    ContentType: contentType,
    CacheControl: 'public, max-age=31536000, immutable',
  }));

  return { key, status: 'copied', bytes: body.byteLength };
}

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

const results = { copied: [], skipped: [], failed: [] };

for (const key of keys) {
  try {
    const result = await copyOne(key);
    results[result.status].push(result);
    console.log(`${result.status.toUpperCase()}: ${key}`);
  } catch (error) {
    results.failed.push({ key, error: error.message });
    console.error(`FAILED: ${key}`, error.message);
  }
}

console.log('\nMigration summary');
console.log(`Copied : ${results.copied.length}`);
console.log(`Skipped: ${results.skipped.length}`);
console.log(`Failed : ${results.failed.length}`);

if (results.failed.length) {
  console.log('\nFailed files:');
  for (const item of results.failed) console.log(`- ${item.key}: ${item.error}`);
  process.exitCode = 1;
}
