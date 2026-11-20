#!/usr/bin/env node
/**
 * 微信支付环境变量生成器（本地一次性运行，不联网、不上传任何内容）
 *
 * 为什么不手工复制：apiclient_key.pem 要粘进云函数环境变量，多行容易粘错；
 * 证书序列号是一串 40 位十六进制，肉眼从证书里看不到，只能靠解析。
 * 脚本把三件事一起做掉，并且顺手校验「私钥和证书是不是一对」——
 * 用旧私钥配新证书是最常见的翻车方式，现象是签名被拒（401 SIGN_ERROR），
 * 但报错里不会说原因。
 *
 * 用法：
 *   node cloudfunctions/api/scripts/gen-pay-env.js                 # 默认读当前目录
 *   node cloudfunctions/api/scripts/gen-pay-env.js D:/wxpay-cert   # 指定证书目录
 *   node cloudfunctions/api/scripts/gen-pay-env.js D:/wxpay-cert --serial 7681...058B
 *                                                                 # 顺带核对平台登记的序列号
 *
 * 期望目录内有：
 *   apiclient_cert.pem   商户 API 证书（证书工具生成，需已贴回商户平台完成申请）
 *   apiclient_key.pem    商户 API 私钥（证书工具生成，只留本地）
 *   pub_key.pem          微信支付公钥（商户平台「管理公钥」下载）
 *
 * 输出可直接粘贴到 CloudBase 控制台的环境变量，值为单行 \n 转义形式
 * （云函数侧 wxpay.js 会把 \n 还原成真实换行）。
 */
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const args = process.argv.slice(2)
function argOf(flag) {
  const i = args.indexOf(flag)
  if (i === -1) return null
  const v = args[i + 1]
  args.splice(i, v !== undefined && !String(v).startsWith('--') ? 2 : 1)
  return v && !String(v).startsWith('--') ? String(v) : null
}
// --serial 可以传入商户平台「管理证书」页显示的序列号，用于核对证书文件是否同一张
const EXPECTED_SERIAL = argOf('--serial') || process.env.MCH_SERIAL_NO || null
const dir = args[0] || process.cwd()
const MCH_ID = process.env.MCH_ID || '1006122850'
const NOTIFY_URL =
  process.env.PAY_NOTIFY_URL ||
  'https://linyougo-dev-d0gkgswl0504c86e2-1534792212.ap-shanghai.app.tcloudbase.com/api'

function readMaybe(name) {
  const p = path.join(dir, name)
  try {
    return { name, path: p, text: fs.readFileSync(p, 'utf8') }
  } catch (e) {
    return { name, path: p, text: null }
  }
}

function die(msg) {
  console.error('\n[失败] ' + msg + '\n')
  process.exit(1)
}

function oneLine(pemText) {
  return pemText.replace(/\r\n/g, '\n').trim().replace(/\n/g, '\\n')
}

const cert = readMaybe('apiclient_cert.pem')
const key = readMaybe('apiclient_key.pem')
const pub = readMaybe('pub_key.pem')

const missingFiles = [cert, key, pub].filter((f) => !f.text).map((f) => f.name)
if (missingFiles.length) {
  die(
    '在 ' + dir + ' 里找不到：' + missingFiles.join('、') + '\n' +
      '  apiclient_*.pem 由微信支付证书工具（WXCertUtil）生成；\n' +
      '  pub_key.pem 要去商户平台 → 账户中心 → API安全 → 管理公钥 下载。'
  )
}

// ---- 1) 私钥能否解析（粘坏了这里就会炸） ----
let privateKey
try {
  privateKey = crypto.createPrivateKey(key.text)
} catch (e) {
  die('apiclient_key.pem 不是有效的私钥：' + e.message)
}

// ---- 2) 证书能否解析，并取序列号 ----
let x509
try {
  x509 = new crypto.X509Certificate(cert.text)
} catch (e) {
  die('apiclient_cert.pem 不是有效的证书：' + e.message)
}
const serial = String(x509.serialNumber || '').replace(/[^0-9a-fA-F]/g, '').toUpperCase()
if (!serial) die('没能从证书里读到序列号')

