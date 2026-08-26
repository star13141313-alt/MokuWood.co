/*
 * Phase 1: Copy product images from Supabase Storage to Cloudflare R2.
 * This script DOES NOT update Supabase database rows or delete source files.
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { S3Client, PutObjectCommand, HeadObjectCommand, ListBucketsCommand } from '@aws-sdk/client-s3';
import https from 'node:https';

const required = [
  'SUPABASE_URL',
  'SUPABASE_SECRET_KEY',
  'R2_ACCOUNT_ID',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
];

const missing = required.filter((key) => !process.env[key]);
if (missing.length) throw new Error(`Missing environment variables: ${missing.join(', ')}`);

const BUCKET = process.env.R2_BUCKET || 'mokuwood-images';
const SOURCE_BUCKET = 'product-images';
const IMAGE_COLUMNS = ['image', 'image_2', 'image_3'];
const SOURCE_PREFIX = `${process.env.SUPABASE_URL}/storage/v1/object/public/${SOURCE_BUCKET}/`;
const ACCOUNT_ID = process.env.R2_ACCOUNT_ID.trim();
const R2_ENDPOINT = `https://${ACCOUNT_ID}.r2.cloudflarestorage.com`;

console.log(`R2 Account ID length: ${ACCOUNT_ID.length}`);
console.log(`R2 endpoint: ${R2_ENDPOINT}`);

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SECRET_KEY,
  { auth: { persistSession: false } }
);

const r2 = new S3Client({
  region: 'auto',
  endpoint: R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID.trim(),
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY.trim(),
  },
});

function httpsProbe(url) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, (response) => {
      response.resume();
      resolve(response.statusCode);
    });
    request.setTimeout(10000, () => request.destroy(new Error('HTTPS probe timed out')));
    request.on('error', reject);
  });
}

console.log('Testing raw HTTPS connection to R2...');
try {
  const status = await httpsProbe(R2_ENDPOINT);
  console.log(`R2 HTTPS probe response: ${status}`);
} catch (error) {
  throw new Error(`Cannot establish HTTPS connection to R2 endpoint: ${error.message}`);
}

console.log('Testing authenticated R2 access...');
try {
  const response = await r2.send(new ListBucketsCommand({}));
  const names = (response.Buckets || []).map((bucket) => bucket.Name);
  console.log(`Authenticated R2 access OK. Buckets visible: ${names.join(', ')}`);
  if (!names.includes(BUCKET)) throw new Error(`Configured bucket "${BUCKET}" is not visible to this token`);
} catch (error) {
  throw new Error(`R2 authenticated access failed: ${error.message}`);
}

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
    throw error;
  }
}

async function copyOne(key) {
  if (await alreadyExists(key)) return { key, status: 'skipped' };
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
if (results.failed.length) process.exitCode = 1;
