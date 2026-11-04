import {randomUUID} from 'node:crypto';

// The desktop sends the whole thread with each request, screenshots included.
// V8 can't hold a string longer than 512 MiB, and a thread full of screenshots
// passes that, so a large body is read, measured and hashed without ever being
// one string. Each function gives the same result as its plain JSON version.

// A chat carries every screenshot in it, so requests can be large.
export const MAX_REQUEST_BYTES = 1024*1024*1024;
// Above this, a body is read with its images cut out first.
export const LARGE_BODY_BYTES = 64*1024*1024;
// Above this estimated length, JSON is measured and hashed in pieces.
const LARGE_JSON_CHARS = 256*1024*1024;
const CHUNK = 64*1024;
const IMAGE = Buffer.from('"data:image/');
const QUOTE = 0x22, BACKSLASH = 0x5c;
const SPACE = new Set([0x20, 0x09, 0x0a, 0x0d]);

// Parses a request body. In a large one, each "data:image/..." string is cut
// out of the bytes and put back once the rest has been parsed, so the text
// JSON.parse reads stays small.
export function parseJson(bytes, {large = LARGE_BODY_BYTES} = {}) {
  if (bytes.length <= large) return JSON.parse(bytes.toString());
  const marker = `bridge-image-${randomUUID()}-`;
  const parts = [], images = [];
  let at = 0;
  for (let i = bytes.indexOf(IMAGE); i >= 0; i = bytes.indexOf(IMAGE, i+1)) {
    // A quote after a backslash is inside another string.
    if (i > 0 && bytes[i-1] === BACKSLASH) continue;
    const end = bytes.indexOf(QUOTE, i+1);
    if (end < 0) break;
    // A string with escapes, or an object key, stays for JSON.parse.
    if (bytes.subarray(i+1, end).includes(BACKSLASH)) continue;
    let next = end+1;
    while (next < bytes.length && SPACE.has(bytes[next])) next++;
    if (bytes[next] === 0x3a) continue;
    parts.push(bytes.subarray(at, i+1), Buffer.from(marker+images.length));
    images.push(bytes.subarray(i+1, end));
    at = end;
    i = end;
  }
  if (!images.length) return JSON.parse(bytes.toString());
  parts.push(bytes.subarray(at));
  const body = JSON.parse(Buffer.concat(parts).toString());
  const restore = value => {
    if (typeof value === 'string') return value.startsWith(marker) ? images[Number(value.slice(marker.length))].toString() : value;
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) { const kept = restore(value[i]); if (kept !== value[i]) value[i] = kept; }
    } else if (value && typeof value === 'object') {
      for (const key of Object.keys(value)) { const kept = restore(value[key]); if (kept !== value[key]) value[key] = kept; }
    }
    return value;
  };
  return restore(body);
}

// Whether JSON.stringify(value) would be at least about this long. Counts
// string lengths and a little for structure, and stops once past the limit.
function isLarge(value, limit = LARGE_JSON_CHARS) {
  let total = 0;
  const stack = [value];
  while (stack.length && total <= limit) {
    const item = stack.pop();
    if (typeof item === 'string') total += item.length+2;
    else if (Array.isArray(item)) { total += item.length+1; for (const x of item) stack.push(x); }
    else if (item && typeof item === 'object') { for (const key of Object.keys(item)) { total += key.length+4; stack.push(item[key]); } }
    else total += 4;
  }
  return total > limit;
}

const skipped = value => value === undefined || typeof value === 'function' || typeof value === 'symbol';
// JSON.stringify calls toJSON once on each value before writing it.
const prepare = (value, key) => value !== null && (typeof value === 'object' || typeof value === 'bigint') && typeof value.toJSON === 'function' ? value.toJSON(key) : value;

// The text of JSON.stringify(value), handed to write in pieces. False when
// JSON.stringify would give undefined.
export function writeJson(value, write) {
  let text = '';
  const flush = () => { if (text) { write(text); text = ''; } };
  const emit = piece => {
    if (piece.length > CHUNK) { flush(); write(piece); return; }
    text += piece;
    if (text.length > CHUNK) flush();
  };
  const visit = item => {
    if (item === null || typeof item !== 'object') { emit(JSON.stringify(item)); return; }
    if (Array.isArray(item)) {
      emit('[');
      for (let i = 0; i < item.length; i++) {
        if (i) emit(',');
        const element = prepare(item[i], String(i));
        if (skipped(element)) emit('null'); else visit(element);
      }
      emit(']');
      return;
    }
    emit('{');
    let first = true;
    for (const name of Object.keys(item)) {
      const member = prepare(item[name], name);
      if (skipped(member)) continue;
      emit((first ? '' : ',')+JSON.stringify(name)+':');
      first = false;
      visit(member);
    }
    emit('}');
  };
  value = prepare(value, '');
  if (skipped(value)) return false;
  visit(value);
  flush();
  return true;
}

// Buffer.byteLength(JSON.stringify(value)).
export function jsonBytes(value, {large = LARGE_JSON_CHARS} = {}) {
  if (!isLarge(value, large)) return Buffer.byteLength(JSON.stringify(value));
  let bytes = 0;
  writeJson(value, piece => { bytes += Buffer.byteLength(piece); });
  return bytes;
}

// Buffer.from(JSON.stringify(value)).
export function jsonBuffer(value, {large = LARGE_JSON_CHARS} = {}) {
  if (!isLarge(value, large)) return Buffer.from(JSON.stringify(value));
  const pieces = [];
  writeJson(value, piece => pieces.push(Buffer.from(piece)));
  return Buffer.concat(pieces);
}

// hash.update(JSON.stringify(value)), for a value JSON can represent.
export function updateJson(hash, value, {large = LARGE_JSON_CHARS} = {}) {
  if (!isLarge(value, large)) return hash.update(JSON.stringify(value));
  if (!writeJson(value, piece => hash.update(piece))) hash.update(undefined);
  return hash;
}
