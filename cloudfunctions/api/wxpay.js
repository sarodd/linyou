/**
 * 微信支付 APIv3 直连客户端（普通商户模式）
 *
 * 为什么自己写而不用 SDK：只用 JSAPI 下单 / 查单 / 关单 / 退款 / 退款查询这几个接口，
 * 手写 RSA-SHA256 签名比引入 SDK 更可控，也不会给云函数增加依赖体积（当前已压到 42MB）。
 *
 * 需要的环境变量（全部从云函数环境变量注入，绝不写进代码）：
 *   MCH_ID              商户号
 *   MCH_SERIAL_NO       商户 API 证书序列号（40 位十六进制）
 *   MCH_PRIVATE_KEY     apiclient_key.pem 的内容（含 BEGIN/END 行，换行可用 \n 转义）
 *   APIV3_KEY           商户 APIv3 密钥（32 位，用于解密回调）
 *   WXPAY_PUBLIC_KEY    微信支付公钥（pub_key.pem 内容）
 *   WXPAY_PUBLIC_KEY_ID 微信支付公钥 ID（PUB_KEY_ID_ 开头）
 *   PAY_NOTIFY_URL      支付结果回调地址（公网 HTTPS，不带参数）
 *
 * 注意：v3 的「公钥模式」用微信支付公钥验签，不再走平台证书下载，
 * 因此不需要证书管理器，也不需要用 APIv3 密钥去解平台证书。
 */
const crypto = require('crypto')
const https = require('https')

const BASE_HOST = 'api.mch.weixin.qq.com'

function pem(v) {
  return String(v || '').replace(/\\n/g, '\n').trim()
}

const MCH_ID = String(process.env.MCH_ID || '').trim()
const MCH_SERIAL_NO = String(process.env.MCH_SERIAL_NO || '').trim()
const MCH_PRIVATE_KEY = pem(process.env.MCH_PRIVATE_KEY)
const APIV3_KEY = String(process.env.APIV3_KEY || '').trim()
const WXPAY_PUBLIC_KEY = pem(process.env.WXPAY_PUBLIC_KEY)
const WXPAY_PUBLIC_KEY_ID = String(process.env.WXPAY_PUBLIC_KEY_ID || '').trim()
const NOTIFY_URL = String(process.env.PAY_NOTIFY_URL || '').trim()
const APP_ID = String(process.env.WX_APPID || process.env.wX_APPID || 'wxc924d24af61816e9').trim()
// 微信支付环境：正式环境不需要传，这里保留开关便于将来接沙箱类服务
const API_BASE = process.env.WXPAY_API_BASE || ('https://' + BASE_HOST)

/** 配置是否齐全。缺任何一项都不要尝试调支付接口，否则报错很难懂。 */
function missing() {
  const miss = []
  if (!MCH_ID) miss.push('MCH_ID')
  if (!MCH_SERIAL_NO) miss.push('MCH_SERIAL_NO')
  if (!MCH_PRIVATE_KEY) miss.push('MCH_PRIVATE_KEY')
  if (!APIV3_KEY) miss.push('APIV3_KEY')
  if (!WXPAY_PUBLIC_KEY) miss.push('WXPAY_PUBLIC_KEY')
  if (!WXPAY_PUBLIC_KEY_ID) miss.push('WXPAY_PUBLIC_KEY_ID')
  if (!NOTIFY_URL) miss.push('PAY_NOTIFY_URL')
  return miss
}

function isConfigured() {
  return missing().length === 0
}

function nonce() {
  return crypto.randomBytes(16).toString('hex').toUpperCase()
}

/**
 * 请求签名。待签名串固定为：
 *   METHOD\nURL_PATH\nTIMESTAMP\nNONCE\nBODY\n
 * GET 的 BODY 为空串，所以结尾是连续两个换行。
 */
function signRequest(method, urlPath, body) {
  const ts = Math.floor(Date.now() / 1000).toString()
  const nc = nonce()
  const message = `${method}\n${urlPath}\n${ts}\n${nc}\n${body}\n`
  const signature = crypto.createSign('RSA-SHA256').update(message).sign(MCH_PRIVATE_KEY, 'base64')
  return `WECHATPAY2-SHA256-RSA2048 mchid="${MCH_ID}",nonce_str="${nc}",signature="${signature}",timestamp="${ts}",serial_no="${MCH_SERIAL_NO}"`
}

/** 底层 HTTPS 请求，返回解析后的 JSON；非 2xx 抛出带 code/message 的错误 */
function httpJson(method, urlPath, bodyObj) {
  return new Promise((resolve, reject) => {
    const body = bodyObj ? JSON.stringify(bodyObj) : ''
    const authorization = signRequest(method, urlPath, body)
    const req = https.request({
      hostname: BASE_HOST,
      path: urlPath,
      method,
      headers: {
        Authorization: authorization,
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': 'linyou-miniprogram/1.0',
        'Content-Length': Buffer.byteLength(body)
      }
    }, (res) => {
      let raw = ''
      res.on('data', (c) => { raw += c })
      res.on('end', () => {
        let data = null
        try { data = raw ? JSON.parse(raw) : null } catch (e) { /* 非 JSON 响应 */ }
        if (res.statusCode >= 200 && res.statusCode < 300) return resolve(data || {})
        const err = new Error((data && (data.message || data.code)) || ('HTTP ' + res.statusCode))
        err.statusCode = res.statusCode
        err.code = (data && data.code) || 'HTTP_' + res.statusCode
        err.detail = data
        reject(err)
      })
    })
    req.on('error', reject)
    req.setTimeout(10000, () => req.destroy(new Error('微信支付接口超时')))
    if (body) req.write(body)
    req.end()
  })
}

