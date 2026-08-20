/**
 * 多模态知识库可行性实验 E2 — pHash 近重复去重（ADR 0009 待验证项）
 *
 * 职责边界：pHash 只做「同图近重复去重」（压缩/转码/轻微重缩放/轻微亮度对比度），
 *           不做几何不变性（旋转/裁剪归 SigLIP 视觉向量职责，不进本实验）。
 * 输出单位钉死：8×8 DCT → 64bit 指纹。参考分界：汉明距离 ≤5 相同 / >10 不同。
 *
 * 流程：
 *   1. sharp 生成基图（有结构图：渐变 + 矩形 + 平滑噪声，512×512）
 *   2. 变体集 = 同图不同压缩（jpeg q50/q80、webp→jpeg 转码）+ 轻微重缩放（0.9/1.1）
 *      + 轻微亮度/对比度（±20%）
 *   3. 32×32 灰度 → 手写 32×32 DCT-II → 取 8×8 低频（排除 DC）→ 中值 → 64bit 指纹
 *   4. 输出汉明距离矩阵 + 分组统计（同图组内 / 无关图跨图）+ 阈值建议
 *
 * 用法:
 *   cd packages/server && node experiments/phash.e2e.mjs
 *
 * 一次性实验脚本：不改 src/ 生产代码，不装新包。退出码 0 = 全部 PASS。
 */

import sharp from 'sharp'

const SIZE = 512
const N = 32 // 预缩放边长（pHash 标准 32×32）
const LOW = 8 // DCT 低频窗口

let failed = false
function note(ok, label, detail = '') {
  console.log(`${ok ? '  ✅' : '  ❌'} ${label}${detail ? `\n      ${detail}` : ''}`)
  if (!ok) failed = true
}

/**
 * 生成 deterministic 有结构测试图。
 * opts: { seed, grad: 'h'|'v'|'d', rects: [{x0,x1,y0,y1,c}] }
 * grad 方向与 rect 布局不同 → 低频结构显著不同（控制组真正"无关"）。
 */
function makeImage(opts) {
  const { seed, grad, rects } = opts
  const raw = Buffer.alloc(SIZE * SIZE * 3)
  let s = seed >>> 0
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      let c
      if (grad === 'v') c = Math.round(60 + (y / SIZE) * 150)
      else if (grad === 'd') c = Math.round(60 + ((x + y) / (2 * SIZE)) * 150)
      else c = Math.round(60 + (x / SIZE) * 150)
      for (const r of rects) {
        if (x > SIZE * r.x0 && x < SIZE * r.x1 && y > SIZE * r.y0 && y < SIZE * r.y1) c = r.c
      }
      s = (s * 1664525 + 1013904223) >>> 0
      const n = (((s >> 24) & 0xff) % 21) - 10
      const v = Math.max(0, Math.min(255, c + n))
      const i = (y * SIZE + x) * 3
      raw[i] = v
      raw[i + 1] = v
      raw[i + 2] = v
    }
  }
  return sharp(raw, { raw: { width: SIZE, height: SIZE, channels: 3 } })
}

const BASE_IMG = {
  seed: 42,
  grad: 'h',
  rects: [
    { x0: 0.3, x1: 0.5, y0: 0.2, y1: 0.6, c: 220 },
    { x0: 0.6, x1: 0.8, y0: 0.5, y1: 0.9, c: 40 },
  ],
}

// ─── 变体构造 ────────────────────────────────────────────────

const basePng = await makeImage(BASE_IMG).png().toBuffer()

/** 从已编码 buffer 读取原始灰度像素 → Float64Array 32×32 */
async function gray32(buf) {
  const { data, info } = await sharp(buf)
    .resize(N, N, { fit: 'fill' })
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true })
  if (info.channels !== 1) throw new Error(`expected grayscale, got ${info.channels} channels`)
  const g = new Float64Array(N * N)
  for (let i = 0; i < data.length; i++) g[i] = data[i]
  return g
}

