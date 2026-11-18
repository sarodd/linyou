// 云函数调用统一封装
// 登录：wx.login -> code -> 云函数 code2session -> 自定义登录态 token
//      登录不可用时自动回退 _testOpenid=preview，保证未配置 AppSecret 的预览仍可用
// 主通道：wx.request -> CloudBase HTTP 访问服务（不依赖微信侧云开发开通）
// 兜底：wx.cloud.callFunction（将来 AppID 开通云开发后自动可用）
const app = () => getApp()
const base = () => (app() && app().globalData && app().globalData.apiBase) || ''
const previewId = () => (app() && app().globalData && app().globalData.previewOpenid) || 'preview'

const TOKEN_KEY = 'ly_login_token'
const LOGIN_RETRY_COOLDOWN = 5 * 60 * 1000

let loginPromise = null
let lastLoginFailAt = 0
// 登录诊断：记录成功/失败原因，供运营页「当前登录身份」卡片展示
// 微信登录本身是静默的（wx.login 不弹窗），失败也必须有可观测反馈
let loginDiag = { status: 'idle', reason: '', at: 0 }

function setDiag(status, reason) {
  loginDiag = { status, reason: reason || '', at: Date.now() }
  const a = app()
  if (a && a.globalData) a.globalData.loginDiag = loginDiag
}

function readToken() {
  try { return wx.getStorageSync(TOKEN_KEY) || '' } catch (e) { return '' }
}

function writeToken(t) {
  try {
    if (t) wx.setStorageSync(TOKEN_KEY, t)
    else wx.removeStorageSync(TOKEN_KEY)
  } catch (e) { /* 缓存不可用时不阻断业务 */ }
  const a = app()
  if (a && a.globalData) {
    a.globalData.token = t || null
    a.globalData.loginMode = t ? 'wx' : 'preview'
    if (!t) a.globalData.myOpenid = null
  }
}

function clearLogin() {
  writeToken('')
  loginPromise = null
  lastLoginFailAt = 0
  setDiag('idle', '')
}

// ---------- 角色（两档：user 普通用户 / admin 管理员）----------
// 角色由云端 whoAmI 依据 openid 白名单判定；前端只负责展示与入口控制，不是安全边界。
// 真正的隔离在云函数 ADMIN_ACTIONS + requireAdmin()，前端隐藏入口只是体验层。
function getRole() {
  const a = app()
  return (a && a.globalData && a.globalData.role) || 'user'
}
function getIdentity() {
  const a = app()
  return (a && a.globalData && a.globalData.identity) || null
}
// 拉取身份与角色并缓存到 globalData，供自定义 tabBar 和页面守卫读取
async function refreshRole() {
  const r = await call('whoAmI')
  const a = app()
  if (r && r.ok && a && a.globalData) {
    a.globalData.identity = r
    a.globalData.role = r.role || 'user'
    a.globalData.myOpenid = r.openid || null
  }
  return getRole()
}

// 裸请求：不走登录流程，供 login 自身使用，避免递归
function rawRequest(payload) {
  return new Promise((resolve) => {
    wx.request({
      url: base(),
      method: 'POST',
      header: { 'content-type': 'application/json' },
      data: payload,
      timeout: 15000,
      success: (res) => {
        if (res.statusCode === 200 && res.data && typeof res.data === 'object') {
          // 查询类接口成功时只返回数据、不带 ok 字段；统一补 ok:true 避免前端误判
          if (res.data.ok === undefined) res.data.ok = true
          resolve(res.data)
          return
        }
        // 针对常见 HTTP 错误给出明确提示，避免一律显示 "HTTP xxx"
        let code = 'HTTP_ERROR'
        let message = '服务请求失败（HTTP ' + res.statusCode + '）'
        if (res.statusCode === 413) {
          code = 'PAYLOAD_TOO_LARGE'
          message = '图片体积过大，服务器拒绝接收，请选择更小的图片'
        } else if (res.statusCode === 401 || res.statusCode === 403) {
          code = 'HTTP_AUTH'
          message = '无权限访问服务，请检查环境配置'
        } else if (res.statusCode >= 500) {
          code = 'SERVER_ERROR'
          message = '服务暂时不可用（HTTP ' + res.statusCode + '）'
        }
        resolve({ ok: false, code, message })
      },
      fail: (err) => resolve({ ok: false, code: 'NETWORK_ERROR', message: err.errMsg || err.message || '网络连接失败' })
    })
  })
}

