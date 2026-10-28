import { readFile } from 'node:fs/promises';
import { ApiError } from './http.js';

const pngSignature = Buffer.from('89504e470d0a1a0a', 'hex');
const imageMimes = new Set(['image/jpeg', 'image/png', 'image/heic', 'image/heif']);
const audioMimes = new Set(['audio/mp4', 'audio/x-m4a', 'audio/m4a']);

function boxes(buffer, start = 0, end = buffer.length) {
  const result = [];
  let offset = start;
  while (offset < end) {
    if (end - offset < 8) return null;
    let size = buffer.readUInt32BE(offset);
    let header = 8;
    if (size === 1) {
      if (end - offset < 16) return null;
      const large = buffer.readBigUInt64BE(offset + 8);
      if (large > BigInt(Number.MAX_SAFE_INTEGER)) return null;
      size = Number(large);
      header = 16;
    } else if (size === 0) {
      size = end - offset;
    }
    if (size < header || offset + size > end) return null;
    result.push({ type: buffer.toString('ascii', offset + 4, offset + 8), start: offset + header, end: offset + size });
    offset += size;
  }
  return result;
}

function jpegValid(buffer) {
  if (buffer.length < 16 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return false;
  let offset = 2;
  let hasFrame = false;
  while (offset < buffer.length - 2) {
    if (buffer[offset++] !== 0xff) return false;
    while (buffer[offset] === 0xff) offset++;
    const marker = buffer[offset++];
    if (marker === 0xda) {
      if (!hasFrame || offset + 2 > buffer.length) return false;
      const length = buffer.readUInt16BE(offset);
      offset += length;
      if (length < 2 || offset > buffer.length - 2) return false;
      // Entropy bytes may contain stuffed FF00 and restart markers.
      let nextScan = false;
      while (offset < buffer.length - 1) {
        if (buffer[offset] === 0xff) {
          const next = buffer[offset + 1];
          if (next === 0xd9) return offset + 2 === buffer.length;
          if (next === 0x00 || next >= 0xd0 && next <= 0xd7) offset += 2;
          else { nextScan = true; break; }
        } else offset++;
      }
      if (!nextScan) return false;
      continue;
    }
    if (offset + 2 > buffer.length) return false;
    const length = buffer.readUInt16BE(offset);
    if (length < 2 || offset + length > buffer.length) return false;
    if ([0xc0, 0xc1, 0xc2].includes(marker)) {
      if (length < 8 || buffer.readUInt16BE(offset + 3) === 0 || buffer.readUInt16BE(offset + 5) === 0) return false;
      hasFrame = true;
    }
    offset += length;
  }
  return false;
}

const crcTable = Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});

