// utils/supabaseStorage.js — Supabase Storage client for file uploads
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || '';

let supabase = null;

function getSupabase() {
  if (!supabase && SUPABASE_URL && SUPABASE_SERVICE_KEY) {
    supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  }
  return supabase;
}

/**
 * Upload a file to Supabase Storage
 * @param {string} bucket - Storage bucket name
 * @param {string} path - File path in bucket (e.g. 'promos/image.jpg')
 * @param {Buffer} fileBuffer - File content
 * @param {string} contentType - MIME type
 * @returns {Promise<{url: string}|null>}
 */
async function uploadFile(bucket, path, fileBuffer, contentType) {
  const sb = getSupabase();
  if (!sb) throw new Error('Supabase not configured');

  const { data, error } = await sb.storage
    .from(bucket)
    .upload(path, fileBuffer, {
      contentType,
      upsert: true,
    });

  if (error) throw error;

  const { data: urlData } = sb.storage.from(bucket).getPublicUrl(path);
  return { url: urlData.publicUrl };
}

/**
 * Delete a file from Supabase Storage
 * @param {string} bucket
 * @param {string} path
 */
async function deleteFile(bucket, path) {
  const sb = getSupabase();
  if (!sb) return;
  await sb.storage.from(bucket).remove([path]);
}

module.exports = { getSupabase, uploadFile, deleteFile };
