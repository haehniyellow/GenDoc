#!/usr/bin/env node
// 一条命令启动整个项目：Go 后端（:8080）+ Web 前端（:5173，会自动打开浏览器）。
//   pnpm dev
// 设置环境变量 BROWSER=none 可以不自动打开浏览器。
import { spawn, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const isWin = process.platform === 'win32'
const color = (code, s) => (process.stdout.isTTY ? `\x1b[${code}m${s}\x1b[0m` : s)

// ── 1. 准备 .env：首次运行时从模板生成，并换成随机的 JWT 密钥 ──
const envFile = join(root, '.env')
if (!existsSync(envFile)) {
  copyFileSync(join(root, '.env.example'), envFile)
  const secret = randomBytes(32).toString('hex')
  writeFileSync(envFile, readFileSync(envFile, 'utf8').replace(/^JWT_SECRET=.*$/m, `JWT_SECRET=${secret}`))
  console.log('已生成 .env（默认使用 Mock 模型，无需 API key；要接入真实模型请编辑 .env）')
}

// ── 2. 检查 Go ──
const goCheck = spawnSync(isWin ? 'go version' : 'go', isWin ? [] : ['version'], { encoding: 'utf8', shell: isWin })
if (goCheck.status !== 0) {
  console.error('未找到 Go。请先安装 Go 1.26+（https://go.dev/dl/），并确认 `go version` 能在终端里运行。')
  process.exit(1)
}
console.log(`${goCheck.stdout.trim()}\n首次运行会下载 Go 依赖；国内网络较慢时可先执行：go env -w GOPROXY=https://goproxy.cn,direct\n`)

// ── 3. 启动子进程，合并输出并加前缀 ──
const children = []
let shuttingDown = false

function killTree(child) {
  if (child.exitCode !== null || child.pid === undefined) return
  try {
    if (isWin) spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    else process.kill(-child.pid, 'SIGTERM') // detached 进程组
  } catch {
    /* 已退出 */
  }
}

function shutdown(code = 0) {
  if (shuttingDown) return
  shuttingDown = true
  children.forEach(killTree)
  setTimeout(() => process.exit(code), 300)
}

function run(name, tint, cmd, args, cwd) {
  // Windows 上 pnpm 是 .cmd 文件，必须经 shell 启动；此时把命令拼成单个字符串，
  // 避免 Node 对 “shell: true + 参数数组” 的弃用警告（参数都是固定常量，不涉及外部输入）
  const child = isWin
    ? spawn([cmd, ...args].join(' '), { cwd, shell: true, env: process.env })
    : spawn(cmd, args, { cwd, detached: true, env: process.env })
  children.push(child)
  const pipe = (stream) =>
    createInterface({ input: stream }).on('line', (line) => console.log(`${color(tint, `[${name}]`)} ${line}`))
  pipe(child.stdout)
  pipe(child.stderr)
  child.on('error', (e) => {
    console.error(`${color(31, `[${name}]`)} 启动失败：${e.message}`)
    shutdown(1)
  })
  child.on('exit', (code, signal) => {
    if (shuttingDown) return
    console.error(`${color(31, `[${name}]`)} 已退出（${signal ?? `code ${code}`}），正在停止其余进程…`)
    shutdown(code ?? 1)
  })
  return child
}

process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))

// ── 4. 先起后端，等健康检查通过后再起前端 ──
// 前端 1 秒就能就绪并自动打开浏览器，而后端 `go run` 需要先编译（首次还要下载依赖，可能几十秒甚至几分钟）。
// 如果同时启动，浏览器打开时后端还没监听，所有 /api 请求都会被代理成 502 Bad Gateway。
run('api', 36, 'go', ['run', './cmd/server'], join(root, 'server'))

async function waitForBackend() {
  const started = Date.now()
  let lastHint = started
  while (!shuttingDown) {
    try {
      const r = await fetch('http://localhost:8080/healthz')
      if (r.ok) return await r.json()
    } catch {
      /* 还没起来 */
    }
    if (Date.now() - lastHint > 10_000) {
      lastHint = Date.now()
      console.log(color(33, `等待后端启动…（已 ${Math.round((Date.now() - started) / 1000)}s；首次编译 / 下载 Go 依赖较慢，请耐心等待）`))
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  return null
}

const health = await waitForBackend()
if (health && !shuttingDown) {
  console.log(color(32, `\n后端已就绪${health.mockLLM ? '（当前使用 Mock 模型）' : ''}，正在启动前端…\n`))
  run('web', 35, 'pnpm', ['--filter', '@doc/web', 'dev'], root)
}
