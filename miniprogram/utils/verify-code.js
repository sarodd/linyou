// 核销凭证的编解码：顾客端把订单号 + 6 位核销码拼成二维码，店员端扫码还原。
// 格式固定为 3 段：LY1|orderId|code，前缀用于识别「是不是本小程序的码」。

const PREFIX = 'LY1'
const ORDER_ID_RE = /^[A-Za-z0-9_-]{6,64}$/
const CODE_RE = /^\d{6}$/

function buildPayload(orderId, code) {
  return PREFIX + '|' + orderId + '|' + String(code)
}

// 返回 { orderId, code }，非本格式返回 null（扫码枪扫到别家的码、纯数字条码都会走 null）
function parsePayload(raw) {
  const s = String(raw || '').trim()
  if (!s) return null
  const parts = s.split('|')
  if (parts.length !== 3) return null
  if (parts[0] !== PREFIX) return null
  const orderId = parts[1]
  const code = parts[2]
  if (!ORDER_ID_RE.test(orderId) || !CODE_RE.test(code)) return null
  return { orderId, code }
}

module.exports = { PREFIX, buildPayload, parsePayload }
