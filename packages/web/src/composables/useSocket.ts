import { io, Socket } from 'socket.io-client'
import { ref, onUnmounted } from 'vue'
import { Events } from '@cat-study/shared'
import type { Message, AgentRuntimeState } from '@cat-study/shared'
import { createLogger } from '@/utils/logger'

const log = createLogger('socket')
const socket = ref<Socket | null>(null)
const connected = ref(false)

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
      connected.value = true
      log.info('connected', { id: socket.value!.id })
    })

    socket.value.on('disconnect', (reason) => {
      connected.value = false
      log.info('disconnected', { reason })
    })

    socket.value.connect()
  }

  onUnmounted(() => {
    // don't disconnect on component unmount — shared singleton
  })

  return {
    socket: socket.value,
    connected,
  }
}

/** 全局断开（应用关闭时调用） */
export function disconnectSocket(): void {
  socket.value?.disconnect()
  socket.value = null
  connected.value = false
}
