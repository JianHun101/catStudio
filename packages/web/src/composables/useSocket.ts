import { io, Socket } from 'socket.io-client'
import { ref, onUnmounted } from 'vue'
import { Events } from '@cat-study/shared'
import type { Message, AgentRuntimeState } from '@cat-study/shared'
import { createLogger } from '@/utils/logger'

const log = createLogger('socket')
const socket = ref<Socket | null>(null)

/**
 * 回前台立即重连（后台标签页冻结根治）。
 *
 * 根因：Chrome 冻结后台标签页的计时器 ⇒ socket.io 客户端心跳停发（服务端随后判死杀连接），
 * 且重连退避本身也是定时器、同样被冻结——用户切回前台后还得干等退避到期才重连。
 * 故 visible 且当前已断开时直接 connect()，跳过退避等待。
 */
function handleVisibilityChange(): void {
  if (document.visibilityState === 'visible' && socket.value?.disconnected) {
    socket.value.connect()
  }
}

export function useSocket() {
  if (!socket.value) {
    // dev 直连 server 端口，绕过 Vite proxy——proxy 层的 WS 传输跳在浏览器侧会 transport close
    // （点击 emit 瞬间断连重连、emit 丢失的根因）；生产保持同源部署
    const url = import.meta.env.DEV ? 'http://127.0.0.1:3200' : undefined
    socket.value = io(url, {
      autoConnect: false,
      transports: ['websocket', 'polling'],
    })

    socket.value.on('connect', () => {
      log.info('connected', { id: socket.value!.id })
    })

    socket.value.on('disconnect', (reason) => {
      log.info('disconnected', { reason })
    })

    socket.value.connect()

    // 单例创建处注册一次（上方 if 守卫保证不重复注册）；移除点在 disconnectSocket()
    document.addEventListener('visibilitychange', handleVisibilityChange)
  }

  onUnmounted(() => {
    // don't disconnect on component unmount — shared singleton
  })

  return {
    socket: socket.value,
  }
}

/** 全局断开（应用关闭时调用） */
export function disconnectSocket(): void {
  document.removeEventListener('visibilitychange', handleVisibilityChange)
  socket.value?.disconnect()
  socket.value = null
}
