import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import { vFocus } from './directives/vFocus'
import { useTheme } from '@/composables/useTheme'

// 主题初始化必须在 Vue mount 之前，避免 FOUC（页面闪白）
useTheme()

const app = createApp(App)
app.use(createPinia())
app.directive('focus', vFocus)
app.mount('#app')
