// 部署包瘦身脚本（postinstall 自动执行）
//
// wx-server-sdk@2.6.3 -> @cloudbase/node-sdk@2.9.1 -> ts-node -> typescript
// 这条链路会额外装上 typescript 编译器与平台二进制（约 31MB），而云函数只用 JS 运行，
// 不加载 TS 编译器。install 完成后统一剔除，依赖体积 76MB -> 42MB，冷启动更快。
// 若将来把入口改成 .ts，请删除本脚本与 package.json 里的 postinstall。
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..', 'node_modules')
const TARGETS = ['@typescript', 'typescript', 'ts-node', '@types']

let removed = 0
for (const name of TARGETS) {
  const p = path.join(ROOT, name)
  if (!fs.existsSync(p)) continue
  fs.rmSync(p, { recursive: true, force: true })
  removed++
}

if (removed) console.log('[prune-deps] removed ' + removed + ' dev-only package dirs')