// 把登录失败翻译成可操作的中文原因（真机调试最常见的是域名未配置）
function friendlyLoginError(r) {
  if (!r) return '云端无响应'
  const msg = r.message || ''
  switch (r.code) {
    case 'NO_APPSECRET': return '云端未配置 WX_APPSECRET 环境变量'
    case 'WX_UNREACHABLE': return '云端无法访问微信接口：' + msg
    case 'WX_LOGIN_FAILED': return '微信拒绝登录（errcode ' + (r.wxErrcode || '-') + '）：' + msg
    case 'NETWORK_ERROR': return '无法连接云端，请检查 request 合法域名与网络：' + msg
    case 'PAYLOAD_TOO_LARGE': return '登录请求被拒：' + msg
    case 'HTTP_AUTH': return '云端拒绝访问：' + msg
    case 'SERVER_ERROR': return '云端服务异常：' + msg
    default: return (r.code || '登录失败') + (msg ? '：' + msg : '')
  }
}

// 用 wx.login 拿到的 code 换云端自定义登录态
// 注意：wx.login 是「静默」的，不会弹出任何授权界面，这是微信小程序的标准行为
function doLogin() {
  return new Promise((resolve) => {
    wx.login({
      success: async (lr) => {
        if (!lr.code) {
          writeToken('')
          setDiag('fail', 'wx.login 未返回 code')
          resolve(null); return
        }
        const r = await rawRequest({ action: 'login', code: lr.code })
        if (r && r.ok && r.token) {
          writeToken(r.token)
          const a = app()
          if (a && a.globalData) a.globalData.myOpenid = r.openid || null
          setDiag('ok', '')
          resolve(r.token)
        } else {
          // 未配置 WX_APPSECRET / 域名被拦 / 微信侧拒绝：回退预览身份，但记录原因
          writeToken('')
          setDiag('fail', friendlyLoginError(r))
          resolve(null)
        }
      },
      fail: (err) => {
        writeToken('')
        setDiag('fail', 'wx.login 调用失败：' + (err && err.errMsg ? err.errMsg : '未知原因'))
        resolve(null)
      }
    })
  })
}

// 确保拿到登录态；失败后 5 分钟内不重复尝试，避免每个请求都多一次网络往返
function ensureLogin() {
  const a = app()
  const cached = (a && a.globalData && a.globalData.token) || readToken()
  if (cached) {
    if (a && a.globalData) {
      if (!a.globalData.token) a.globalData.token = cached
      a.globalData.loginMode = 'wx'
      if (loginDiag.status !== 'ok') setDiag('ok', '')
    }
    return Promise.resolve(cached)
  }
  if (loginPromise) return loginPromise
  if (Date.now() - lastLoginFailAt < LOGIN_RETRY_COOLDOWN) return Promise.resolve(null)
  loginPromise = doLogin().then((t) => {
    loginPromise = null
    if (!t) lastLoginFailAt = Date.now()
    return t
  }).catch(() => {
    loginPromise = null
    lastLoginFailAt = Date.now()
    setDiag('fail', '登录流程异常')
    return null
  })
  return loginPromise
}

// 业务请求：优先带 token；未登录时回退 _testOpenid 预览身份
async function httpCall(action, data = {}) {
  const token = await ensureLogin()
  const payload = Object.assign({ action }, data)
  if (token) payload.token = token
  else payload._testOpenid = previewId()
  return rawRequest(payload)
}