/** JSAPI 下单，返回 prepay_id */
async function jsapiPrepay({ openid, outTradeNo, amountFen, description, attach }) {
  if (!isConfigured()) {
    const e = new Error('微信支付未配置：缺少 ' + missing().join(', '))
    e.code = 'PAY_NOT_CONFIGURED'
    throw e
  }
  if (!openid || !outTradeNo || !amountFen) {
    const e = new Error('下单参数不完整')
    e.code = 'BAD_PARAM'
    throw e
  }
  const res = await httpJson('POST', '/v3/pay/transactions/jsapi', {
    appid: APP_ID,
    mchid: MCH_ID,
    description: String(description || '门店商品').slice(0, 40),
    out_trade_no: outTradeNo,
    notify_url: NOTIFY_URL,
    attach: attach ? String(attach).slice(0, 127) : undefined,
    amount: { total: Number(amountFen), currency: 'CNY' },
    payer: { openid }
  })
  return res.prepay_id
}

/**
 * 生成 wx.requestPayment 所需参数。
 * 待签名串：appId\ntimeStamp\nnonceStr\npackage\n（注意最后也有换行）
 * signType 必须是 RSA —— 这是 v3 与 v2 最容易搞混的地方，填 MD5 一定调不起。
 */
function buildPayParams(prepayId) {
  const timeStamp = Math.floor(Date.now() / 1000).toString()
  const nonceStr = nonce()
  const pkg = 'prepay_id=' + prepayId
  const message = `${APP_ID}\n${timeStamp}\n${nonceStr}\n${pkg}\n`
  const paySign = crypto.createSign('RSA-SHA256').update(message).sign(MCH_PRIVATE_KEY, 'base64')
  return { timeStamp, nonceStr, package: pkg, signType: 'RSA', paySign }
}

/** 查单：既用于「回调丢了」的兜底，也用于关单前确认状态 */
async function queryOrder(outTradeNo) {
  return httpJson('GET', `/v3/pay/transactions/out-trade-no/${encodeURIComponent(outTradeNo)}?mchid=${MCH_ID}`)
}

/** 关单：未支付订单必须关掉，否则用户还能继续付款，而库存已被释放 */
async function closeOrder(outTradeNo) {
  return httpJson('POST', `/v3/pay/transactions/out-trade-no/${encodeURIComponent(outTradeNo)}/close`, { mchid: MCH_ID })
}

/** 申请退款（按原路退回）。outRefundNo 用确定性单号，重复调用同一单号是幂等的。 */
async function refund({ outTradeNo, outRefundNo, refundFen, totalFen, reason }) {
  return httpJson('POST', '/v3/refund/domestic/refunds', {
    out_trade_no: outTradeNo,
    out_refund_no: outRefundNo,
    reason: String(reason || '').slice(0, 80) || undefined,
    amount: { refund: Number(refundFen), total: Number(totalFen), currency: 'CNY' }
  })
}

/** 查退款：SUCCESS / PROCESSING / CLOSED / ABNORMAL */
async function queryRefund(outRefundNo) {
  return httpJson('GET', `/v3/refund/domestic/refunds/${encodeURIComponent(outRefundNo)}`)
}

/** 用 APIv3 密钥解密回调报文（AES-256-GCM） */
function decryptResource(resource) {
  if (!resource || !resource.ciphertext) throw new Error('回调缺少 resource')
  const key = Buffer.from(APIV3_KEY, 'utf8')
  if (key.length !== 32) throw new Error('APIV3_KEY 长度必须为 32 字节')
  const data = Buffer.from(resource.ciphertext, 'base64')
  const iv = Buffer.from(resource.nonce, 'utf8')
  const aad = Buffer.from(resource.associated_data || '', 'utf8')
  const tag = data.subarray(data.length - 16)
  const body = data.subarray(0, data.length - 16)
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  decipher.setAAD(aad)
  const plain = Buffer.concat([decipher.update(body), decipher.final()])
  return JSON.parse(plain.toString('utf8'))
}

/**
 * 验签回调。
 * headers 大小写不固定（CloudBase 网关可能转成小写），统一转小写后再取。
 * 时间戳超过 5 分钟直接拒绝，避免重放。
 */
function verifyNotify(headers, rawBody) {
  const h = {}
  Object.keys(headers || {}).forEach((k) => { h[String(k).toLowerCase()] = headers[k] })
  const ts = h['wechatpay-timestamp']
  const nc = h['wechatpay-nonce']
  const sig = h['wechatpay-signature']
  const serial = h['wechatpay-serial']
  if (!ts || !nc || !sig) return { ok: false, reason: 'MISSING_HEADER' }
  if (Math.abs(Math.floor(Date.now() / 1000) - Number(ts)) > 300) {
    return { ok: false, reason: 'TIMESTAMP_EXPIRED' }
  }
  // 公钥模式下 serial 是公钥 ID；配了才校验，避免微信侧换公钥时误拒
  if (WXPAY_PUBLIC_KEY_ID && serial && serial !== WXPAY_PUBLIC_KEY_ID) {
    return { ok: false, reason: 'PUBLIC_KEY_ID_MISMATCH', serial }
  }
  const message = `${ts}\n${nc}\n${rawBody}\n`
  let ok = false
  try {
    ok = crypto.createVerify('RSA-SHA256').update(message).verify(WXPAY_PUBLIC_KEY, sig, 'base64')
  } catch (e) {
    return { ok: false, reason: 'VERIFY_ERROR:' + e.message }
  }
  return ok ? { ok: true } : { ok: false, reason: 'SIGNATURE_MISMATCH' }
}

module.exports = {
  isConfigured,
  missing,
  jsapiPrepay,
  buildPayParams,
  queryOrder,
  closeOrder,
  refund,
  queryRefund,
  decryptResource,
  verifyNotify,
  APP_ID,
  MCH_ID
}
