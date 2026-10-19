import { createAppConfig } from '../../config/vite.base.ts'

export default createAppConfig({ appDir: import.meta.dirname, port: 5173, open: true })
