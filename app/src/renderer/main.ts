import { createApp } from 'vue'
import App from './App.vue'
import 'ant-design-vue/dist/reset.css'
import './design/global.css'
import { applyCssVars } from './design/tokens'

// 启动默认深色；App 的 initTasks 拿到主进程设置后会调 applyDarkFromSettings 校正，
// 深浅主题与 settings.json 保持一致。
applyCssVars()

createApp(App).mount('#app')