const variants = {
  '无损复制 (PNG 重存)': await makeImage(BASE_IMG).png().toBuffer(),
  'JPEG q80': await makeImage(BASE_IMG).jpeg({ quality: 80 }).toBuffer(),
  'JPEG q50': await makeImage(BASE_IMG).jpeg({ quality: 50 }).toBuffer(),
  'WEBP→JPEG 转码': await sharp(await makeImage(BASE_IMG).webp({ quality: 70 }).toBuffer())
    .jpeg({ quality: 80 })
    .toBuffer(),
  '重缩放 0.9': await makeImage(BASE_IMG)
    .resize(Math.round(SIZE * 0.9))
    .png()
    .toBuffer(),
  '重缩放 1.1': await makeImage(BASE_IMG)
    .resize(Math.round(SIZE * 1.1))
    .png()
    .toBuffer(),
  '亮度 -20%': await makeImage(BASE_IMG).modulate({ brightness: 0.8 }).png().toBuffer(),
  '亮度 +20%': await makeImage(BASE_IMG).modulate({ brightness: 1.2 }).png().toBuffer(),
  '对比度 -20%': await makeImage(BASE_IMG).linear(0.8, 30).png().toBuffer(),
  '对比度 +20%': await makeImage(BASE_IMG).linear(1.2, -30).png().toBuffer(),
  '无关图 A (垂直渐变)': await makeImage({
    seed: 7,
    grad: 'v',
    rects: [
      { x0: 0.1, x1: 0.4, y0: 0.1, y1: 0.3, c: 180 },
      { x0: 0.5, x1: 0.9, y0: 0.4, y1: 0.7, c: 30 },
    ],
  })
    .png()
    .toBuffer(),
  '无关图 B (对角渐变)': await makeImage({
    seed: 999,
    grad: 'd',
    rects: [{ x0: 0.3, x1: 0.7, y0: 0.3, y1: 0.7, c: 120 }],
  })
    .png()
    .toBuffer(),
}

// ─── 手写 32×32 DCT-II ───────────────────────────────────────

function dct2d(gray, size) {
  const out = new Float64Array(size * size)
  // 预计算 cos 表（升维到 O(N^3) 实现，N=32 无压力）
  const cosX = new Float64Array(size * size) // [u][x]
  const cosY = new Float64Array(size * size) // [v][y]
  for (let u = 0; u < size; u++) {
    for (let x = 0; x < size; x++) {
      cosX[u * size + x] = Math.cos(((2 * x + 1) * u * Math.PI) / (2 * size))
    }
  }
  for (let v = 0; v < size; v++) {
    for (let y = 0; y < size; y++) {
      cosY[v * size + y] = Math.cos(((2 * y + 1) * v * Math.PI) / (2 * size))
    }
  }
  const cu = (u) => (u === 0 ? Math.sqrt(1 / size) : Math.sqrt(2 / size))
  for (let v = 0; v < size; v++) {
    for (let u = 0; u < size; u++) {
      let sum = 0
      for (let y = 0; y < size; y++) {
        let rowSum = 0
        const cy = cosY[v * size + y]
        for (let x = 0; x < size; x++) {
          rowSum += gray[y * size + x] * cosX[u * size + x]
        }
        sum += rowSum * cy
      }
      out[v * size + u] = cu(u) * cu(v) * sum
    }
  }
  return out
}

/** 8×8 低频（排除 DC）中值 → 64bit 指纹 */
function phash64(gray) {
  const dct = dct2d(gray, N)
  const low = []
  for (let u = 0; u < LOW; u++) {
    for (let v = 0; v < LOW; v++) {
      if (u === 0 && v === 0) continue // DC 项变化大，pHash 标准排除
      low.push(dct[v * N + u])
    }
  }
  const sorted = [...low].sort((a, b) => a - b)
  const med = sorted[Math.floor(sorted.length / 2)]
  let bits = 0n
  for (let i = 0; i < low.length; i++) {
    if (low[i] > med) bits |= 1n << BigInt(i)
  }
  return bits
}