function crc32(buffer, start, end) {
  let crc = 0xffffffff;
  for (let i = start; i < end; i++) crc = crcTable[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngValid(buffer) {
  if (buffer.length < 45 || !buffer.subarray(0, 8).equals(pngSignature)) return false;
  let offset = 8;
  let hasImageData = false;
  let first = true;
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    if (length > buffer.length - offset - 12) return false;
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    if (crc32(buffer, offset + 4, offset + 8 + length) !== buffer.readUInt32BE(offset + 8 + length)) return false;
    if (first && (type !== 'IHDR' || length !== 13 || buffer.readUInt32BE(offset + 8) === 0 || buffer.readUInt32BE(offset + 12) === 0)) return false;
    if (type === 'IDAT' && length > 0) hasImageData = true;
    offset += length + 12;
    if (type === 'IEND') return length === 0 && hasImageData && offset === buffer.length;
    first = false;
  }
  return false;
}

function heifValid(buffer, mime) {
  const top = boxes(buffer);
  if (!top || top[0]?.type !== 'ftyp') return false;
  const ftyp = top[0];
  if (ftyp.end - ftyp.start < 8) return false;
  const majorBrand = buffer.toString('ascii', ftyp.start, ftyp.start + 4);
  const brands = [];
  for (let at = ftyp.start; at + 4 <= ftyp.end; at += 4) {
    if (at === ftyp.start + 4) continue; // minor version
    brands.push(buffer.toString('ascii', at, at + 4));
  }
  // A still HEIC may advertise hevc compatibility; sequence/video major brands
  // and timed tracks are what distinguish content we do not accept here.
  if (['hevc', 'hevx', 'msf1', 'avif', 'avis'].includes(majorBrand) || top.some((box) => box.type === 'moov')) return false;
  if (!brands.some((brand) => mime === 'image/heic' ? ['heic', 'heix'].includes(brand) : ['mif1', 'heic', 'heix'].includes(brand))) return false;
  const meta = top.find((box) => box.type === 'meta');
  if (!meta || meta.end - meta.start < 12) return false;
  const children = boxes(buffer, meta.start + 4, meta.end);
  // A still image needs a primary item, an item description, item location,
  // and image properties. An ftyp/meta/mdat shell is not a usable HEIF image.
  if (!children || !['pitm', 'iinf', 'iloc', 'iprp'].every((type) => children.some((box) => box.type === type))) return false;
  const handler = children?.find((box) => box.type === 'hdlr');
  const data = top.some((box) => box.type === 'mdat' && box.end > box.start) || children?.some((box) => box.type === 'idat' && box.end > box.start);
  return !!data && !!handler && handler.end - handler.start >= 12 && buffer.toString('ascii', handler.start + 8, handler.start + 12) === 'pict';
}

function audioMp4Valid(buffer) {
  const top = boxes(buffer);
  if (!top || top[0]?.type !== 'ftyp') return false;
  const brands = buffer.toString('ascii', top[0].start, top[0].end);
  if (!/(M4A |isom|iso2|mp41|mp42)/.test(brands)) return false;
  const moov = top.find((box) => box.type === 'moov');
  const mdat = top.find((box) => box.type === 'mdat' && box.end - box.start >= 16);
  if (!moov || !mdat) return false;
  const tracks = boxes(buffer, moov.start, moov.end)?.filter((box) => box.type === 'trak') || [];
  if (!tracks.length) return false;
  let sound = false;
  for (const track of tracks) {
    const mdia = boxes(buffer, track.start, track.end)?.find((box) => box.type === 'mdia');
    if (!mdia) return false;
    const handler = boxes(buffer, mdia.start, mdia.end)?.find((box) => box.type === 'hdlr');
    if (!handler || handler.end - handler.start < 12) return false;
    const type = buffer.toString('ascii', handler.start + 8, handler.start + 12);
    if (type === 'vide') return false;
    if (type === 'soun') sound = true;
  }
  // The phone's M4A voice notes contain an AAC mp4a sample entry.
  return sound && buffer.subarray(moov.start, moov.end).includes(Buffer.from('mp4a'));
}

export async function verifyMedia(file) {
  const declared = file.declaredMime.toLowerCase();
  if (file.kind === 'photo' ? !imageMimes.has(declared) : !audioMimes.has(declared)) throw new ApiError('UNSUPPORTED_MEDIA_TYPE', [{ field: file.fieldName, reason: 'Unsupported declared media type' }]);
  const bytes = await readFile(file.stagedPath);
  if (!bytes.length) throw new ApiError('UNSUPPORTED_MEDIA_TYPE', [{ field: file.fieldName, reason: 'Empty file' }]);
  const valid = declared === 'image/jpeg' ? jpegValid(bytes)
    : declared === 'image/png' ? pngValid(bytes)
    : declared === 'image/heic' || declared === 'image/heif' ? heifValid(bytes, declared)
    : audioMp4Valid(bytes);
  if (!valid) throw new ApiError('UNSUPPORTED_MEDIA_TYPE', [{ field: file.fieldName, reason: 'File content does not match a supported format' }]);
  return declared.startsWith('audio/') ? 'audio/mp4' : declared;
}
