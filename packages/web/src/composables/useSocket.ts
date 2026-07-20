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
    // 使用相对路径：开发时走 Vite proxy，生产时同源部署
    socket.value = io({
      autoConnect: false,
      transports: ['websocket', 'polling'],
    })

    socket.value.on('connect', () => {
      connected.value = true
      log.info('connected', { id: socket.value!.id })
    })

    socket.value.on('disconnect', () => {
      connected.value = false
      log.info('disconnected')
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
