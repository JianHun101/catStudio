/**
 * A2A Review 链端到端验证脚本
 *
 * 用法: node scripts/a2a-test.mjs
 *
 * 验证流程:
 * 1. 连接 Socket.IO → 加入 demo session
 * 2. 发送 "@店长 帮我写一个数组去重函数"
 * 3. 监听回复，验证:
 *    a. 店长回复中包含 @吐槽猫（行首）
 *    b. 吐槽猫被自动调度并回复
 *    c. 吐槽猫回复中包含 @店长（行首）
 * 4. 输出验证报告
 */

import { io } from '../packages/web/node_modules/socket.io-client/build/cjs/index.js'

const WS_URL = 'http://127.0.0.1:3200'
const SESSION_ID = '7531d744-a6e3-5f2c-90fe-465e801ddbaa' // 猫咖闲聊
const TIMEOUT_MS = 180_000 // 3 分钟超时

const log = (...args) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...args)

async function main() {
  log('🔌 连接 Socket.IO 服务器...')
  const socket = io(WS_URL, {
    transports: ['websocket', 'polling'],
    timeout: 10000,
  })

  const messages = []
  const typingEvents = []
  const agentStatuses = []

  socket.on('connect', () => {
    log('✅ 已连接', socket.id)
    log('📥 加入 session:', SESSION_ID)
    socket.emit('join-session', SESSION_ID)
  })

  socket.on('connect_error', (err) => {
    log('❌ 连接错误:', err.message)
    process.exit(1)
  })

  socket.on('new-message', (msg) => {
    messages.push(msg)
    const role = msg.role === 'agent' ? `🤖 ${msg.agentId?.slice(0, 8) || '?'}` : '👤 用户'
    const mentions = msg.mentions?.length ? ` [@${msg.mentions.join(', @')}]` : ''
    log(`${role}${mentions}:`, msg.content?.slice(0, 150)?.replace(/\n/g, '\\n'), '...')
  })

  socket.on('agent-typing', (data) => {
    typingEvents.push(data)
    // 只在有新内容时打印长度
    if (data.content && typingEvents.filter(e => e.messageId === data.messageId).length % 20 === 1) {
      log(`⚡ typing ${data.agentId?.slice(0, 8)}: ${data.content.length} chars`)
    }
  })

  socket.on('message-agent-status', (data) => {
    agentStatuses.push(data)
    log(`📊 status ${data.agentName}: ${data.status}`)
  })

  socket.on('error', (err) => {
    log('❌ server error:', err)
  })

  // 等待连接和 session join
  await new Promise((resolve) => setTimeout(resolve, 2000))

  // 发送测试消息
  const testMessage = '@店长 帮我写一个简单的 JavaScript 工具函数：数组去重（保留第一次出现的位置顺序）。写完后请按工作交接规范交给吐槽猫 review。'
  log('📤 发送消息:', testMessage.slice(0, 80) + '...')

  socket.emit('send-message', {
    sessionId: SESSION_ID,
    content: testMessage,
    mentions: ['店长'],
  })

  // 等待执行完成
  log('⏳ 等待 A2A review 链完成 (最长 3 分钟)...')

  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        resolve() // timeout is not an error, just end waiting
      }, TIMEOUT_MS)

      // 当看到吐槽猫回复完成时提前结束
      const checkDone = (data) => {
        if (data.agentName === '吐槽猫' && data.status === 'done') {
          // 再等 5 秒确认没有更多消息
          setTimeout(() => {
            clearTimeout(timer)
            resolve()
          }, 5000)
        }
      }
      socket.on('message-agent-status', checkDone)
    })
  } catch (err) {
    log('❌ 超时或错误:', err.message)
  }

  // ─── 生成验证报告 ───
  log('\n' + '='.repeat(60))
  log('📋 A2A Review 链验证报告')
  log('='.repeat(60))

  const agentMsgs = messages.filter(m => m.role === 'agent')
  const userMsgs = messages.filter(m => m.role === 'user')

  log(`\n📊 统计:`)
  log(`  用户消息: ${userMsgs.length} 条`)
  log(`  Agent 回复: ${agentMsgs.length} 条`)
  log(`  Agent 状态变更: ${agentStatuses.length} 次`)
  log(`  流式事件: ${typingEvents.length} 次`)

  log(`\n📝 所有消息:`)
  messages.forEach((m, i) => {
    const role = m.role === 'agent' ? `🤖 ${m.agentId?.slice(0, 8) || '?'}` : '👤 user'
    const mentions = m.mentions?.length ? ` [mentions: ${m.mentions.join(', ')}]` : ''
    log(`  [${i}] ${role}${mentions}: ${m.content?.slice(0, 120)?.replace(/\n/g, ' ')}`)
  })

  // ─── 关键验证项 ───
  log(`\n🔍 验证项:`)

  // 验证 1: 店长是否回复了
  const dianzhangMsgs = agentMsgs.filter(m => m.agentId?.includes('11bbf854'))
  const check1 = dianzhangMsgs.length > 0
  log(`  ${check1 ? '✅' : '❌'} 1. 店长回复了消息 (${dianzhangMsgs.length} 条)`)

  // 验证 2: 店长回复中是否 @了吐槽猫（检查 mentions 字段）
  const dianzhangMentionsTucao = dianzhangMsgs.some(m =>
    m.mentions?.includes('吐槽猫')
  )
  log(`  ${dianzhangMentionsTucao ? '✅' : '❌'} 2. 店长回复的 mentions 字段包含"吐槽猫"`)

  // 验证 3: 吐槽猫是否被调度执行
  const tucaoMsgs = agentMsgs.filter(m => m.agentId?.includes('e0764bc7'))
  const check3 = tucaoMsgs.length > 0
  log(`  ${check3 ? '✅' : '❌'} 3. 吐槽猫被自动调度并回复了 (${tucaoMsgs.length} 条)`)

  // 验证 4: 吐槽猫回复中是否 @了店长
  const tucaoMentionsDianzhang = tucaoMsgs.some(m =>
    m.mentions?.includes('店长')
  )
  log(`  ${tucaoMentionsDianzhang ? '✅' : '❌'} 4. 吐槽猫回复的 mentions 字段包含"店长"`)

  // 验证 5: 吐槽猫状态变更
  const tucaoStatuses = agentStatuses.filter(s => s.agentName === '吐槽猫')
  const check5 = tucaoStatuses.length >= 2 // 至少 queued + done（可能有 thinking/replying）
  log(`  ${check5 ? '✅' : '❌'} 5. 吐槽猫状态正确变更 (queued → thinking → replying → done): ${tucaoStatuses.map(s => s.status).join(' → ')}`)

  // 验证 6: DB 中的 messages.mentions 字段是否正确写回（检查 agent 消息的 mentions）
  const allAgentMentions = agentMsgs
    .filter(m => m.mentions?.length > 0)
    .map(m => `[${m.agentId?.slice(0, 8)} → @${m.mentions.join(', @')}]`)
  log(`  📌 Agent 间 mention 链路: ${allAgentMentions.length > 0 ? allAgentMentions.join(' → ') : '(无)'}`)

  // 最终判定
  const allPassed = check1 && dianzhangMentionsTucao && check3 && tucaoMentionsDianzhang && check5
  log(`\n${allPassed ? '🎉 全部通过！' : '⚠️ 存在未通过的检查项'}`)
  log(`  核心链路 ${dianzhangMentionsTucao && check3 ? '✅' : '❌'}: 店长 → @吐槽猫 → 吐槽猫被调度`)
  log(`  完整链路 ${allPassed ? '✅' : '❌'}: 店长 → @吐槽猫 → 吐槽猫回复 → @店长`)

  socket.disconnect()
  process.exit(allPassed ? 0 : 1)
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
