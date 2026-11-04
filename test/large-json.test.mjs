import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {parseJson, writeJson, jsonBytes, jsonBuffer, updateJson} from '../src/large-json.mjs';

// Random values with the strings that matter here: images, escaped quotes,
// image-looking keys and text, backslashes and non-ASCII.
function generator(seed) {
  let state = seed;
  const next = () => (state = (state*1103515245+12345) % 2147483648) / 2147483648;
  const pick = list => list[Math.floor(next()*list.length)];
  const text = () => pick(['', 'plain', 'é ünï', 'quote " inside', 'back\\slash', '"data:image/png;base64,AAAA"', 'data:image/png;base64,QUJD', 'line\nbreak', ' ', 'tab\t']);
  const image = () => 'data:image/'+pick(['png', 'jpeg', 'webp'])+';base64,'+'QUJD'.repeat(Math.floor(next()*50))+pick(['', '=', '=='])+pick(['', '', '\\', '"']);
  const value = depth => {
    const kind = depth > 3 ? Math.floor(next()*4) : Math.floor(next()*7);
    if (kind === 0) return pick([null, true, false, 0, -1.5, 1e21, 42]);
    if (kind === 1 || kind === 2) return next() < 0.5 ? image() : text();
    if (kind === 3) return text();
    if (kind === 4) return Array.from({length: Math.floor(next()*4)}, () => value(depth+1));
    const object = {};
    for (let i = Math.floor(next()*4); i > 0; i--) object[pick(['type', 'image_url', 'data:image/png;base64,QUJD', 'text', 'output', '__proto__', 'é'])+(next() < 0.3 ? i : '')] = value(depth+1);
    return object;
  };
  return {value, next, pick};
}
// Whitespace between tokens, as another JSON writer could put it.
function spacing(text, g) {
  let out = '', inside = false, escaped = false;
  for (const c of text) {
    out += c;
    if (inside) { if (escaped) escaped = false; else if (c === '\\') escaped = true; else if (c === '"') inside = false; continue; }
    if (c === '"') inside = true;
    else if (',:[]{}'.includes(c) && g.next() < 0.2) out += g.pick([' ', '\n', '\t ', '\r\n']);
  }
  return out;
}

test('a large body reads the same as JSON.parse reads it', () => {
  for (let seed = 1; seed <= 400; seed++) {
    const g = generator(seed);
    const value = {input: [g.value(0), g.value(0), {type: 'input_image', image_url: 'data:image/png;base64,'+'A'.repeat(seed)}]};
    const text = spacing(JSON.stringify(value), g);
    assert.deepEqual(parseJson(Buffer.from(text), {large: 0}), JSON.parse(text), text.slice(0, 300));
  }
});

test('a large body with an image key, escapes and no images still reads the same', () => {
  const cases = ['{"data:image/png;base64,QUJD": "data:image/png;base64,QUJD"}', '{"a":"x\\"data:image/png;base64,AA\\"","b":["data:image/png;base64,QQ\\u0041"]}',
    '["data:image/png;base64,AA" , "data:image/png;base64,BB"]', '{"a":"x\\"data:image/png;base64,AAA","b":"data:image/png;base64,BB"}', '{"none":[1,2,3]}', '"data:image/png;base64,QUJD"'];
  for (const text of cases) assert.deepEqual(parseJson(Buffer.from(text), {large: 0}), JSON.parse(text), text);
});

test('JSON written in pieces, and its size and hash, match JSON.stringify', () => {
  const extra = [undefined, () => 1, Symbol('s'), {toJSON: () => 'from toJSON'}, {a: undefined, b: () => 1, c: [undefined, () => 1], d: {toJSON: key => 'key '+key}},
    new Date(0), [{toJSON: () => undefined}], {e: {toJSON: () => undefined}}, NaN, -0, 'x'.repeat(200*1024)];
  for (let seed = 1; seed <= 300; seed++) {
    const g = generator(seed);
    const value = seed <= extra.length ? extra[seed-1] : g.value(0);
    const expected = JSON.stringify(value);
    let written = '';
    const wrote = writeJson(value, piece => { written += piece; });
    if (expected === undefined) { assert.equal(wrote, false); continue; }
    assert.equal(written, expected);
    assert.equal(jsonBytes(value, {large: 0}), Buffer.byteLength(expected));
    assert.equal(jsonBuffer(value, {large: 0}).toString(), expected);
    assert.equal(updateJson(createHash('sha256'), value, {large: 0}).digest('hex'), createHash('sha256').update(expected).digest('hex'));
  }
});
