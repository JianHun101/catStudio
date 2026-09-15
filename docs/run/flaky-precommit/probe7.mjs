// 承重验证：逐端口复现「fetch bad port」——bind 到候选端口，用 fetch 连它
import { createServer } from 'node:http'
const CAND = [
  1719, 1720, 1723, 3659, 4045, 4190, 5060, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 10080, 49152,
  50000, 51234, 65530, 3200,
]
const out = []
for (const p of CAND) {
  const srv = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{"ok":true}')
  })
  let bound = false
  try {
    await new Promise((r, j) => {
      srv.once('error', j)
      srv.listen(p, '127.0.0.1', r)
      bound = true
    })
  } catch (e) {
    out.push({ port: p, bind: 'ERR ' + e.code })
    continue
  }
  let res
  try {
    const r = await fetch(`http://127.0.0.1:${p}/health`)
    await r.text()
    res = 'FETCH-OK'
  } catch (e) {
    res = 'FETCH-ERR cause=' + (e.cause?.code || e.cause?.message || String(e.cause))
  }
  out.push({ port: p, bind: 'ok', fetch: res })
  await new Promise((r) => srv.close(r))
}
for (const o of out) console.log(JSON.stringify(o))
