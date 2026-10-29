import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

// Runs a user's command-shaped child, never the OMP TUI. Every launch has a nonce.
const [nonceFile, nonce, mode = 'normal'] = process.argv.slice(2)
appendFileSync(nonceFile, `${nonce}\n`)
console.log(`CONTRACT_READY ${JSON.stringify({ nonce, stdinTTY: Boolean(process.stdin.isTTY), stdoutTTY: Boolean(process.stdout.isTTY), cols: process.stdout.columns, rows: process.stdout.rows, sessionId: process.env.PI_SESSION_ID, sessionFile: process.env.PI_SESSION_FILE })}`)
if (mode === 'normal') {
  console.log('CONTRACT_NATIVE_RESULT')
} else if (mode === 'nonzero') {
  process.exitCode = 7
} else if (mode === 'interactive') {
  const input = createInterface({ input: process.stdin, terminal: false })
  input.on('line', line => {
    console.log(`CONTRACT_INPUT ${JSON.stringify({ line, cols: process.stdout.columns, rows: process.stdout.rows })}`)
    input.close()
    process.stdin.pause()
  })
} else {
  setInterval(() => {}, 1000)
}