function cloudCall(action, data = {}) {
  if (!wx.cloud) return Promise.resolve({ ok: false, code: 'NO_CLOUD' })
  return wx.cloud.callFunction({
    name: 'api',
    data: { action, ...data }
  }).then(res => {
    const r = res.result
    if (r && typeof r === 'object' && r.ok === undefined) r.ok = true
    return r
  }).catch(err => ({
    ok: false, code: 'NETWORK_ERROR', message: err.message
  }))
}

// 统一入口：HTTP 优先，只有网络层失败或服务端 5xx 时才回退云函数。
// 413 / 401 / 403 属于明确的请求错误，回退云函数无意义且会掩盖真实原因。
const call = async (action, data = {}) => {
  let r = await httpCall(action, data)
  // 登录态失效：清除缓存后强制重新登录并重试一次
  if (r && r.code === 'NO_LOGIN') {
    clearLogin()
    r = await httpCall(action, data)
  }
  if (r && (r.code === 'NETWORK_ERROR' || r.code === 'HTTP_ERROR' || r.code === 'SERVER_ERROR')) {
    return cloudCall(action, data)
  }
  return r
}

module.exports = {
  seed: () => call('seed'),
  getActivity: () => call('getActivity'),
  // 登录与身份（页面一般无需直接调，请求会自动触发 ensureLogin）
  login: () => doLogin(),
  whoAmI: () => call('whoAmI'),
  reLogin: () => { clearLogin(); return ensureLogin() },
  ensureLogin: () => ensureLogin(),
  getLoginDiag: () => loginDiag,
  getLoginMode: () => {
    const a = app()
    return (a && a.globalData && a.globalData.loginMode) || 'preview'
  },
  // 运营配置
  adminGetConfig: () => call('adminGetConfig'),
  adminSaveActivity: (d) => call('adminSaveActivity', d),
  adminSavePoster: (d) => call('adminSavePoster', d),
  adminPosterInit: (d) => call('adminPosterInit', d),
  adminPosterChunk: (d) => call('adminPosterChunk', d),
  adminPosterMerge: (d) => call('adminPosterMerge', d),
  adminResetPoster: () => call('adminResetPoster'),
  adminSaveStore: (d) => call('adminSaveStore', d),
  adminDeleteStore: (d) => call('adminDeleteStore', d),
  createOrder: (d) => call('createOrder', d),
  mockPay: (d) => call('mockPay', d),
  mockRefund: (d) => call('mockRefund', d),
  getInvitation: (d) => call('getInvitation', d),
  getMyOrders: () => call('getMyOrders'),
  getOrderDetail: (d) => call('getOrderDetail', d),
  genVerifyCode: (d) => call('genVerifyCode', d),
  staffOrders: () => call('staffOrders'),
  staffVerify: (d) => call('staffVerify', d),
  staffCancel: (d) => call('staffCancel', d),
  dashboard: () => call('dashboard'),
  ledger: () => call('ledger'),
  // 管理员成员管理
  adminGrant: (d) => call('adminGrant', d),
  adminRevoke: (d) => call('adminRevoke', d),
  adminListAdmins: () => call('adminListAdmins'),
  // 角色读取 / 刷新
  getRole: () => getRole(),
  getIdentity: () => getIdentity(),
  refreshRole: () => refreshRole(),
  // 个人资料（昵称 / 头像，仅本人可读写）
  getProfile: () => call('getProfile'),
  saveProfile: (d) => call('saveProfile', d)
}

// 分 -> 元字符串
const fen2yuan = (fen) => {
  const n = Number(fen || 0) / 100
  return n.toFixed(2)
}
module.exports.fen2yuan = fen2yuan

const fmtTime = (ts) => {
  if (!ts) return '-'
  const d = new Date(ts)
  const p = (x) => (x < 10 ? '0' + x : '' + x)
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}
module.exports.fmtTime = fmtTime
