import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import { vFocus } from './directives/vFocus'

const app = createApp(App)
app.use(createPinia())
app.directive('focus', vFocus)
app.mount('#app')
