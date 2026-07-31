// 临时端到端验证脚本：发一条带图片的消息，观察 ollama agent 能否"看见"
import { io } from 'socket.io-client'
import sharp from 'sharp'

const SESSION = '197a1561-e421-4593-904f-87eb7d2e4dff'
const IMG = await sharp({
  create: { width: 96, height: 64, channels: 3, background: { r: 34, g: 139, b: 34 } },
})
  .png()
  .toBuffer()

const base64 = IMG.toString('base64')
console.log('测试图: 96x64 纯绿色 PNG, base64 长度', base64.length)

const socket = io('http://127.0.0.1:3200', { transports: ['websocket'] })

const seen = []
socket.on('connect', () => {
  console.log('socket connected')
  socket.emit('join-session', SESSION)
  setTimeout(() => {
    socket.emit('send-message', {
      sessionId: SESSION,
      content: '@图测猫 这张图片是什么颜色？',
      mentions: ['图测猫'],
      images: [base64],
    })
    console.log('已发送带图消息')
  }, 500)
})

socket.on('new-message', (m) => {
  const hasImg = m.images && m.images.length ? `[含${m.images.length}图]` : ''
  console.log(
    `NEW_MESSAGE ${m.role} ${m.agentId || 'user'} ${hasImg}: ${(m.content || '').slice(0, 120)}`
  )
  if (m.role === 'agent') {
    seen.push(m)
    console.log('=== AGENT 回复完成，验证成功 ===')
    process.exit(0)
  }
})

socket.on('error', (e) => console.log('ERROR:', JSON.stringify(e)))
setTimeout(() => {
  console.log('超时（30s），已见消息数:', seen.length)
  process.exit(1)
}, 30000)
