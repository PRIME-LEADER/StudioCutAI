import { spawn } from 'node:child_process'

const children = [
  spawn(process.execPath, ['server.mjs'], {
    env: { ...process.env, AI_API_PORT: process.env.AI_API_PORT || '8788' },
    stdio: 'inherit',
  }),
  spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '0.0.0.0'], {
    env: process.env,
    stdio: 'inherit',
  }),
]

let stopping = false
function stopChildren(exitCode = 0) {
  if (stopping) return
  stopping = true
  for (const child of children) {
    if (child.exitCode === null) child.kill('SIGTERM')
  }
  process.exitCode = exitCode
}

for (const child of children) {
  child.on('error', error => {
    console.error('Development process could not start:', error)
    stopChildren(1)
  })
  child.on('exit', code => {
    if (!stopping) stopChildren(code || 0)
  })
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => stopChildren(0))
}
