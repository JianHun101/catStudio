/**
 * 多模态知识库可行性实验 E1 + E3（ADR 0009 待验证项 🔴#1）
 *
 * E1 — SigLIP 图像管线：`pipeline('image-feature-extraction', 'Xenova/siglip-base-patch16-224')`
 *      对 raw buffer / base64 dataURL / RawImage 三种输入，断言输出 768 维、非全零、无 NaN。
 *      测试图由 sharp 生成（已随依赖，0.33.5）。
 * E3 — 双模型内存：依次加载 bge-small-zh-v1.5（文本塔）与 SigLIP（视觉塔），
 *      测量 稳态 RSS / 加载瞬间峰值 RSS / 单次嵌入峰值 RSS（只看稳态会低估 OOM 压力）。
 *
 * 用法:
 *   cd packages/server && node experiments/siglip-pipeline.e2e.mjs
 *   （可选环境变量 HF_ENDPOINT=https://hf-mirror.com 切换下载镜像）
 *
 * 一次性实验脚本：不改 src/ 生产代码，不装新包。退出码 0 = 全部 PASS。
 */

import sharp from 'sharp'
import { pipeline, RawImage, env as hfEnv } from '@huggingface/transformers'

const MB = 1024 * 1024
const IMG_SIZE = 512
const SIGLIP_MODEL = 'Xenova/siglip-base-patch16-224'
const BGE_MODEL = 'Xenova/bge-small-zh-v1.5'

let failed = false
function note(ok, label, detail = '') {
  console.log(`${ok ? '  ✅' : '  ❌'} ${label}${detail ? `\n      ${detail}` : ''}`)
  if (!ok) failed = true
}

// 与 src/memory/embedding.ts 一致的镜像逻辑（脚本独立，不 import 生产代码）
const mirror = process.env.HF_ENDPOINT
if (mirror && mirror !== 'https://huggingface.co') {
  hfEnv.remoteHost = mirror.replace(/\/+$/, '') + '/'
  hfEnv.remotePathTemplate = '{model}/resolve/{revision}/'
  console.log(`[env] 使用自定义 HF 端点 ${hfEnv.remoteHost}\n`)
}

function rss() {
  return process.memoryUsage().rss / MB
}

/** 加载/调用期间轮询 RSS 峰值（10ms 粒度） */
function watchPeak() {
  let peak = rss()
  const t = setInterval(() => {
    const now = rss()
    if (now > peak) peak = now
  }, 10)
  return {
    stop() {
      clearInterval(t)
      return peak
    },
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 生成 deterministic 有结构测试图（渐变 + 矩形 + 平滑噪声，512×512 PNG） */
function makeImage(seed) {
  const size = IMG_SIZE
  const raw = Buffer.alloc(size * size * 3)
  let s = seed >>> 0
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let c = Math.round(60 + (x / size) * 150)
      if (x > size * 0.3 && x < size * 0.5 && y > size * 0.2 && y < size * 0.6) c = 220
      if (x > size * 0.6 && x < size * 0.8 && y > size * 0.5 && y < size * 0.9) c = 40
      s = (s * 1664525 + 1013904223) >>> 0
      const n = (((s >> 24) & 0xff) % 21) - 10
      const v = Math.max(0, Math.min(255, c + n))
      const i = (y * size + x) * 3
      raw[i] = v
      raw[i + 1] = v
      raw[i + 2] = v
    }
  }
  return sharp(raw, { raw: { width: size, height: size, channels: 3 } })
    .png()
    .toBuffer()
}

// ─────────────────────────────────────────────────────────────
// E3 — 双模型内存（先在干净进程测量，再跑 E1 复用已加载模型）
// ─────────────────────────────────────────────────────────────
console.log('── E3 双模型内存测量 ──')
const baselineRss = rss()
console.log(`  基线 RSS: ${baselineRss.toFixed(1)} MB\n`)

let bge, siglip
let bgeSteady = 0

