// Minimal QR Code generator: byte mode, error-correction level M, versions 1-10 (up to 213 bytes). No dependencies.
// Returns a square matrix of 0/1 modules; the caller draws it. Algorithm follows ISO/IEC 18004.

const ECC_PER_BLOCK = [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26]; // level M, indexed by version
const NUM_BLOCKS = [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5];
const RAW_CODEWORDS = [0, 26, 44, 70, 100, 134, 172, 196, 242, 292, 346];
const ALIGN = [null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];

const MASKS = [
  (x, y) => (x + y) % 2 === 0,
  (x, y) => y % 2 === 0,
  (x, y) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => ((((x * y) % 2) + ((x * y) % 3)) % 2) === 0,
  (x, y) => ((((x + y) % 2) + ((x * y) % 3)) % 2) === 0,
];

// ---- Reed-Solomon over GF(256) with polynomial 0x11D
function gfMul(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}
function rsDivisor(degree) {
  const result = new Array(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = gfMul(result[j], root);
      if (j + 1 < result.length) result[j] ^= result[j + 1];
    }
    root = gfMul(root, 0x02);
  }
  return result;
}
function rsRemainder(data, divisor) {
  const result = divisor.map(() => 0);
  for (const b of data) {
    const factor = b ^ result.shift();
    result.push(0);
    divisor.forEach((coef, i) => {
      result[i] ^= gfMul(coef, factor);
    });
  }
  return result;
}

const bit = (value, i) => ((value >>> i) & 1) !== 0;

function penalty(m, size) {
  let p = 0;
  const pat1 = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
  const pat2 = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
  for (let dir = 0; dir < 2; dir++) {
    for (let a = 0; a < size; a++) {
      const get = (i) => (dir ? m[i][a] : m[a][i]);
      let run = 1;
      for (let i = 1; i < size; i++) {
        if (get(i) === get(i - 1)) {
          run++;
          if (run === 5) p += 3;
          else if (run > 5) p++;
        } else run = 1;
      }
      for (let i = 0; i + 11 <= size; i++) {
        let m1 = true;
        let m2 = true;
        for (let j = 0; j < 11; j++) {
          const v = get(i + j) ? 1 : 0;
          if (v !== pat1[j]) m1 = false;
          if (v !== pat2[j]) m2 = false;
        }
        if (m1) p += 40;
        if (m2) p += 40;
      }
    }
  }
  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const c = m[y][x];
      if (c === m[y][x + 1] && c === m[y + 1][x] && c === m[y + 1][x + 1]) p += 3;
    }
  }
  let dark = 0;
  for (const row of m) for (const v of row) if (v) dark++;
  const total = size * size;
  p += Math.max(0, Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
  return p;
}

