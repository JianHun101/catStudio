/**
 * 最小化 .env 文件加载器（不依赖 dotenv 包）。
 *
 * 规则：
 * - 读取项目根目录的 .env 文件
 * - 每行 KEY=VALUE 格式
 * - 跳过空行和 # 注释行
 * - 支持引号：单引号和双引号
 * - 不会覆盖已存在的环境变量
 *
 * 在 index.ts 最顶部 import，确保在任何模块初始化前加载。
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// env.ts 在 packages/server/src/ → 三层上去是项目根目录
const ROOT = path.resolve(__dirname, '..', '..', '..')
const ENV_FILE = path.join(ROOT, '.env')

function loadEnvFile(): void {
  try {
    const content = fs.readFileSync(ENV_FILE, 'utf-8')
    let count = 0

    for (const line of content.split('\n')) {
      const trimmed = line.trim()
      // 跳过空行和注释
      if (!trimmed || trimmed.startsWith('#')) continue

      const eqIdx = trimmed.indexOf('=')
      if (eqIdx === -1) continue

      const key = trimmed.slice(0, eqIdx).trim()
      let value = trimmed.slice(eqIdx + 1).trim()

      // 去掉引号
      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1)
      }

      // 不覆盖已存在的环境变量
      if (key && !(key in process.env)) {
        process.env[key] = value
        count++
      }
    }

    if (count > 0) {
      console.log(`[env] 从 .env 加载了 ${count} 个变量`)
    }
  } catch {
    // .env 文件不存在是正常情况
  }
}

loadEnvFile()
