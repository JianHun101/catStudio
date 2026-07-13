import { io, Socket } from 'socket.io-client'
import { ref, onUnmounted } from 'vue'
import { Events } from '@cat-study/shared'
import type { Message, AgentRuntimeState } from '@cat-study/shared'

const socket = ref<Socket | null>(null)
const connected = ref(false)

export function useSocket() {
  if (!socket.value) {
    socket.value = io('http://127.0.0.1:3200', {
      autoConnect: false,
      transports: ['websocket', 'polling'],
    })

    socket.value.on('connect', () => {
      connected.value = true
      console.log('[socket] connected:', socket.value!.id)
    })

    socket.value.on('disconnect', () => {
      connected.value = false
      console.log('[socket] disconnected')
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