{
  console.log('  [E3.1] 加载 bge-small-zh-v1.5 (feature-extraction)...')
  const w = watchPeak()
  const t0 = Date.now()
  bge = await pipeline('feature-extraction', BGE_MODEL)
  const peakLoad = w.stop()
  bgeSteady = rss()
  console.log(
    `    耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s | 加载峰值 ${peakLoad.toFixed(1)} MB | 稳态 ${bgeSteady.toFixed(1)} MB | 稳态增量 ${(bgeSteady - baselineRss).toFixed(1)} MB`
  )
}

{
  console.log('  [E3.2] 一次文本嵌入 (mean pooling, normalize)...')
  const w = watchPeak()
  const t0 = Date.now()
  const out = await bge('猫咖的定位是接入各类应用实现各种功能的多 agent 平台', {
    pooling: 'mean',
    normalize: true,
  })
  const peakEmbed = w.stop()
  console.log(
    `    耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s | 峰值 ${peakEmbed.toFixed(1)} MB | 输出 dim=${out.data.length}`
  )
}

{
  console.log('  [E3.3] 加载 SigLIP base (image-feature-extraction)...')
  const w = watchPeak()
  const t0 = Date.now()
  siglip = await pipeline('image-feature-extraction', SIGLIP_MODEL)
  const peakLoad = w.stop()
  const steady = rss()
  console.log(
    `    耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s | 加载峰值 ${peakLoad.toFixed(1)} MB | 稳态 ${steady.toFixed(1)} MB | 稳态增量 ${(steady - bgeSteady).toFixed(1)} MB`
  )
}

{
  console.log('  [E3.4] 一次图像嵌入...')
  const img = await makeImage(42)
  const w = watchPeak()
  const t0 = Date.now()
  const out = await siglip(img)
  const peakEmbed = w.stop()
  console.log(
    `    耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s | 峰值 ${peakEmbed.toFixed(1)} MB | 输出 dim=${out.data.length}`
  )
}

await sleep(300)
console.log(`\n  最终稳态 RSS（两模型同驻）: ${rss().toFixed(1)} MB`)

// ─────────────────────────────────────────────────────────────
// E1 — SigLIP 三路输入管线
// ─────────────────────────────────────────────────────────────
console.log('\n── E1 SigLIP 三路输入管线 ──')
const imgBuf = await makeImage(42)
const dataURL = `data:image/png;base64,${imgBuf.toString('base64')}`

function inspect(tag, out) {
  const data = out?.data
  const dim = data?.length ?? 0
  const arr = data ? Array.from(data) : []
  const nanCount = arr.filter((v) => Number.isNaN(v)).length
  const nonZero = arr.filter((v) => v !== 0).length
  const head = arr
    .slice(0, 10)
    .map((v) => v.toFixed(4))
    .join(', ')
  const ok = dim === 768 && nonZero === dim && nanCount === 0
  note(ok, `[E1] ${tag}: dim=${dim} 非零=${nonZero}/${dim} NaN=${nanCount}`, `前 10 值: [${head}]`)
}

// 主路径 1：raw buffer
{
  const out = await siglip(imgBuf)
  inspect('raw buffer (PNG)', out)
}

// 主路径 2：base64 dataURL
{
  const out = await siglip(dataURL)
  inspect('base64 dataURL', out)
}

// 主路径 3：RawImage 对象
{
  const img = await RawImage.fromBuffer(imgBuf)
  const out = await siglip(img)
  inspect('RawImage.fromBuffer', out)
}

// 对照组：非 224 图（验证 preprocessor 会做 resize，不依赖输入尺寸）
{
  const small = await sharp(imgBuf).resize(64, 64).png().toBuffer()
  const out = await siglip(small)
  inspect('64×64 小图 (preprocessor resize)', out)
}

console.log(failed ? '\n[E1+E3] 存在 FAIL' : '\n[E1+E3] 全部 PASS')
process.exit(failed ? 1 : 0)