export function makeQr(text) {
  const bytes = new TextEncoder().encode(text);

  // pick the smallest version that fits
  let ver = 1;
  for (;; ver++) {
    if (ver > 10) throw new Error('That link is too long for a QR code.');
    const dataCw = RAW_CODEWORDS[ver] - NUM_BLOCKS[ver] * ECC_PER_BLOCK[ver];
    if (4 + (ver < 10 ? 8 : 16) + bytes.length * 8 <= dataCw * 8) break;
  }
  const size = ver * 4 + 17;
  const nb = NUM_BLOCKS[ver];
  const ecc = ECC_PER_BLOCK[ver];
  const raw = RAW_CODEWORDS[ver];
  const dataCw = raw - nb * ecc;

  // ---- data bits
  const bits = [];
  const push = (val, len) => {
    for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1);
  };
  push(0b0100, 4);
  push(bytes.length, ver < 10 ? 8 : 16);
  for (const b of bytes) push(b, 8);
  push(0, Math.min(4, dataCw * 8 - bits.length));
  push(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < dataCw * 8; pad ^= 0xec ^ 0x11) push(pad, 8);
  const data = [];
  for (let i = 0; i < bits.length; i += 8) {
    let b = 0;
    for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
    data.push(b);
  }

  // ---- split into blocks, add error correction, interleave
  const shortBlocks = nb - (raw % nb);
  const shortLen = Math.floor(raw / nb);
  const divisor = rsDivisor(ecc);
  const blocks = [];
  let k = 0;
  for (let i = 0; i < nb; i++) {
    const len = shortLen - ecc + (i < shortBlocks ? 0 : 1);
    const d = data.slice(k, k + len);
    k += len;
    blocks.push({ d, e: rsRemainder(d, divisor) });
  }
  const all = [];
  const maxLen = Math.max(...blocks.map((b) => b.d.length));
  for (let i = 0; i < maxLen; i++) for (const b of blocks) if (i < b.d.length) all.push(b.d[i]);
  for (let i = 0; i < ecc; i++) for (const b of blocks) all.push(b.e[i]);

  // ---- function patterns
  const modules = Array.from({ length: size }, () => new Array(size).fill(false));
  const isFn = Array.from({ length: size }, () => new Array(size).fill(false));
  const setFn = (x, y, v) => {
    modules[y][x] = v;
    isFn[y][x] = true;
  };
  for (let i = 0; i < size; i++) {
    setFn(6, i, i % 2 === 0);
    setFn(i, 6, i % 2 === 0);
  }
  const finder = (cx, cy) => {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        const x = cx + dx;
        const y = cy + dy;
        if (x >= 0 && x < size && y >= 0 && y < size) setFn(x, y, dist !== 2 && dist !== 4);
      }
    }
  };
  finder(3, 3);
  finder(size - 4, 3);
  finder(3, size - 4);
  const pos = ALIGN[ver];
  for (let i = 0; i < pos.length; i++) {
    for (let j = 0; j < pos.length; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === pos.length - 1) || (i === pos.length - 1 && j === 0)) continue;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) setFn(pos[i] + dx, pos[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
  }
  const drawFormat = (mask) => {
    const d = (0 << 3) | mask; // error-correction level M = 00
    let rem = d;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const f = ((d << 10) | rem) ^ 0x5412;
    for (let i = 0; i <= 5; i++) setFn(8, i, bit(f, i));
    setFn(8, 7, bit(f, 6));
    setFn(8, 8, bit(f, 7));
    setFn(7, 8, bit(f, 8));
    for (let i = 9; i < 15; i++) setFn(14 - i, 8, bit(f, i));
    for (let i = 0; i < 8; i++) setFn(size - 1 - i, 8, bit(f, i));
    for (let i = 8; i < 15; i++) setFn(8, size - 15 + i, bit(f, i));
    setFn(8, size - 8, true); // always-dark module
  };
  drawFormat(0); // reserve the area
  if (ver >= 7) {
    let rem = ver;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const v = (ver << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      setFn(a, b, bit(v, i));
      setFn(b, a, bit(v, i));
    }
  }

  // ---- place codewords in the zig-zag order
  let n = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (!isFn[y][x] && n < all.length * 8) {
          modules[y][x] = bit(all[n >>> 3], 7 - (n & 7));
          n++;
        }
      }
    }
  }

  // ---- choose the mask with the lowest penalty
  let best = null;
  let bestMask = 0;
  let bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    const trial = modules.map((row) => row.slice());
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!isFn[y][x] && MASKS[mask](x, y)) trial[y][x] = !trial[y][x];
    const saved = modules.map((row) => row.slice());
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) modules[y][x] = trial[y][x];
    drawFormat(mask);
    const score = penalty(modules, size);
    if (score < bestScore) {
      bestScore = score;
      bestMask = mask;
      best = modules.map((row) => row.slice());
    }
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) modules[y][x] = saved[y][x];
  }
  return { size, version: ver, mask: bestMask, modules: best.map((row) => row.map((v) => (v ? 1 : 0))) };
}
