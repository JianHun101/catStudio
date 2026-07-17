/**
 * Skill Loader — 按需动态加载 Agent prompt 片段。
 *
 * 设计决策（ADHERE）:
 * - 启动时一次性把所有 skill 文件读进内存，运行时只做内存查表
 * - 意图检测用关键词匹配（不引入额外的 LLM 调用）
 * - manifest.json 为后端独立的单一事实源，不与 .claude/skills/manifest.yaml 合并
 *   （后者管理 Claude Code CLI 子进程，前者管理 Web Agent 的 prompt 片段路由）
 * - 注入方式: 弱依赖模块级单例，socketio.ts 直接 import，测试通过 vi.mock 替换
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createLogger } from "../logger.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const log = createLogger("skill-loader");

// ── 类型 ──────────────────────────────────────────────

interface SkillEntry {
  description: string;
  triggers: string[];
  file: string;
}

interface Manifest {
  skills: Record<string, SkillEntry>;
  agents: Record<string, string[]>;
}

// ── 模块级单例状态 ────────────────────────────────────

let initialized = false;
const skillContents = new Map<string, string>();   // skillName → content
const agentSkills = new Map<string, string[]>();   // agentName → allowed skillNames
const skillTriggers: Array<{ name: string; triggers: string[] }> = [];

// ── 内部 ──────────────────────────────────────────────

function loadManifest(): Manifest {
  const manifestPath = resolve(__dirname, "manifest.json");
  if (!existsSync(manifestPath)) {
    throw new Error(`Skill manifest not found: ${manifestPath}`);
  }
  const raw = readFileSync(manifestPath, "utf-8");
  try {
    return JSON.parse(raw) as Manifest;
  } catch {
    throw new Error(`Failed to parse skill manifest: ${manifestPath}`);
  }
}

function loadSkillFiles(manifest: Manifest): void {
  for (const [name, entry] of Object.entries(manifest.skills)) {
    const filePath = resolve(__dirname, entry.file);
    if (!existsSync(filePath)) {
      log.warn("skill file not found — skipped", { skill: name, path: filePath });
      continue;
    }
    skillContents.set(name, readFileSync(filePath, "utf-8"));
    skillTriggers.push({ name, triggers: entry.triggers });
  }
}

function loadAgentMappings(manifest: Manifest): void {
  for (const [agentName, skills] of Object.entries(manifest.agents)) {
    agentSkills.set(agentName, skills);
  }
}

// ── 公开 API ──────────────────────────────────────────

/** 启动时调用一次。失败抛异常，阻止服务启动。 */
export function initSkillLoader(): void {
  if (initialized) return;

  const manifest = loadManifest();
  loadSkillFiles(manifest);
  loadAgentMappings(manifest);

  log.info("skill loader initialized", {
    skills: skillContents.size,
    agents: agentSkills.size,
  });
  initialized = true;
}

/**
 * 根据 Agent 名、基础 prompt 和触发消息，动态组装完整 system prompt。
 *
 * 匹配规则:
 * 1. agentSkills[name] → 该 Agent 允许加载的 skill 列表（能力上限）
 * 2. 在允许的 skill 中，检查 triggerText 是否命中 trigger 关键词
 * 3. 命中 → 追加对应 skill 内容到 basePrompt 之后
 * 4. 未命中 → 只返回 basePrompt
 * 5. agentSkills 中无此 Agent → 只返回 basePrompt
 *
 * @param agentName   Agent 名称（如 "店长"）
 * @param basePrompt  Agent 的基础 system prompt（铁律已在其中）
 * @param triggerText 触发消息的文本内容（用户输入或 @mention 消息）
 * @returns 组装后的完整 system prompt
 */
export function matchAndBuild(
  agentName: string,
  basePrompt: string,
  triggerText: string,
): string {
  if (!initialized) {
    log.warn("skill loader not initialized — using base prompt only", { agentName });
    return basePrompt;
  }

  const allowedSkills = agentSkills.get(agentName) || [];
  if (allowedSkills.length === 0) {
    return basePrompt;
  }

  let result = basePrompt;

  for (const skillName of allowedSkills) {
    const triggers = skillTriggers.find((s) => s.name === skillName)?.triggers || [];
    const triggered = triggers.some((t) => triggerText.includes(t));

    if (triggered) {
      const content = skillContents.get(skillName);
      if (content) {
        result += "\n\n" + content;
      }
    }
  }

  return result;
}

/** 仅测试用 — 重置内部状态。生产代码不应调用。 */
export function __test_reset(): void {
  initialized = false;
  skillContents.clear();
  agentSkills.clear();
  skillTriggers.length = 0;
}