// 若外部给了序列号（商户平台「管理证书」页看到的那个），核对是否同一张证书。
// 不一致通常意味着手里是旧证书文件，而平台登记的是新证书，签名会被拒。
const expected = EXPECTED_SERIAL ? String(EXPECTED_SERIAL).replace(/[^0-9a-fA-F]/g, '').toUpperCase() : null
const serialMatched = !expected || expected === serial

// ---- 3) 私钥与证书必须是一对 ----
const fromKey = crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'der' })
const fromCert = x509.publicKey.export({ type: 'spki', format: 'der' })
const paired = Buffer.compare(fromKey, fromCert) === 0

// ---- 4) 微信支付公钥能否解析 ----
let pubKey
try {
  pubKey = crypto.createPublicKey(pub.text)
} catch (e) {
  die('pub_key.pem 不是有效的公钥：' + e.message)
}

const now = new Date()
const expired = new Date(x509.validTo) < now

console.log('\n=========== 本地产物自检 ===========')
console.log('证书主题   :', x509.subject.replace(/\n/g, ' '))
console.log('证书有效期 :', x509.validFrom, '→', x509.validTo, expired ? '  [已过期]' : '  [有效]')
console.log('证书序列号 :', serial, '(' + serial.length + ' 位)')
if (expected) {
  console.log('平台序列号 :', expected, serialMatched ? '  [与证书一致]' : '  [与证书不一致]')
}
console.log('私钥算法   :', privateKey.asymmetricKeyType, privateKey.asymmetricKeyDetails ? privateKey.asymmetricKeyDetails.modulusLength + ' bit' : '')
console.log('公私钥配对 :', paired ? '匹配' : '不匹配 —— 私钥和证书不是同一张，请重新申请证书')
console.log('微信支付公钥:', pubKey.asymmetricKeyType)
if (expired) console.log('警告：证书已过期，签名会被微信拒绝，请重新申请。')
if (!paired) process.exitCode = 2
if (!serialMatched) {
  console.log('警告：你给的序列号与 apiclient_cert.pem 里的不一致。')
  console.log('      说明这个证书目录里放的不是平台当前登记的那一张，签名会返回 401 SIGN_ERROR。')
  if (process.exitCode === undefined) process.exitCode = 3
}

// ---- 5) 输出环境变量 ----
const envBlock = [
  'MCH_ID=' + MCH_ID,
  'MCH_SERIAL_NO=' + serial,
  'MCH_PRIVATE_KEY=' + oneLine(key.text),
  'APIV3_KEY=<你设置的32位APIv3密钥，脚本不接触>',
  'WXPAY_PUBLIC_KEY=' + oneLine(pub.text),
  'WXPAY_PUBLIC_KEY_ID=<商户平台「管理公钥」页面上的 PUB_KEY_ID_ 开头的值>',
  'PAY_NOTIFY_URL=' + NOTIFY_URL
].join('\n')

const outFile = path.join(dir, 'pay-env.local.txt')
fs.writeFileSync(outFile, envBlock + '\n', 'utf8')

console.log('\n=========== 环境变量（已写入 ' + outFile + '） ===========')
console.log(envBlock)
console.log('\n注意：')
console.log('  1. 这个文件含私钥，已在 .gitignore 里（*.pem / apiclient_* / pay-env.local.txt），不要提交、不要发人；')
console.log('  2. 剩下两项带 <尖括号> 的需要你手工补：APIv3 密钥、微信支付公钥 ID；')
console.log('  3. 粘进 CloudBase 控制台时保持单行，值里的 \\n 不要还原成换行；')
console.log('  4. 加完环境变量记得核对 WX_APPID / WX_APPSECRET 仍在（用控制台或 fn code update，不要用 config update）。\n')
