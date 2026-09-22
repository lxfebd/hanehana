import { createApp } from 'vue'
import App from './App.vue'
import 'ant-design-vue/dist/reset.css'
import './design/global.css'
import { applyCssVars } from './design/tokens'

applyCssVars()

createApp(App).mount('#app')