function hamming(a, b) {
  let x = a ^ b
  let c = 0
  while (x) {
    c += Number(x & 1n)
    x >>= 1n
  }
  return c
}

// ─── 计算指纹 ────────────────────────────────────────────────

console.log('── E2 pHash 近重复去重 ──')
console.log(`  变体数: ${Object.keys(variants).length}（含 2 个无关图控制组）\n`)

const keys = Object.keys(variants)
const fingerprints = {}
for (const k of keys) {
  const g = await gray32(variants[k])
  fingerprints[k] = phash64(g)
}

// 汉明距离矩阵
console.log('  汉明距离矩阵：')
const nameCol = (k) => (k === '无损复制 (PNG 重存)' ? '无损复制    ' : k.padEnd(12, '　'))
const header = '   '.padEnd(12) + keys.map((k) => k.slice(0, 4).padStart(5)).join('')
console.log(header)
for (const a of keys) {
  const row = keys
    .map((b) => {
      const d = hamming(fingerprints[a], fingerprints[b])
      return String(d).padStart(5)
    })
    .join('')
  console.log(nameCol(a) + row)
}

// 分组统计
const SAME_GROUP = keys.filter((k) => !k.startsWith('无关图'))
const samePairs = []
for (let i = 0; i < SAME_GROUP.length; i++) {
  for (let j = i + 1; j < SAME_GROUP.length; j++) {
    samePairs.push(hamming(fingerprints[SAME_GROUP[i]], fingerprints[SAME_GROUP[j]]))
  }
}
const crossPairs = []
const unrelatedKeys = keys.filter((k) => k.startsWith('无关图'))
for (const k of SAME_GROUP) {
  for (const u of unrelatedKeys) {
    crossPairs.push(hamming(fingerprints[k], fingerprints[u]))
  }
}
const maxSame = Math.max(...samePairs)
const minCross = Math.min(...crossPairs)
const avgSame = (samePairs.reduce((s, v) => s + v, 0) / samePairs.length).toFixed(1)
const avgCross = (crossPairs.reduce((s, v) => s + v, 0) / crossPairs.length).toFixed(1)

console.log(
  `\n  同图变体组内: ${samePairs.length} 对, 距离范围 [${Math.min(...samePairs)}..${maxSame}], 均值 ${avgSame}`
)
console.log(
  `  无关图跨图:   ${crossPairs.length} 对, 距离范围 [${minCross}..${Math.max(...crossPairs)}], 均值 ${avgCross}`
)

// 判定：同图最大距离 < 跨图最小距离（可分桶）即 PASS；参考分界 ≤5 相同 / >10 不同
const separable = maxSame < minCross
const withinStd = maxSame <= 10
note(separable, '同图变体与无关图可分桶', `同图最大 ${maxSame} < 跨图最小 ${minCross}`)
note(withinStd, '同图变体全部落在 ≤10 分界内', `同图最大 ${maxSame} ≤ 10`)

const thresh = Math.floor((maxSame + minCross) / 2)
console.log(`\n  推荐阈值（业界参考 ≤5 相同 / >10 不同）:`)
console.log(
  `    ≤5 判同图: 同图最大 ${maxSame} ≤ 5 → ${maxSame <= 5 ? '全部命中 ✅' : '未命中 ❌'}`
)
console.log(
  `    >10 判不同: 跨图最小 ${minCross} > 10 → ${minCross > 10 ? '全部命中 ✅' : '未命中 ❌'}`
)
console.log(
  `    5-10 灰区: 本数据无样本（同图 ${maxSame} / 跨图 ${minCross}），保守建议取 ≤${Math.min(5, maxSame + 1)} 判同图`
)

console.log(failed ? '\n[E2] 存在 FAIL' : '\n[E2] 全部 PASS')
process.exit(failed ? 1 : 0)
