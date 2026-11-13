'use strict';
const sharp = require('sharp');
const { fail } = require('./validation');
const MAX_BYTES = 4 * 1024 * 1024;
async function normalizeImage(bytes, kind) {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MAX_BYTES) fail('Upload a JPEG, PNG or WebP image up to 4 MB.', 413);
  try {
    const input = sharp(bytes, { failOn: 'warning', limitInputPixels: 20000000 });
    const meta = await input.metadata();
    if (!['jpeg','png','webp'].includes(meta.format) || (meta.pages || 1) !== 1 || meta.width < 32 || meta.height < 32) fail('Use a static JPEG, PNG or WebP image at least 32 × 32 pixels.');
    const bound = kind === 'logo' ? 512 : kind === 'banner' ? 1600 : 1920;
    // Decode and re-encode, rather than trusting headers/extensions. No input
    // metadata, executable bytes, or caller-supplied file names are retained.
    const result = await input.rotate().resize({ width: bound, height: bound, fit: 'inside', withoutEnlargement: true }).webp({ quality: 82 }).toBuffer({ resolveWithObject: true });
    return { bytes: result.data, width: result.info.width, height: result.info.height };
  } catch (error) {
    if (error.status) throw error;
    fail('The image is corrupt, too large in dimensions, animated, or unsupported.');
  }
}
module.exports = { normalizeImage, MAX_BYTES };
