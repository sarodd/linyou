/**
 * 核心业务云函数 api
 * 邀请达标返佣（邀请达标门店退款）MVP - 后端全部运行在 CloudBase
 *
 * 设计要点（对齐 PRD）：
 * - 金额一律以「分」为单位，前端展示时 /100
 * - 幂等：佣金单 / 邀请有效记录使用确定性 _id；支付回调按订单状态 CAS
 * - 并发互斥：资金锁定与达标判定放在 db.runTransaction 内，配合状态 CAS
 * - 规则版本：订单快照购买时的活动规则版本
 * - 当前已接入微信支付 APIv3（普通商户直连）：prepay 下单、handlePayNotify 回调、
 *   adminRefund/adminSyncRefund 渠道退款；mockPay 仅在显式设 MOCK_PAY_ENABLED=true 时可用。
 */
const cloud = require('wx-server-sdk')
const crypto = require('crypto')
const https = require('https')
const wxpay = require('./wxpay')
// 说明：曾尝试换成 @cloudbase/node-sdk v4 瘦身，但其 API 与 wx-server-sdk 不兼容
// （doc().get().data 变数组、update() 返回 {updated} 而非 {stats:{updated}}、写入不再包 {data}），
// 全量迁移风险高于收益，故继续使用 wx-server-sdk，瘦身改走「剔除类型包」的方式。
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const _ = db.command

const C = {
  ACTIVITY: 'activities',
  STORE: 'stores',
  ORDER: 'orders',
  INVITATION: 'invitations',   // 每笔原订单一条邀请记录
  INVITE_RECORD: 'invite_records', // 有效受邀关系（去重）
  COMMISSION: 'commissions',
  LEDGER: 'fund_ledger',
  STAFF: 'staff',
  OPLOG: 'op_log',
    POSTER_CHUNK: 'poster_chunks', // 海报分片临时集合
    SESSION: 'sessions',           // 自定义登录态：token -> openid
    ADMIN: 'admins',               // 管理员白名单（openid）
    PROFILE: 'profiles'            // 用户资料：昵称 / 头像（一 openid 一条）
  }

// ---------- 微信登录配置 ----------
// AppID 是公开信息；AppSecret 属于密钥，只允许通过云函数环境变量注入，
// 绝不写进代码仓库或小程序前端。未配置时 login 返回 NO_APPSECRET，
// 前端会自动回退到预览身份（_testOpenid=preview），演示功能不受影响。
// CLI 部分版本会把环境变量名首字母小写（WX_ -> wX_），这里兼容两种写法
const WX_APPID = process.env.WX_APPID || process.env.wX_APPID || 'wxc924d24af61816e9'
const WX_APPSECRET = process.env.WX_APPSECRET || process.env.wX_APPSECRET || ''
const SESSION_TTL = 7 * 86400000
// ---------- 角色与权限（两档：user 普通用户 / admin 管理员）----------
// 角色只由「微信登录拿到的 openid」判定，与「微信认证（主体资质认证）」无关。
// 管理员来源：① 环境变量 ADMIN_OPENIDS（逗号分隔的 openid，形如 wx_xxx）
//             ② 数据库 admins 集合（{ openid, enabled }，便于动态增删而不必重新部署）
// 测试通道开关：预览兜底与 e2e/edge 自检依赖 _testOpenid；上线设 false 关闭。
const ALLOW_TEST_IDENTITY = process.env.ALLOW_TEST_IDENTITY !== 'false'
// 预览身份是否具备管理员能力。默认关闭（安全优先）：
// 登录失败回退到 preview 的用户只能浏览活动与自己订单，拿不到运营权限。
// 需要纯预览演示时显式设 PREVIEW_ADMIN=true。
const PREVIEW_ADMIN = process.env.PREVIEW_ADMIN === 'true'
// 自检接口开关。e2eTest / edgeTest 会清空订单、邀请、佣金、流水、店员、日志等业务集合，
// 一旦线上误触就是不可逆的数据事故，因此默认禁用，仅在明确需要时临时开启。
const ALLOW_SELF_TEST = process.env.ALLOW_SELF_TEST === 'true'
// 演示支付开关。接入真实微信支付后默认关闭，必须显式设 MOCK_PAY_ENABLED=true 才打开。
// 这个方向很重要：以前的写法是「没写 false 就等于打开」，一旦忘记配置，
// 线上任何人点支付都能白拿订单，是比功能缺失严重得多的漏洞。
const MOCK_PAY_ENABLED = process.env.MOCK_PAY_ENABLED === 'true'
const ADMIN_OPENIDS = String(process.env.ADMIN_OPENIDS || '').split(',').map(s => s.trim()).filter(Boolean)
// 预览期可提权的固定演示身份（前端登录兜底固定为 preview，自检脚本用 staff）。
// 任意其他 _testOpenid 一律降为普通用户，堵住「随便编个身份就是管理员」的提权口子。
const PREVIEW_ADMIN_IDS = String(process.env.PREVIEW_ADMIN_IDS || 'preview,staff')
  .split(',').map(s => s.trim()).filter(Boolean)

const now = () => Date.now()

// 身份上下文：每次请求重新解析，云函数进程内不串号。
// 优先级：_testOpenid 测试通道 > 自定义登录态 token > 微信云开发 OPENID。
let __testOpenid = null
let __identity = { openid: null, source: 'none', isTest: false }
// 本次请求解析出的角色：'user' | 'admin'
let __role = 'user'

function openid() {
  // e2e/edgeTest 在函数内部通过 __testOpenid 模拟多用户，优先级最高
  if (__testOpenid) return 'test_' + __testOpenid
  return __identity.openid || 'anonymous'
}

function httpsGetJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, (res) => {
      let raw = ''
      res.on('data', (c) => { raw += c })
      res.on('end', () => {
        try { resolve(JSON.parse(raw)) } catch (e) { reject(new Error('微信接口返回非 JSON')) }
      })
    })
    req.on('error', reject)
    req.setTimeout(8000, () => req.destroy(new Error('微信接口请求超时')))
  })
}

// 通用 POST：body 支持字符串（JSON）或 Buffer（multipart 图片）
function httpsPost(url, body, headers) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.isBuffer(body) ? body : Buffer.from(String(body || ''), 'utf8')
    const u = new URL(url)
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: 'POST',
      headers: Object.assign({ 'Content-Length': payload.length }, headers || {})
    }, (res) => {
      let raw = ''
      res.on('data', (c) => { raw += c })
      res.on('end', () => {
        try { resolve(JSON.parse(raw)) } catch (e) { reject(new Error('微信接口返回非 JSON')) }
      })
    })
    req.on('error', reject)
    req.setTimeout(8000, () => req.destroy(new Error('微信接口请求超时')))
    req.write(payload)
    req.end()
  })
}

// ---------- 微信内容安全（需小程序已认证；未配置 AppSecret 时自动跳过） ----------
// access_token 缓存在实例内存里：云函数实例复用期间有效，冷启动重取一次即可，
// 不落库也就不会多出一个集合。
let __tokenCache = { value: '', expireAt: 0 }

async function getAccessToken() {
  if (__tokenCache.value && Date.now() < __tokenCache.expireAt) return __tokenCache.value
  if (!WX_APPID || !WX_APPSECRET) return ''
  const r = await httpsGetJson('https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential'
    + '&appid=' + encodeURIComponent(WX_APPID) + '&secret=' + encodeURIComponent(WX_APPSECRET))
  if (!r || !r.access_token) {
    await log('sec_token_fail', { errcode: r && r.errcode, errmsg: r && r.errmsg })
    return ''
  }
  // 提前 5 分钟过期，避免边界上用到失效 token
  __tokenCache = { value: r.access_token, expireAt: Date.now() + Math.max(60, (r.expires_in || 7200) - 300) * 1000 }
  return r.access_token
}

// 返回 'pass' | 'risky' | 'skip'（skip = 未配置密钥/接口异常，按放行处理但记审计）
async function secCheckText(content, oid) {
  const text = String(content || '').trim()
  if (!text) return 'pass'
  const token = await getAccessToken()
  if (!token) return 'skip'
  try {
    const r = await httpsPost(
      'https://api.weixin.qq.com/wxa/msg_sec_check?access_token=' + encodeURIComponent(token),
      JSON.stringify({ content: text, version: 2, scene: 2, openid: oid }),
      { 'Content-Type': 'application/json' }
    )
    if (r && r.errcode === 87014) return 'risky'
    if (r && r.errcode) {
      await log('sec_text_fail', { errcode: r.errcode, errmsg: r.errmsg })
      return 'skip'
    }
    const suggest = r && r.result && r.result.suggest
    if (suggest === 'risky') return 'risky'
    if (suggest === 'review') await log('sec_text_review', { label: r.result.label })
    return 'pass'
  } catch (err) {
    await log('sec_text_error', { message: (err && err.message) || 'unknown' })
    return 'skip'
  }
}

async function secCheckImage(dataUrl, oid) {
  const m = /^data:image\/(jpeg|jpg|png);base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''))
  if (!m) return 'skip' // webp 等格式 img_sec_check 不收，交给存储侧白名单限制
  const token = await getAccessToken()
  if (!token) return 'skip'
  const buf = Buffer.from(m[2], 'base64')
  if (buf.length > 1024 * 1024) return 'risky' // 超过接口上限说明前端未按约定压缩
  const boundary = '----ly' + crypto.randomBytes(8).toString('hex')
  const head = Buffer.from('--' + boundary + '\r\n'
    + 'Content-Disposition: form-data; name="media"; filename="avatar.' + (m[1] === 'png' ? 'png' : 'jpg') + '"\r\n'
    + 'Content-Type: image/' + (m[1] === 'png' ? 'png' : 'jpeg') + '\r\n\r\n', 'utf8')
  const tail = Buffer.from('\r\n--' + boundary + '--\r\n', 'utf8')
  try {
    const r = await httpsPost(
      'https://api.weixin.qq.com/wxa/img_sec_check?access_token=' + encodeURIComponent(token),
      Buffer.concat([head, buf, tail]),
      { 'Content-Type': 'multipart/form-data; boundary=' + boundary }
    )
    if (r && r.errcode === 87014) return 'risky'
    if (r && r.errcode) {
      await log('sec_img_fail', { errcode: r.errcode, errmsg: r.errmsg, openid: oid })
      return 'skip'
    }
    return 'pass'
  } catch (err) {
    await log('sec_img_error', { message: (err && err.message) || 'unknown' })
    return 'skip'
  }
}

// 解析本次请求的身份（async，token 会话需查库）
async function resolveIdentity(e) {
  // 1) 测试通道：联调脚本 / 预览兜底（上线可关闭）
  if (e._testOpenid && ALLOW_TEST_IDENTITY) {
    return { openid: 'test_' + e._testOpenid, source: 'test', isTest: true }
  }
  // 2) 自定义登录态：wx.login -> code2session -> token
  if (e.token) {
    const s = await db.collection(C.SESSION).doc(String(e.token)).get().catch(() => null)
    if (s && s.data && s.data.expiresAt > now()) {
      return { openid: s.data.openid, source: 'wx', isTest: false }
    }
    return { openid: null, source: 'expired', isTest: false }
  }
  // 3) 微信云开发直连（AppID 认证后走 wx.cloud.callFunction 时自动生效）
  let wxOid = null
  try { wxOid = cloud.getWXContext().OPENID } catch (e) { /* HTTP 网关下无微信上下文 */ }
  if (wxOid) return { openid: wxOid, source: 'cloud', isTest: false }
  return { openid: null, source: 'none', isTest: false }
}

// 微信登录：小程序 wx.login 拿到的 code 换 openid，并签发自定义登录态
async function login(event) {
  const code = String(event.code || '')
  if (!code) return { ok: false, code: 'NO_CODE' }
  if (!WX_APPSECRET) {
    return { ok: false, code: 'NO_APPSECRET', message: '云函数未配置 WX_APPSECRET 环境变量' }
  }
  const url = 'https://api.weixin.qq.com/sns/jscode2session'
    + '?appid=' + encodeURIComponent(WX_APPID)
    + '&secret=' + encodeURIComponent(WX_APPSECRET)
    + '&js_code=' + encodeURIComponent(code)
    + '&grant_type=authorization_code'
  let wxRes
  try {
    wxRes = await httpsGetJson(url)
  } catch (err) {
    return { ok: false, code: 'WX_UNREACHABLE', message: err.message }
  }
  if (!wxRes.openid) {
    return {
      ok: false, code: 'WX_LOGIN_FAILED',
      wxErrcode: wxRes.errcode, message: wxRes.errmsg || '微信登录失败'
    }
  }
  // 集合可能尚未创建，先兜底创建
  try { await db.createCollection(C.SESSION) } catch (e) {}
  const oid = 'wx_' + wxRes.openid
  // 同一微信号复用未过期会话，避免每次冷启动都新建记录
  const old = await db.collection(C.SESSION).where({ openid: oid, expiresAt: _.gt(now()) }).limit(1).get().catch(() => ({ data: [] }))
  if (old.data && old.data.length) {
    return { ok: true, token: old.data[0]._id, openid: oid, expiresAt: old.data[0].expiresAt, reused: true }
  }
  const token = crypto.randomBytes(24).toString('hex')
  await db.collection(C.SESSION).add({
    data: {
      _id: token, openid: oid, wxOpenid: wxRes.openid,
      createdAt: now(), expiresAt: now() + SESSION_TTL
    }
  })
  // 顺手清理过期会话，避免 sessions 集合只增不减（尽力而为，不阻塞登录返回）
  db.collection(C.SESSION).where({ expiresAt: _.lt(now()) }).limit(10).get()
    .then(r => Promise.all((r.data || []).map(d => db.collection(C.SESSION).doc(d._id).remove().catch(() => {}))))
    .catch(() => {})
  return { ok: true, token, openid: oid, expiresAt: now() + SESSION_TTL }
}

// 判定本次请求角色。微信只提供 openid（你是谁），角色由我们自己的白名单决定（你能做什么）。
// 优先级：环境变量 ADMIN_OPENIDS > admins 集合 > 预览期固定演示身份 > 普通用户。
async function resolveRole(e) {
  const oid = openid()
  if (!oid || oid === 'anonymous') return 'user'
  if (ADMIN_OPENIDS.includes(oid)) return 'admin'
  try {
    const r = await db.collection(C.ADMIN).where({ openid: oid, enabled: true }).limit(1).get()
    if (r.data && r.data.length) return 'admin'
  } catch (err) { /* 集合不存在时按无记录处理 */ }
  if (__identity.isTest && ALLOW_TEST_IDENTITY && PREVIEW_ADMIN) {
    if (PREVIEW_ADMIN_IDS.includes(String(e._testOpenid || ''))) return 'admin'
  }
  return 'user'
}

async function adminCount() {
  const r = await db.collection(C.ADMIN).where({ enabled: true }).count().catch(() => ({ total: 0 }))
  return r.total || 0
}

// 授予管理员：尚无任何管理员时允许首位自举；之后仅管理员可操作。
// 首位自举只认真实微信登录身份，防止用测试通道抢占管理员。
async function adminGrant(event) {
  const target = String(event.openid || '').trim()
  if (!target) return { ok: false, code: 'BAD_OPENID', message: '请提供 openid' }
  const hasEnvAdmin = ADMIN_OPENIDS.length > 0
  const cnt = await adminCount()
  const firstBoot = !hasEnvAdmin && cnt === 0
  const callerIsAdmin = __role === 'admin'
  if (callerIsAdmin) {
    // 已是管理员（含预览期演示身份）：允许添加成员
  } else if (firstBoot) {
    // 首位自举只认真实微信登录身份，防止用测试通道抢占管理员
    if (!__identity.openid || __identity.isTest) {
      return { ok: false, code: 'FIRST_ADMIN_NEED_WX', message: '首位管理员需使用真实微信登录身份' }
    }
  } else {
    return { ok: false, code: 'FORBIDDEN', message: '仅管理员可添加成员' }
  }
  try { await db.createCollection(C.ADMIN) } catch (err) {}
  const id = 'adm_' + target.replace(/[^a-zA-Z0-9_-]/g, '_')
  await db.collection(C.ADMIN).doc(id).set({
    data: { openid: target, enabled: true, grantedBy: openid(), createdAt: now() }
  })
  await log('adminGrant', { target, firstBoot })
  return { ok: true, openid: target, firstAdmin: firstBoot }
}

async function adminRevoke(event) {
  if (__role !== 'admin') return { ok: false, code: 'FORBIDDEN', message: '仅管理员可移除成员' }
  const target = String(event.openid || '').trim()
  if (!target) return { ok: false, code: 'BAD_OPENID' }
  if (ADMIN_OPENIDS.includes(target)) {
    return { ok: false, code: 'ENV_ADMIN', message: '该管理员来自环境变量，请在云函数配置中移除' }
  }
  await db.collection(C.ADMIN).where({ openid: target }).update({ data: { enabled: false } }).catch(() => {})
  await log('adminRevoke', { target })
  return { ok: true }
}

async function adminListAdmins() {
  if (__role !== 'admin') return { ok: false, code: 'FORBIDDEN', message: '仅管理员可查看成员' }
  const r = await db.collection(C.ADMIN).where({ enabled: true }).limit(100).get().catch(() => ({ data: [] }))
  return {
    ok: true,
    admins: r.data.map(x => ({ openid: x.openid, createdAt: x.createdAt, grantedBy: x.grantedBy })),
    envAdmins: ADMIN_OPENIDS
  }
}

// 运营 / 高危接口鉴权：只有 admin 角色放行
function requireAdmin() {
  if (__role === 'admin') return null
  return { ok: false, code: 'FORBIDDEN', message: '仅管理员可访问，请联系运营开通权限' }
}

// 当前身份（供前端展示 / 复制 openid 以配置运营白名单）
async function whoAmI() {
  const staff = await db.collection(C.STAFF).where({ openid: openid() }).get().catch(() => ({ data: [] }))
  const cnt = await adminCount()
  const hasAdmin = ADMIN_OPENIDS.length > 0 || cnt > 0
  return {
    ok: true,
    openid: openid(),
    source: __identity.source,
    isTest: __identity.isTest,
    role: __role,
    roleText: __role === 'admin' ? '管理员' : '普通用户',
    isAdmin: __role === 'admin',
    isStaff: staff.data.length > 0 || __role === 'admin',
    hasAdmin,
    // 首位自举入口：尚未配置任何管理员 + 当前是真实微信身份
    canSelfGrant: !hasAdmin && !!__identity.openid && !__identity.isTest,
    appSecretConfigured: !!WX_APPSECRET
  }
}

// ---------- 用户资料（昵称 / 头像）----------
// 微信不提供昵称头像：getUserProfile 已废弃（返回匿名数据），只能由用户主动填写：
//   昵称 → <input type="nickname">；头像 → <button open-type="chooseAvatar">
// 前端把头像重绘压缩成 dataURL 后提交，这里校验格式与体积，一 openid 存一条。
// 头像上限按 base64 字符数控制，留足 HTTP 网关约 96KB 请求体的余量。
const AVATAR_MAX_CHARS = 45 * 1024
const NICK_MAX = 20

// 集合懒创建：profiles 是后加的集合，老环境里不存在；
// 首次写入时补建，结果按进程缓存，避免每次保存都多一次 RPC。
const __ensured = new Set()
let __ensureErr = ''
async function ensureCollection(name) {
  if (__ensured.has(name)) return
  try { await db.createCollection(name) }
  catch (e) { __ensureErr = (e && (e.message || e.errMsg)) || String(e) }
  __ensured.add(name)
}

async function findProfile(oid) {
  const r = await db.collection(C.PROFILE).where({ openid: oid }).limit(1).get().catch(() => ({ data: [] }))
  return (r.data && r.data[0]) || null
}

async function getProfile() {
  const oid = openid()
  const p = await findProfile(oid)
  return {
    ok: true,
    openid: oid,
    nickname: (p && p.nickname) || '',
    avatar: (p && p.avatar) || '',
    role: __role,
    roleText: __role === 'admin' ? '管理员' : '普通用户',
    isAdmin: __role === 'admin',
    source: __identity.source,
    isTest: __identity.isTest,
    loginText: __identity.isTest ? '预览身份' : '微信登录',
    updatedAt: (p && p.updatedAt) || null,
    nickMax: NICK_MAX
  }
}

async function saveProfile(event) {
  const oid = openid()
  if (!oid || oid === 'anonymous') return { ok: false, code: 'NO_LOGIN' }
  const patch = { openid: oid, updatedAt: now() }
  let touched = false

  if (event.nickname !== undefined) {
    // 昵称允许为空（清空后展示占位），超长截断而非报错，避免用户输入被莫名拒绝
    patch.nickname = String(event.nickname || '').trim().slice(0, NICK_MAX)
    touched = true
  }
  if (event.avatar !== undefined) {
    const av = String(event.avatar || '')
    if (av) {
      // 只收 jpeg/png：img_sec_check 不支持 webp，放开 webp 等于留一条绕过内容安全的通道
      if (!/^data:image\/(jpeg|jpg|png);base64,[A-Za-z0-9+/=]+$/.test(av)) {
        return { ok: false, code: 'BAD_AVATAR', message: '头像格式不支持，请重新选择' }
      }
      if (av.length > AVATAR_MAX_CHARS) {
        return { ok: false, code: 'AVATAR_TOO_LARGE', message: '头像压缩后仍然过大，请换一张图片' }
      }
    }
    patch.avatar = av
    touched = true
  }
  if (!touched) return { ok: false, code: 'NOTHING_TO_SAVE', message: '没有需要保存的内容' }

  // 昵称与头像是用户自填内容（UGC），写入前过微信内容安全
  if (patch.nickname) {
    const s = await secCheckText(patch.nickname, oid)
    if (s === 'risky') return { ok: false, code: 'NICK_RISKY', message: '昵称含有违规内容，请换一个' }
  }
  if (patch.avatar) {
    const s = await secCheckImage(patch.avatar, oid)
    if (s === 'risky') return { ok: false, code: 'AVATAR_RISKY', message: '头像未通过内容安全检测，请更换' }
  }

  await ensureCollection(C.PROFILE)
  try {
    await upsert(C.PROFILE, 'profile_' + oid, patch)
  } catch (err) {
    return {
      ok: false, code: 'PROFILE_WRITE_FAIL',
      message: (err && (err.message || err.errMsg)) || '资料写入失败',
      ensureError: __ensureErr
    }
  }
  await log('saveProfile', { hasNickname: !!patch.nickname, hasAvatar: !!patch.avatar })
  return await getProfile()
}

// ---------- 注销账号 ----------
// 规则：交易链路未了结时不允许注销；管理员必须先被移除权限（否则会把自己锁在门外）。
// 注销动作：删资料、删登录态、解绑店员、作废邀请码、订单买家标识去标识化。
// 订单本身（金额/商品/门店/时间）按《电子商务法》要求留存，不做物理删除。
async function deleteAccount() {
  const oid = openid()
  if (!oid || oid === 'anonymous') return { ok: false, code: 'NO_LOGIN' }
  if (__identity.isTest) return { ok: false, code: 'TEST_IDENTITY', message: '预览身份不可注销' }
  // 管理员（含已在白名单里但被停用的）不允许自助注销，否则容易把自己锁在门外
  const adminDoc = await db.collection(C.ADMIN).where({ openid: oid }).count()
    .catch(() => ({ total: 0 }))
  if (__role === 'admin' || adminDoc.total > 0 || ADMIN_OPENIDS.includes(oid)) {
    return {
      ok: false, code: 'ADMIN_CANNOT_DELETE',
      message: '当前账号是管理员，请先由其他管理员在「运营 → 成员管理」中移除权限，再回来注销'
    }
  }

  const [openOrderCnt, invCnt, cmCnt] = await Promise.all([
    db.collection(C.ORDER).where({
      buyer: oid, status: _.in(['pending_pay', 'paid', 'cancel_processing'])
    }).count(),
    db.collection(C.INVITATION).where({ buyer: oid, status: _.in(['accumulating', 'locked']) }).count(),
    db.collection(C.COMMISSION).where({
      buyer: oid, status: _.in(['pending', 'processing', 'exception'])
    }).count()
  ])

  if (openOrderCnt.total > 0) {
    return { ok: false, code: 'HAS_OPEN_ORDER', message: '还有未完成的订单，请先到店核销或办理取消后再注销' }
  }
  if (invCnt.total > 0) {
    return { ok: false, code: 'HAS_OPEN_INVITATION', message: '还有进行中的邀请活动，达标或作废后才能注销' }
  }
  if (cmCnt.total > 0) {
    return { ok: false, code: 'HAS_OPEN_COMMISSION', message: '还有未结清的佣金，请等待处理完成后再注销' }
  }

  const anon = 'deleted_' + crypto.createHash('sha256').update(oid).digest('hex').slice(0, 16)
  const errors = []

  await db.collection(C.PROFILE).doc('profile_' + oid).remove()
    .catch(err => errors.push('profile:' + (err && err.message)))
  await db.collection(C.SESSION).where({ openid: oid }).remove()
    .catch(err => errors.push('session:' + (err && err.message)))
  await db.collection(C.STAFF).where({ openid: oid }).remove()
    .catch(err => errors.push('staff:' + (err && err.message)))

  // 作废邀请码：注销后别人手里的旧码不能再归因到这个（已不存在的）账号
  const invUpd = await db.collection(C.INVITATION).where({ buyer: oid }).update({
    data: { code: null, voidedByDelete: true, updatedAt: now() }
  }).catch(err => { errors.push('invitation:' + (err && err.message)); return { stats: { updated: 0 } } })

  // 订单去标识化：保留交易记录，断开与微信账号的关联
  const orderUpd = await db.collection(C.ORDER).where({ buyer: oid }).update({
    data: { buyer: anon, buyerDeletedAt: now() }
  }).catch(err => { errors.push('order:' + (err && err.message)); return { stats: { updated: 0 } } })

  await log('deleteAccount', {
    orders: (orderUpd.stats && orderUpd.stats.updated) || 0,
    invitations: (invUpd.stats && invUpd.stats.updated) || 0,
    errors
  })

  return {
    ok: true,
    anonymizedOrders: (orderUpd.stats && orderUpd.stats.updated) || 0,
    // profile/session 删除失败时前端仍需清本地登录态，这里如实回报
    partial: errors.length > 0
  }
}

async function log(action, detail) {
  try {
    await db.collection(C.OPLOG).add({
      data: { action, detail, operator: openid(), createdAt: now() }
    })
  } catch (e) { /* 审计失败不阻断主流程 */ }
}

// ---------- 演示数据 ----------
// 确保集合存在（首次部署时数据库为空）
async function ensureCollections() {
  const names = [
    C.ACTIVITY, C.STORE, C.ORDER, C.INVITATION, C.INVITE_RECORD,
    C.COMMISSION, C.LEDGER, C.STAFF, C.OPLOG,
    C.POSTER_CHUNK, C.SESSION, C.ADMIN, C.PROFILE
  ]
  for (const name of names) {
    try {
      await db.createCollection(name)
    } catch (e) {
      // 集合已存在则忽略；其他错误（如数据库未开通）由后续读写暴露
    }
  }
}

async function seed(event, stores = []) {
  await ensureCollections()
  const activityId = 'act_linyou_v1'
  // 防覆盖：默认只在活动不存在时初始化演示数据。
  // force 仅用于自检重置，且必须同时开启 ALLOW_SELF_TEST；否则一律忽略，绝不覆盖线上配置。
  const exist = await db.collection(C.ACTIVITY).doc(activityId).get().catch(() => null)
  const force = !!(event && event.force) && ALLOW_SELF_TEST
  if (exist && exist.data && !force) {
    return {
      ok: true, skipped: true,
      message: '活动已存在，跳过初始化（不会覆盖线上配置）'
    }
  }
  // HTTP 预览身份（前端固定用 preview）与 CLI/e2e 身份都建为演示店员，保证核销/取消可体验
  const activity = {
    _id: activityId,
    brand: '邻友购',
    name: '邻友购 · 洗护狂欢季 买三退一',
    subtitle: '邀请 3 位好友下单，你的订单全额退',
    goodsName: '氨基酸植萃洗发水 500ml',
    spec: '单瓶装',
    priceFen: 12900,           // 129.00 元
    originalPriceFen: 19800,   // 划线价 198.00 元
    poster: '/images/poster.jpg', // 活动海报（小程序本地资源，压缩后 <200K）
    commissionRule: 'buy3refund1', // 买三退一：邀请 3 人达标，返还本人订单一单金额
    inviteTarget: 3,           // 达标人数 N = 3
    ruleVersion: 'shampoo_v1',
    orderDeadline: now() + 30 * 86400000,
    inviteDeadline: now() + 30 * 86400000,
    verifyDeadline: now() + 60 * 86400000,
    status: 'ongoing',
    createdAt: now()
  }
  await upsert(C.ACTIVITY, activityId, activity)

  for (const s of stores) await upsert(C.STORE, s._id, s)

  // 演示店员：覆盖 CLI(openid)、HTTP 预览(preview)、e2e(staff) 三种身份，保证任何入口都能核销/取消
  const staffOpenids = [...new Set([openid(), 'preview', 'test_preview', 'test_staff'])]
  for (const oid of staffOpenids) {
    await upsert(C.STAFF, 'staff_' + oid, {
      _id: 'staff_' + oid,
      openid: oid,
      name: '演示店员',
      storeIds: stores.map(s => s._id),
      createdAt: now()
    })
  }

  await log('seed', { activityId })
  return { ok: true, activity, stores }
}

async function upsert(coll, id, data) {
  const old = await db.collection(coll).doc(id).get().catch(() => null)
  // 文档型数据库禁止更新 _id，更新时必须剔除
  const clean = { ...data }
  delete clean._id
  if (old && old.data) {
    await db.collection(coll).doc(id).update({ data: clean })
  } else {
    await db.collection(coll).add({ data: { _id: id, ...clean } })
  }
}

async function getActivity() {
  const act = await db.collection(C.ACTIVITY).doc('act_linyou_v1').get().catch(() => null)
  // 活动不存在时给出明确 code，便于前端只在「真的没数据」时初始化，
  // 而不是任何一次网络抖动都触发 seed（那会把运营配置覆盖成演示数据）
  if (!act || !act.data) {
    return { ok: false, code: 'NO_ACTIVITY', message: '云端还没有活动配置' }
  }
  const stores = await db.collection(C.STORE).where({ stock: _.gt(0) }).get()
  const a = Object.assign({}, act.data)
  // 海报：有云端 base64 时标记 posterCloud=true，前端用 HTTP 图片接口地址；base64 本身不回传
  a.posterCloud = !!a.posterData
  a.posterVersion = a.posterUpdatedAt || 0
  delete a.posterData
  return { ok: true, activity: a, stores: stores.data }
}

// ---------- 海报：base64 存库 + HTTP 输出二进制 ----------
// 云函数通过 HTTP 访问服务返回图片时，需返回 { statusCode, headers, body, isBase64Encoded }
async function getPosterRaw() {
  const act = await db.collection(C.ACTIVITY).doc('act_linyou_v1').get()
  const data = act.data || {}
  if (!data.posterData) return { statusCode: 404, headers: { 'Content-Type': 'text/plain' }, body: 'no poster', isBase64Encoded: false }
  const raw = String(data.posterData).replace(/^data:image\/\w+;base64,/, '')
  return {
    statusCode: 200,
    headers: { 'Content-Type': data.posterMime || 'image/jpeg', 'Cache-Control': 'public, max-age=600' },
    body: raw,
    isBase64Encoded: true
  }
}

// ---------- 运营配置管理 ----------
const ACTIVITY_ID = 'act_linyou_v1'

// 读取活动 + 全部门店（含库存为 0 的，便于运营维护）
async function adminGetConfig() {
  const act = await db.collection(C.ACTIVITY).doc(ACTIVITY_ID).get()
  const stores = await db.collection(C.STORE).orderBy('createdAt', 'asc').get()
  // 海报数据不回传（太大），只回传 URL 标记与版本（用于破坏图片缓存）
  const a = Object.assign({}, act.data)
  a.posterCloud = !!a.posterData
  a.posterVersion = a.posterUpdatedAt || 0
  delete a.posterData
  return {
    ok: true,
    activity: a,
    stores: stores.data,
    posterUrl: a.poster
  }
}

// 保存活动/商品配置（仅更新白名单字段，金额转分由前端完成）
const ACTIVITY_FIELDS = [
  'brand', 'name', 'subtitle', 'goodsName', 'spec',
  'priceFen', 'originalPriceFen', 'inviteTarget',
  'orderDeadline', 'inviteDeadline', 'verifyDeadline', 'status'
]
const ACTIVITY_TEXT_LIMITS = { brand: 20, name: 40, subtitle: 60, goodsName: 40, spec: 20 }
const ACTIVITY_STATUS = ['ongoing', 'paused', 'ended']
const MAX_FEN = 100000000 // 100 万元，防止误填把金额扩大几个数量级

async function adminSaveActivity(event) {
  const patch = {}
  for (const f of ACTIVITY_FIELDS) {
    if (event[f] !== undefined) patch[f] = event[f]
  }
  if (!Object.keys(patch).length) return { ok: false, code: 'EMPTY_PATCH' }

  // 文本字段：必须为字符串，去首尾空格并限长（避免超长内容撑坏列表与页面）
  for (const [k, max] of Object.entries(ACTIVITY_TEXT_LIMITS)) {
    if (patch[k] === undefined) continue
    if (typeof patch[k] !== 'string') return { ok: false, code: 'BAD_FIELD', field: k }
    patch[k] = patch[k].trim().slice(0, max)
  }

  // 金额必须是整数分。挡住字符串，否则会入库成 "8800"，后续除法直接变 NaN
  for (const k of ['priceFen', 'originalPriceFen']) {
    if (patch[k] === undefined) continue
    if (!Number.isInteger(patch[k]) || patch[k] < 0 || patch[k] > MAX_FEN) {
      return { ok: false, code: 'BAD_PRICE', field: k }
    }
  }

  if (patch.inviteTarget !== undefined) {
    if (!Number.isInteger(patch.inviteTarget) || patch.inviteTarget < 1 || patch.inviteTarget > 100) {
      return { ok: false, code: 'BAD_TARGET', message: '达标人数需为 1~100 的整数' }
    }
  }

  // 时间戳统一为毫秒整数，并限制在 2020 ~ 2100 年之间（挡住 0、字符串、秒级时间戳）
  for (const k of ['orderDeadline', 'inviteDeadline', 'verifyDeadline']) {
    if (patch[k] === undefined) continue
    if (!Number.isFinite(patch[k]) || patch[k] < 1577808000000 || patch[k] > 4102444800000) {
      return { ok: false, code: 'BAD_DEADLINE', field: k }
    }
    patch[k] = Number(patch[k])
  }

  if (patch.status !== undefined && !ACTIVITY_STATUS.includes(patch.status)) {
    return { ok: false, code: 'BAD_STATUS', message: '状态只能是 ongoing / paused / ended' }
  }
  patch.updatedAt = now()
  // 更新时剔除 _id（文档库禁止更新 _id）
  const old = await db.collection(C.ACTIVITY).doc(ACTIVITY_ID).get().catch(() => null)
  if (old && old.data) {
    await db.collection(C.ACTIVITY).doc(ACTIVITY_ID).update({ data: patch })
  } else {
    await db.collection(C.ACTIVITY).add({ data: Object.assign({ _id: ACTIVITY_ID }, patch) })
  }
  await log('adminSaveActivity', { fields: Object.keys(patch) })
  return await adminGetConfig()
}

// 保存海报：base64 存数据库，poster 指向 HTTP 图片接口
async function adminSavePoster(event) {
  let data = String(event.imageBase64 || '')
  if (!data) return { ok: false, code: 'NO_IMAGE' }
  const mime = String(event.mime || 'image/jpeg')
  if (!/^data:image\//.test(data) && !/^\/?9j\//.test(data) && !/^iVBOR/.test(data)) {
    // 允许纯 base64（JPEG/PNG 魔数）或 data URL
    return { ok: false, code: 'BAD_IMAGE' }
  }
  // 体积保护：base64 超过 2MB 拒绝
  if (data.length > 2 * 1024 * 1024) return { ok: false, code: 'IMAGE_TOO_LARGE' }
  const patch = {
    posterData: data,
    posterMime: mime,
    // HTTP 图片接口地址：前端据此显示，无需云存储永久 URL
    poster: (event.posterUrl || '') || null,
    posterUpdatedAt: now()
  }
  const old = await db.collection(C.ACTIVITY).doc(ACTIVITY_ID).get().catch(() => null)
  if (old && old.data) {
    await db.collection(C.ACTIVITY).doc(ACTIVITY_ID).update({ data: patch })
  } else {
    await db.collection(C.ACTIVITY).add({ data: Object.assign({ _id: ACTIVITY_ID }, patch) })
  }
  await log('adminSavePoster', { mime, size: data.length })
  return { ok: true, posterUrl: patch.poster }
}

// 重设海报为内置默认图（清空 posterData，poster 回退本地路径）
async function adminResetPoster() {
  await db.collection(C.ACTIVITY).doc(ACTIVITY_ID).update({
    data: { posterData: null, poster: '/images/poster.jpg', posterUpdatedAt: now() }
  })
  await log('adminResetPoster', {})
  return { ok: true, posterUrl: '/images/poster.jpg' }
}

// ---------- 海报分片上传（绕开 HTTP 网关 ~96KB payload 上限）----------
// 前端把 base64 切片，逐片 POST；云函数按 index 存入临时集合，最后由 merge 合并写库。
const CHUNK_COLL = C.POSTER_CHUNK

// 开始一次上传：清理该 uploadId 的旧分片
async function adminPosterInit(event) {
  const uploadId = String(event.uploadId || '')
  if (!uploadId) return { ok: false, code: 'NO_UPLOAD_ID' }
  try { await db.createCollection(CHUNK_COLL) } catch (e) {}
  const old = await db.collection(CHUNK_COLL).where({ uploadId: uploadId }).limit(100).get().catch(() => ({ data: [] }))
  for (const d of (old.data || [])) {
    await db.collection(CHUNK_COLL).doc(d._id).remove().catch(() => {})
  }
  return { ok: true }
}

// 接收单片：{ uploadId, index, total, data }
async function adminPosterChunk(event) {
  const uploadId = String(event.uploadId || '')
  const index = Number(event.index)
  const total = Number(event.total)
  const data = String(event.data || '')
  if (!uploadId || !Number.isInteger(index) || index < 0 || !Number.isInteger(total) || total < 1) {
    return { ok: false, code: 'BAD_CHUNK_META' }
  }
  if (!data) return { ok: false, code: 'EMPTY_CHUNK' }
  // 单片不得超过 HTTP 网关承载范围（约 96KB），总片数也要有上界，避免被灌数据
  if (data.length > 100 * 1024) return { ok: false, code: 'CHUNK_TOO_LARGE', message: '单片数据过大' }
  if (total > 100) return { ok: false, code: 'TOO_MANY_CHUNKS', message: '分片数量过多' }
  const docId = uploadId + '_' + String(index).padStart(4, '0')
  const payload = { uploadId, index, total, data, updatedAt: now() }
  const old = await db.collection(CHUNK_COLL).doc(docId).get().catch(() => null)
  if (old && old.data) {
    await db.collection(CHUNK_COLL).doc(docId).update({ data: payload })
  } else {
    await db.collection(CHUNK_COLL).add({ data: Object.assign({ _id: docId }, payload) })
  }
  return { ok: true, index }
}

// 合并所有分片：按 index 排序拼接 base64，写入活动文档，删除临时分片
async function adminPosterMerge(event) {
  const uploadId = String(event.uploadId || '')
  const mime = String(event.mime || 'image/jpeg')
  const total = Number(event.total) || 0
  if (!uploadId) return { ok: false, code: 'NO_UPLOAD_ID' }
  const res = await db.collection(CHUNK_COLL).where({ uploadId: uploadId }).orderBy('index', 'asc').limit(200).get()
  const items = res.data || []
  if (!items.length) return { ok: false, code: 'NO_CHUNKS' }
  // 片数必须与声明一致，否则拼接出的是残缺图片（前端会看到一张坏图而不是报错）
  if (total && items.length !== total) {
    return { ok: false, code: 'CHUNKS_INCOMPLETE', received: items.length, total }
  }
  const fullBase64 = items.map(x => x.data).join('')
  const dataUrl = 'data:' + mime + ';base64,' + fullBase64
  // 体积保护：解码后超过 2MB 拒绝
  if (dataUrl.length > 2 * 1024 * 1024) return { ok: false, code: 'IMAGE_TOO_LARGE' }
  const patch = {
    posterData: dataUrl,
    posterMime: mime,
    poster: (event.posterUrl || '') || null,
    posterUpdatedAt: now()
  }
  const old = await db.collection(C.ACTIVITY).doc(ACTIVITY_ID).get().catch(() => null)
  if (old && old.data) {
    await db.collection(C.ACTIVITY).doc(ACTIVITY_ID).update({ data: patch })
  } else {
    await db.collection(C.ACTIVITY).add({ data: Object.assign({ _id: ACTIVITY_ID }, patch) })
  }
  for (const d of items) {
    await db.collection(CHUNK_COLL).doc(d._id).remove().catch(() => {})
  }
  await log('adminPosterMerge', { mime, size: dataUrl.length, chunks: items.length })
  return { ok: true, posterUrl: patch.poster, size: dataUrl.length }
}

// 新增/更新门店
async function adminSaveStore(event) {
  const id = event.id || ('store_' + Date.now())
  const fields = ['name', 'address', 'hours', 'phone', 'stock']
  const patch = {}
  for (const f of fields) if (event[f] !== undefined) patch[f] = event[f]
  if (!patch.name) return { ok: false, code: 'NO_NAME' }
  if (patch.stock !== undefined && (!Number.isInteger(patch.stock) || patch.stock < 0)) {
    return { ok: false, code: 'BAD_STOCK' }
  }
  const old = await db.collection(C.STORE).doc(id).get().catch(() => null)
  const existing = old && old.data
  const hasLocation = ['locationName', 'mapAddress', 'addressDetail', 'latitude', 'longitude']
    .some(field => event[field] !== undefined)
  if (hasLocation) {
    const { latitude, longitude } = event
    const mapAddress = typeof event.mapAddress === 'string' ? event.mapAddress.trim() : ''
    if (!mapAddress || !Number.isFinite(latitude) || Math.abs(latitude) > 90 ||
        !Number.isFinite(longitude) || Math.abs(longitude) > 180) {
      return { ok: false, code: 'BAD_STORE_LOCATION' }
    }
    const locationName = typeof event.locationName === 'string' ? event.locationName.trim() : ''
    const addressDetail = typeof event.addressDetail === 'string' ? event.addressDetail.trim() : ''
    const address = [mapAddress, addressDetail].filter(Boolean).join(' ')
    Object.assign(patch, { locationName, mapAddress, addressDetail, address, latitude, longitude })
  } else if (!existing || (event.address !== undefined && event.address !== existing.address)) {
    return { ok: false, code: 'BAD_STORE_LOCATION' }
  }
  if (existing) {
    await db.collection(C.STORE).doc(id).update({ data: patch })
  } else {
    await db.collection(C.STORE).add({ data: Object.assign({ _id: id, createdAt: now() }, patch) })
  }
  await log('adminSaveStore', { id, name: patch.name })
  return { ok: true, id }
}

// 删除门店
async function adminDeleteStore(event) {
  const id = event.id
  if (!id) return { ok: false, code: 'NO_ID' }
  // 有订单关联则不允许删除，避免历史订单门店丢失
  const orders = await db.collection(C.ORDER).where({ storeId: id }).count()
  if (orders.total > 0) return { ok: false, code: 'STORE_IN_USE', count: orders.total }
  await db.collection(C.STORE).doc(id).remove()
  await log('adminDeleteStore', { id })
  return { ok: true }
}

// ---------- 下单 ----------
// 首版：每个小程序账号每场活动最多一笔有效订单；未支付关单释放资格
async function createOrder(event) {
  const { storeId, inviteCode } = event
  const oid = openid()
  const act = await db.collection(C.ACTIVITY).doc('act_linyou_v1').get().catch(() => null)
  if (!act || !act.data) return { ok: false, code: 'NO_ACTIVITY', message: '活动还没有配置' }

  if (act.data.status !== 'ongoing') return { ok: false, code: 'ACTIVITY_ENDED' }
  if (now() > act.data.orderDeadline) return { ok: false, code: 'ORDER_DEADLINE_PASSED' }

  // 查找是否有进行中/已支付订单，占用下单资格
  const existed = await db.collection(C.ORDER).where({
    buyer: oid, activityId: act.data._id, status: _.in(['pending_pay', 'paid', 'verified', 'cancel_processing'])
  }).get()
  if (existed.data.length > 0) return { ok: false, code: 'ALREADY_ORDERED', orderId: existed.data[0]._id }

  // 校验邀请码（不允许自邀；邀请已作废或过期的码不再计入）
  let inviterId = null
  if (inviteCode) {
    const inv = await db.collection(C.INVITATION).where({ code: String(inviteCode).toUpperCase() }).get()
    if (inv.data.length === 0) return { ok: false, code: 'INVALID_INVITE_CODE' }
    const invitation = inv.data[0]
    if (invitation.buyer === oid) return { ok: false, code: 'SELF_INVITE' }
    if (invitation.activityId !== act.data._id) return { ok: false, code: 'INVITE_ACTIVITY_MISMATCH' }
    if (invitation.status !== 'accumulating') {
      return { ok: false, code: 'INVITE_CLOSED', message: '该邀请已结束，无法再计入' }
    }
    // 邀请有效期以邀请人下单时的快照为准，避免运营改配置改变已生效的规则
    const invDeadline = invitation.deadlineSnapshot || act.data.inviteDeadline
    if (invDeadline && now() > invDeadline) {
      return { ok: false, code: 'INVITE_DEADLINE_PASSED', message: '该邀请已过截止时间' }
    }
    inviterId = invitation._id
  }

  const store = await db.collection(C.STORE).doc(storeId).get().catch(() => null)
  if (!store || !store.data) return { ok: false, code: 'STORE_NOT_FOUND' }
  if (store.data.stock <= 0) return { ok: false, code: 'OUT_OF_STOCK' }

  // 订单号：时间戳 + 加密随机串，避免同毫秒并发碰撞（原实现用 Math.random 有概率重复）
  const orderId = 'O' + now() + crypto.randomBytes(4).toString('hex')
  const order = {
    _id: orderId,
    orderNo: 'LN' + now() + crypto.randomBytes(3).toString('hex').toUpperCase(),
    buyer: oid,
    activityId: act.data._id,
    ruleVersion: act.data.ruleVersion,
    // 规则快照：达标人数 / 邀请截止 / 价格都以下单时刻为准。
    // 运营之后调整活动配置，不会改变已下单用户的达标条件与退款金额。
    inviteTargetSnapshot: act.data.inviteTarget,
    inviteDeadlineSnapshot: act.data.inviteDeadline,
    priceFenSnapshot: act.data.priceFen,
    goodsName: act.data.goodsName,
    spec: act.data.spec,
    amountFen: act.data.priceFen,
    storeId,
    storeName: store.data.name,
    inviterInvitationId: inviterId,   // 归因，支付前锁定
    status: 'pending_pay',
    verifyCode: null,
    paidAt: null,
    verifiedAt: null,
    createdAt: now()
  }
  await db.collection(C.ORDER).add({ data: order })
  await log('createOrder', { orderId, inviterInvitationId: inviterId })
  return { ok: true, order }
}

// ---------- 支付成功落库（演示支付与微信支付回调共用）----------
// 关键顺序：先原子占库存（带 stock>0 条件），再 CAS 订单状态。
// 任何一步失败都不会留下「已付款但超卖」或「扣了库存但订单没变成已支付」的脏数据。
// 入参不带 openid：真实回调里没有登录态，买家以订单里记录的 buyer 为准。
async function settlePaidOrder(orderId, opts) {
  const { transactionId = null, source = 'mock' } = opts || {}
  const cur = await db.collection(C.ORDER).doc(orderId).get().catch(() => null)
  if (!cur || !cur.data) return { ok: false, code: 'NOT_FOUND' }
  const order0 = cur.data
  if (order0.status !== 'pending_pay') {
    return { ok: false, code: 'PAY_ALREADY_PROCESSED', status: order0.status }
  }

  // 1) 原子占库存：where 里带 stock > 0，并发下只有一个请求能扣成功，杜绝超卖
  const stockRes = await db.collection(C.STORE)
    .where({ _id: order0.storeId, stock: _.gt(0) })
    .update({ data: { stock: _.inc(-1) } })
    .catch(() => ({ stats: { updated: 0 } }))
  if (!stockRes.stats || stockRes.stats.updated === 0) {
    return { ok: false, code: 'OUT_OF_STOCK', message: '该门店已售罄，请换一家门店下单' }
  }

  // 2) CAS：只有 pending_pay -> paid 的第一次调用成功，保证回调重试幂等
  const payRes = await db.collection(C.ORDER).where({ _id: orderId, status: 'pending_pay' }).update({
    data: { status: 'paid', paidAt: now(), transactionId, paidSource: source }
  })
  if (!payRes.stats || payRes.stats.updated === 0) {
    // 并发下已被别的请求处理：把刚占用的库存还回去，避免凭空少一件
    await db.collection(C.STORE).doc(order0.storeId).update({ data: { stock: _.inc(1) } }).catch(() => {})
    const latest = await db.collection(C.ORDER).doc(orderId).get().catch(() => null)
    return { ok: false, code: 'PAY_ALREADY_PROCESSED', status: latest && latest.data ? latest.data.status : null }
  }

  const order = (await db.collection(C.ORDER).doc(orderId).get()).data

  // 3) 为原订单生成邀请记录（邀请码 + 带参链接）。
  //    达标人数与邀请截止在此时刻快照，后续运营改配置不影响已下单的用户。
  const invitationId = 'INV_' + orderId
  const invitation = {
    _id: invitationId,
    code: genInviteCode(),
    orderId,
    buyer: order.buyer,
    activityId: order.activityId,
    status: 'accumulating',   // accumulating -> locked / void
    validCount: 0,
    target: null,
    // 规则快照：优先使用下单时写入订单的值
    targetSnapshot: order.inviteTargetSnapshot || null,
    deadlineSnapshot: order.inviteDeadlineSnapshot || null,
    createdAt: now()
  }
  // 回调可能因超时重推：_id 固定，重复写入直接忽略，不阻断主流程
  await db.collection(C.INVITATION).add({ data: invitation }).catch(() => {})

  // 4) 若该单有归因，记录有效邀请关系（按受邀账号去重）
  if (order.inviterInvitationId) {
    await addInviteRecord(order.inviterInvitationId, order.buyer, orderId)
  }

  const saved = await db.collection(C.INVITATION).doc(invitationId).get().catch(() => null)
  return { ok: true, order, invitationId, code: (saved && saved.data && saved.data.code) || invitation.code }
}

// ---------- 演示支付（未接真实支付时使用）----------
async function mockPay(event) {
  if (!MOCK_PAY_ENABLED) {
    return { ok: false, code: 'MOCK_PAY_DISABLED', message: '演示支付已关闭，等待接入微信支付' }
  }
  const { orderId } = event
  const oid = openid()
  if (!orderId) return { ok: false, code: 'BAD_ORDER' }

  const cur = await db.collection(C.ORDER).doc(orderId).get().catch(() => null)
  if (!cur || !cur.data) return { ok: false, code: 'NOT_FOUND' }
  if (cur.data.buyer !== oid) return { ok: false, code: 'FORBIDDEN' }
  if (cur.data.status !== 'pending_pay') {
    return { ok: false, code: 'PAY_ALREADY_PROCESSED', status: cur.data.status }
  }

  const r = await settlePaidOrder(orderId, { transactionId: 'MOCK_' + orderId, source: 'mock' })
  if (r.ok) await log('mockPay', { orderId, invitationId: r.invitationId })
  return r
}

// ---------- 真实微信支付：下单取 prepay_id ----------
// 前端拿到 payParams 后调 wx.requestPayment，支付结果由微信异步回调 confirmPaid 落库，
// 绝不能靠前端「支付成功」的回调直接改订单状态——那是可以被伪造的。
async function prepay(event) {
  const oid = openid()
  const { orderId } = event
  if (!orderId) return { ok: false, code: 'BAD_ORDER' }
  if (!wxpay.isConfigured()) {
    return {
      ok: false, code: 'PAY_NOT_CONFIGURED',
      message: '微信支付参数未配置完整，缺少：' + wxpay.missing().join(', ')
    }
  }

  const doc = await db.collection(C.ORDER).doc(orderId).get().catch(() => null)
  if (!doc || !doc.data) return { ok: false, code: 'NOT_FOUND' }
  const o = doc.data
  if (o.buyer !== oid) return { ok: false, code: 'FORBIDDEN' }
  if (o.status !== 'pending_pay') {
    return { ok: false, code: 'PAY_ALREADY_PROCESSED', status: o.status }
  }

  try {
    const prepayId = await wxpay.jsapiPrepay({
      openid: oid,
      outTradeNo: o.orderNo,
      amountFen: o.amountFen,
      description: (o.goodsName || '门店商品') + (o.spec ? ' ' + o.spec : ''),
      attach: o._id
    })
    // 记下商户订单号：退款时必须用它，且必须与下单时完全一致
    await db.collection(C.ORDER).doc(orderId).update({
      data: { outTradeNo: o.orderNo, prepayAt: now() }
    }).catch(() => {})
    await log('prepay', { orderId, outTradeNo: o.orderNo })
    return { ok: true, payParams: wxpay.buildPayParams(prepayId), outTradeNo: o.orderNo }
  } catch (e) {
    await log('prepay_fail', { orderId, code: e.code || '', message: e.message })
    return { ok: false, code: e.code || 'WXPAY_ERROR', message: e.message }
  }
}

// ---------- 主动查单：回调丢失时的兜底 ----------
// 微信回调可能因为函数超时/网络抖动没送达，用户实际已付款但订单还是待支付。
// 前端在 requestPayment 返回后调用一次，比等用户投诉可靠得多。
async function payQuery(event) {
  const oid = openid()
  const { orderId } = event
  if (!orderId) return { ok: false, code: 'BAD_ORDER' }
  const doc = await db.collection(C.ORDER).doc(orderId).get().catch(() => null)
  if (!doc || !doc.data) return { ok: false, code: 'NOT_FOUND' }
  const o = doc.data
  if (o.buyer !== oid) return { ok: false, code: 'FORBIDDEN' }
  if (o.status !== 'pending_pay') return { ok: true, paid: true, status: o.status }
  if (!wxpay.isConfigured()) return { ok: false, code: 'PAY_NOT_CONFIGURED' }

  try {
    const r = await wxpay.queryOrder(o.orderNo)
    if (r.trade_state === 'SUCCESS') {
      const s = await settlePaidOrder(orderId, { transactionId: r.transaction_id, source: 'wxpay_query' })
      return { ok: true, paid: true, status: 'paid', settled: s.ok, invitationId: s.invitationId, code: s.code }
    }
    return { ok: true, paid: false, tradeState: r.trade_state }
  } catch (e) {
    return { ok: false, code: e.code || 'WXPAY_ERROR', message: e.message }
  }
}

// ---------- 支付结果回调（微信 -> 云函数）----------
// 必须在解析 body 之前拿到「原始报文字节」，否则签名对不上。
// 返回值约定：处理成功回 {code:'SUCCESS'}；失败回 {code:'FAIL'} 让微信重试。
async function handlePayNotify(headers, rawBody) {
  const v = wxpay.verifyNotify(headers, rawBody)
  if (!v.ok) {
    await log('payNotify_verify_fail', v)
    return { code: 'FAIL', message: 'signature verify failed' }
  }
  let body = null
  try { body = JSON.parse(rawBody) } catch (e) {
    return { code: 'FAIL', message: 'bad body' }
  }
  // 只处理支付成功事件，其他事件（如退款通知）直接确认，避免微信无意义重试
  if (body.event_type && body.event_type !== 'TRANSACTION.SUCCESS') {
    return { code: 'SUCCESS', message: 'ignored' }
  }
  let data = null
  try { data = wxpay.decryptResource(body.resource) } catch (e) {
    await log('payNotify_decrypt_fail', { message: e.message })
    return { code: 'FAIL', message: 'decrypt failed' }
  }
  if (!data || data.trade_state !== 'SUCCESS') {
    return { code: 'SUCCESS', message: 'not success' }
  }

  const orderNo = data.out_trade_no
  const found = await db.collection(C.ORDER).where({ orderNo }).limit(1).get().catch(() => ({ data: [] }))
  if (!found.data.length) {
    await log('payNotify_order_missing', { orderNo })
    return { code: 'FAIL', message: 'order not found' }
  }
  const order = found.data[0]

  // 金额校验：验签已能防伪造，但这层几乎零成本，能挡住「金额被改小」这类事故
  const paidFen = data.amount && data.amount.total
  if (Number(paidFen) !== Number(order.amountFen)) {
    await log('payNotify_amount_mismatch', { orderId: order._id, paidFen, expectFen: order.amountFen })
    return { code: 'FAIL', message: 'amount mismatch' }
  }
  // 商户号也要对：防止别的商户号的回调串进来（同一套回调地址复用时才会发生）
  if (wxpay.MCH_ID && data.mchid && data.mchid !== wxpay.MCH_ID) {
    await log('payNotify_mch_mismatch', { orderId: order._id, mchid: data.mchid })
    return { code: 'FAIL', message: 'mchid mismatch' }
  }

  const r = await settlePaidOrder(order._id, { transactionId: data.transaction_id, source: 'wxpay' })
  await log('payNotify', { orderId: order._id, ok: r.ok, code: r.code || '', transactionId: data.transaction_id })
  // 已经处理过（回调重推）同样回 SUCCESS，否则微信会一直重试
  return { code: 'SUCCESS', message: '成功' }
}

function genInviteCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let s = ''
  for (let i = 0; i < 8; i++) s += chars[Math.floor(Math.random() * chars.length)]
  return s
}

// 统计并重算邀请达标 -> 在事务内锁定资格并创建佣金单
async function addInviteRecord(invitationId, invitee, orderId) {
  // 邀请已作废后不再接受新的受邀记录，避免被取消订单的用户继续积累收益
  const invDoc = await db.collection(C.INVITATION).doc(invitationId).get().catch(() => null)
  const inv = invDoc && invDoc.data
  if (!inv) return { ok: false, code: 'INVITATION_NOT_FOUND' }
  if (inv.status === 'void') return { ok: false, code: 'INVITATION_VOID' }

  // 确定性 _id 保证同一邀请人下同一受邀账号只记一次
  const recId = 'IR_' + invitationId + '_' + invitee
  try {
    await db.collection(C.INVITE_RECORD).add({
      data: { _id: recId, invitationId, invitee, orderId, status: 'valid', createdAt: now() }
    })
  } catch (e) {
    return { dedup: true } // 重复受邀
  }
  await recomputeInvitation(invitationId)
  return { dedup: false }
}

// 重算邀请进度。允许 accumulating 与 locked 两种状态进入：
// - accumulating 且满足条件 → 锁定并生成佣金单
// - locked 但有效人数回落（受邀人取消）或原订单失效 → 未出款则回退作废，已出款只标记差额
// 达标人数优先取「下单时快照」，运营后改活动配置不会影响已存在的订单。
async function targetOf(inv, order, act) {
  return Number(
    inv.targetSnapshot ||
    (order && order.inviteTargetSnapshot) ||
    (act && act.inviteTarget) ||
    3
  )
}

async function recomputeInvitation(invitationId) {
  const invDoc = await db.collection(C.INVITATION).doc(invitationId).get().catch(() => null)
  const inv = invDoc && invDoc.data
  if (!inv) return
  if (inv.status !== 'accumulating' && inv.status !== 'locked') return

  const orderDoc = await db.collection(C.ORDER).doc(inv.orderId).get().catch(() => null)
  const originalOrder = orderDoc && orderDoc.data
  if (!originalOrder) return
  // 原订单只有「已支付 / 已核销」才算有效来源；待支付或已取消的订单不再产生佣金
  const orderAlive = ['paid', 'verified'].includes(originalOrder.status)

  const actDoc = await db.collection(C.ACTIVITY).doc(inv.activityId).get().catch(() => null)
  const act = (actDoc && actDoc.data) || {}
  const target = await targetOf(inv, originalOrder, act)

  const valid = await db.collection(C.INVITE_RECORD).where({ invitationId, status: 'valid' }).count()
  await db.collection(C.INVITATION).doc(invitationId).update({ data: { validCount: valid.total } }).catch(() => {})

  // 已锁定：判断是否需要回退（这是「取消订单后重复退款」的关键拦截点）
  if (inv.status === 'locked') {
    if (orderAlive && valid.total >= target) return
    const cm = await db.collection(C.COMMISSION).where({ invitationId }).get().catch(() => ({ data: [] }))
    const commission = cm.data[0]
    if (commission && commission.status === 'paid') {
      // 钱已到用户账上，无法自动追回：保留锁定，标记差额供运营人工处理
      await db.collection(C.INVITATION).doc(invitationId).update({
        data: { shortfall: true, shortfallAt: now(), shortfallCount: valid.total }
      }).catch(() => {})
      await log('invitation_shortfall', {
        invitationId, validCount: valid.total, target,
        reason: orderAlive ? 'invitee_cancelled' : 'order_cancelled'
      })
    } else {
      // 尚未出款：回退到累计中，作废在途佣金与资金占用
      await db.collection(C.INVITATION).doc(invitationId).update({
        data: { status: 'accumulating', target: null, revertedAt: now(), shortfall: false }
      }).catch(() => {})
      if (commission) {
        await db.collection(C.COMMISSION).doc(commission._id)
          .update({ data: { status: 'void', voidAt: now(), voidReason: orderAlive ? 'invitee_cancelled' : 'order_cancelled' } })
          .catch(() => {})
      }
      await db.collection(C.LEDGER).doc('LG_COMM_' + inv.orderId)
        .update({ data: { status: 'void', voidAt: now() } })
        .catch(() => {})
      await log('commission_void', { invitationId, orderId: inv.orderId })
    }
    return
  }

  // 累计中：原订单失效或人数不足，直接结束
  if (!orderAlive) return
  if (valid.total < target) return

  // 事务内：二次校验 + CAS 锁定，避免并发重复发佣
  try {
    await db.runTransaction(async tx => {
      const fresh = (await tx.collection(C.INVITATION).doc(invitationId).get()).data
      if (!fresh || fresh.status !== 'accumulating') return
      const freshOrder = (await tx.collection(C.ORDER).doc(fresh.orderId).get()).data
      if (!freshOrder || !['paid', 'verified'].includes(freshOrder.status)) return
      const cnt = await tx.collection(C.INVITE_RECORD).where({ invitationId, status: 'valid' }).count()
      if (cnt.total < target) return

      // 锁定资格
      await tx.collection(C.INVITATION).doc(invitationId).update({
        data: { status: 'locked', validCount: cnt.total, target, lockedAt: now(), shortfall: false }
      })

      // 唯一佣金单：_id 绑定原订单，保证每单一次
      const commissionId = 'CM_' + fresh.orderId
      const amount = Number(freshOrder.priceFenSnapshot || freshOrder.amountFen || 0)
      const exist = await tx.collection(C.COMMISSION).doc(commissionId).get().catch(() => null)
      if (!exist || !exist.data) {
        await tx.collection(C.COMMISSION).add({
          data: {
            _id: commissionId,
            orderId: fresh.orderId,
            invitationId,
            buyer: fresh.buyer,
            amountFen: amount,
            status: 'pending',        // pending -> processing -> paid / exception / void
            refundNo: 'RF' + fresh.orderId, // 固定商户退款单号，重试沿用
            channelStatus: null,
            createdAt: now()
          }
        })
        // 资金占用：在途金额
        const led = await tx.collection(C.LEDGER).doc('LG_COMM_' + fresh.orderId).get().catch(() => null)
        if (!led || !led.data) {
          await tx.collection(C.LEDGER).add({
            data: {
              _id: 'LG_COMM_' + fresh.orderId,
              orderId: fresh.orderId,
              type: 'commission',
              amountFen: amount,
              status: 'in_flight',
              refundNo: 'RF' + fresh.orderId,
              createdAt: now()
            }
          })
        }
      }
    })
    await log('commission_locked', { invitationId, orderId: inv.orderId })
  } catch (e) {
    // 事务冲突：降级重试一次（回调场景可再入）
    await recomputeInvitationOnce(invitationId)
  }
}

async function recomputeInvitationOnce(invitationId) {
  const invDoc = await db.collection(C.INVITATION).doc(invitationId).get().catch(() => null)
  const inv = invDoc && invDoc.data
  if (!inv || inv.status !== 'accumulating') return
  const orderDoc = await db.collection(C.ORDER).doc(inv.orderId).get().catch(() => null)
  const order = orderDoc && orderDoc.data
  if (!order || !['paid', 'verified'].includes(order.status)) return
  const actDoc = await db.collection(C.ACTIVITY).doc(inv.activityId).get().catch(() => null)
  const act = (actDoc && actDoc.data) || {}
  const target = await targetOf(inv, order, act)
  const cnt = await db.collection(C.INVITE_RECORD).where({ invitationId, status: 'valid' }).count()
  if (cnt.total < target) return
  const updated = await db.collection(C.INVITATION).where({ _id: invitationId, status: 'accumulating' }).update({
    data: { status: 'locked', validCount: cnt.total, target, lockedAt: now() }
  })
  if (!updated.stats || updated.stats.updated !== 1) return
  const amount = Number(order.priceFenSnapshot || order.amountFen || 0)
  // 与事务路径保持一致：佣金单与资金占用必须同时落库，否则退款时找不到流水
  await db.collection(C.COMMISSION).add({
    data: {
      _id: 'CM_' + inv.orderId, orderId: inv.orderId, invitationId,
      buyer: inv.buyer, amountFen: amount, status: 'pending',
      refundNo: 'RF' + inv.orderId, channelStatus: null, createdAt: now()
    }
  }).catch(() => {})
  await db.collection(C.LEDGER).add({
    data: {
      _id: 'LG_COMM_' + inv.orderId, orderId: inv.orderId, type: 'commission',
      amountFen: amount, status: 'in_flight', refundNo: 'RF' + inv.orderId, createdAt: now()
    }
  }).catch(() => {})
}

// ---------- 退款渠道结果（mock，替换点 2）----------
async function mockRefund(event) {
  if (!MOCK_PAY_ENABLED) {
    return {
      ok: false, code: 'MOCK_PAY_DISABLED',
      message: '演示退款已关闭，请在运营端「退款处理」标记线下退款'
    }
  }
  const { commissionId, result } = event // result: 'success' | 'fail'
  if (!commissionId) return { ok: false, code: 'BAD_COMMISSION' }
  const success = result !== 'fail'

  // 条件更新：只有仍在途/异常的佣金能被改写，并发重复回调只有一个能成功，杜绝重复出款
  const r = await db.collection(C.COMMISSION)
    .where({ _id: commissionId, status: _.in(['pending', 'processing', 'exception']) })
    .update({
      data: {
        status: success ? 'paid' : 'exception',
        channelStatus: success ? 'REFUND_SUCCESS' : 'REFUND_FAIL',
        paidAt: success ? now() : null
      }
    })
    .catch(() => ({ stats: { updated: 0 } }))
  if (!r.stats || r.stats.updated === 0) {
    const cur = await db.collection(C.COMMISSION).doc(commissionId).get().catch(() => null)
    if (!cur || !cur.data) return { ok: false, code: 'NOT_FOUND' }
    if (cur.data.status === 'paid') return { ok: true, already: true, status: 'paid' } // 幂等
    if (cur.data.status === 'void') {
      return { ok: false, code: 'COMMISSION_VOID', message: '该佣金已作废（订单已取消）' }
    }
    return { ok: false, code: 'CONFLICT', status: cur.data.status }
  }

  const cm = (await db.collection(C.COMMISSION).doc(commissionId).get()).data
  await settleLedger(cm.orderId, success ? 'paid_out' : 'exception', success ? 'REFUND_SUCCESS' : 'REFUND_FAIL')
  await log('mockRefund', { commissionId, result })
  return { ok: true, status: success ? 'paid' : 'exception' }
}

// 资金流水结算：以 LG_COMM_<orderId> 为确定性 _id，缺失时补建，保证「有佣金必有流水」
async function settleLedger(orderId, status, channelStatus) {
  const id = 'LG_COMM_' + orderId
  const doc = await db.collection(C.LEDGER).doc(id).get().catch(() => null)
  if (doc && doc.data) {
    await db.collection(C.LEDGER).doc(id).update({ data: { status, channelStatus } }).catch(() => {})
    return
  }
  const cm = await db.collection(C.COMMISSION).where({ orderId }).limit(1).get().catch(() => ({ data: [] }))
  await db.collection(C.LEDGER).add({
    data: {
      _id: id, orderId, type: 'commission',
      amountFen: cm.data[0] ? cm.data[0].amountFen : 0,
      status, channelStatus, createdAt: now()
    }
  }).catch(() => {})
}

// ---------- 运营端退款处理 ----------
// 不调用支付渠道，只解决「谁该退、退没退」：未接入真实退款时，运营在此核对并标记线下退款。
function shortId(id) {
  const s = String(id || '')
  if (s.length <= 10) return s
  return s.slice(0, 4) + '****' + s.slice(-4)
}

async function adminCommissions(event) {
  const status = String(event.status || 'open')
  const limit = Math.min(Math.max(Number(event.limit) || 50, 1), 100)
  let q = db.collection(C.COMMISSION)
  if (status === 'open') q = q.where({ status: _.in(['pending', 'processing', 'exception']) })
  else if (status !== 'all') q = q.where({ status })
  const list = await q.orderBy('createdAt', 'desc').limit(limit).get().catch(() => ({ data: [] }))

  const rows = []
  for (const c of list.data) {
    const od = await db.collection(C.ORDER).doc(c.orderId).get().catch(() => null)
    const o = od && od.data
    rows.push({
      commissionId: c._id,
      orderId: c.orderId,
      orderNo: (o && o.orderNo) || '',
      buyerShort: shortId(c.buyer),
      amountFen: c.amountFen,
      status: c.status,
      refundNo: c.refundNo || '',
      refundId: c.refundId || '',
      channelStatus: c.channelStatus || '',
      storeName: (o && o.storeName) || '',
      createdAt: c.createdAt,
      paidAt: c.paidAt || null,
      voidReason: c.voidReason || ''
    })
  }
  const totalAmountFen = rows.filter(r => r.status !== 'void').reduce((s, r) => s + (r.amountFen || 0), 0)
  return { ok: true, commissions: rows, totalAmountFen, status }
}

// 标记线下已退款（转账/现金/其他渠道）。仍走条件更新，避免与渠道回调互相覆盖。
async function adminMarkRefund(event) {
  const commissionId = String(event.commissionId || '')
  if (!commissionId) return { ok: false, code: 'BAD_COMMISSION' }
  const note = String(event.note || '').slice(0, 100)

  // 渠道退款一旦发起，禁止再被标记线下已付，否则同一笔钱会被支付两次
  const pre = await db.collection(C.COMMISSION).doc(commissionId).get().catch(() => null)
  if (pre && pre.data && pre.data.refundId) {
    return {
      ok: false, code: 'CHANNEL_REFUND_EXISTS',
      message: '该笔已发起微信退款，不能重复标记线下退款，请改用「同步状态」'
    }
  }

  const r = await db.collection(C.COMMISSION)
    .where({ _id: commissionId, status: _.in(['pending', 'processing', 'exception']) })
    .update({
      data: {
        status: 'paid', channelStatus: 'OFFLINE_TRANSFER',
        paidAt: now(), paidBy: openid(), note
      }
    })
    .catch(() => ({ stats: { updated: 0 } }))
  if (!r.stats || r.stats.updated === 0) {
    const cur = await db.collection(C.COMMISSION).doc(commissionId).get().catch(() => null)
    if (!cur || !cur.data) return { ok: false, code: 'NOT_FOUND' }
    if (cur.data.status === 'paid') return { ok: true, already: true }
    if (cur.data.status === 'void') return { ok: false, code: 'COMMISSION_VOID', message: '该佣金已作废（订单已取消）' }
    return { ok: false, code: 'CONFLICT', status: cur.data.status }
  }
  const cm = (await db.collection(C.COMMISSION).doc(commissionId).get()).data
  await settleLedger(cm.orderId, 'paid_out', 'OFFLINE_TRANSFER')
  await log('adminMarkRefund', { commissionId, note })
  return { ok: true }
}

// ---------- 渠道退款（真实微信支付）----------
// 与「标记线下退款」是两条互斥路径：一旦走过渠道退款，就不允许再被人标记线下已付，
// 否则同一笔钱会被支付两次。
async function adminRefund(event) {
  const commissionId = String(event.commissionId || '')
  if (!commissionId) return { ok: false, code: 'BAD_COMMISSION' }
  if (!wxpay.isConfigured()) {
    return {
      ok: false, code: 'PAY_NOT_CONFIGURED',
      message: '微信支付参数未配置完整，缺少：' + wxpay.missing().join(', ')
    }
  }

  const cmDoc = await db.collection(C.COMMISSION).doc(commissionId).get().catch(() => null)
  if (!cmDoc || !cmDoc.data) return { ok: false, code: 'NOT_FOUND' }
  const c = cmDoc.data
  if (c.status === 'paid') return { ok: true, already: true, status: 'paid' }
  if (c.status === 'void') return { ok: false, code: 'COMMISSION_VOID', message: '该佣金已作废（订单已取消）' }
  if (c.status === 'processing') {
    return { ok: false, code: 'REFUND_PROCESSING', message: '退款已在处理中，请点「同步状态」确认结果' }
  }

  const orderDoc = await db.collection(C.ORDER).doc(c.orderId).get().catch(() => null)
  const o = orderDoc && orderDoc.data
  if (!o) return { ok: false, code: 'ORDER_NOT_FOUND' }
  if (!o.orderNo) return { ok: false, code: 'ORDER_NO_TRADE', message: '该订单没有支付单号，无法原路退款' }
  if (o.paidSource === 'mock') {
    return { ok: false, code: 'MOCK_ORDER', message: '该订单是演示支付产生的，没有真实资金可退' }
  }

  // 先抢占状态：pending/exception -> processing，避免两个管理员同时点导致重复退款
  const lock = await db.collection(C.COMMISSION)
    .where({ _id: commissionId, status: _.in(['pending', 'exception']) })
    .update({ data: { status: 'processing', channelStatus: 'REFUND_REQUESTING', refundNo: 'RF' + c.orderId } })
    .catch(() => ({ stats: { updated: 0 } }))
  if (!lock.stats || lock.stats.updated === 0) {
    return { ok: false, code: 'CONFLICT', message: '该笔佣金状态已变化，请刷新后重试' }
  }

  try {
    const r = await wxpay.refund({
      outTradeNo: o.orderNo,
      outRefundNo: 'RF' + c.orderId,   // 确定性退款单号：同一单重复提交是幂等的
      refundFen: c.amountFen,
      totalFen: o.amountFen,
      reason: '邀请达标返还'
    })
    await db.collection(C.COMMISSION).doc(commissionId).update({
      data: {
        channelStatus: r.status || 'PROCESSING',
        refundId: r.refund_id || '',
        refundAt: now(),
        refundOperator: openid()
      }
    }).catch(() => {})
    await settleLedger(c.orderId, 'in_flight', r.status || 'PROCESSING')
    await log('adminRefund', { commissionId, refundId: r.refund_id, status: r.status })
    return { ok: true, status: r.status || 'PROCESSING', refundId: r.refund_id || '' }
  } catch (e) {
    // 渠道明确拒绝：回落到 exception 让人工介入，不要把状态卡在 processing
    await db.collection(C.COMMISSION).doc(commissionId).update({
      data: {
        status: 'exception',
        channelStatus: 'REFUND_FAIL',
        channelMessage: String(e.message || '').slice(0, 200)
      }
    }).catch(() => {})
    await settleLedger(c.orderId, 'exception', 'REFUND_FAIL')
    await log('adminRefund_fail', { commissionId, code: e.code || '', message: e.message })
    return { ok: false, code: e.code || 'REFUND_FAIL', message: e.message }
  }
}

// 同步退款结果：退款是异步的，微信先回「已受理」，最终结果要再查一次
async function adminSyncRefund(event) {
  const commissionId = String(event.commissionId || '')
  if (!commissionId) return { ok: false, code: 'BAD_COMMISSION' }
  if (!wxpay.isConfigured()) return { ok: false, code: 'PAY_NOT_CONFIGURED' }

  const cmDoc = await db.collection(C.COMMISSION).doc(commissionId).get().catch(() => null)
  if (!cmDoc || !cmDoc.data) return { ok: false, code: 'NOT_FOUND' }
  const c = cmDoc.data
  if (c.status === 'paid') return { ok: true, status: 'SUCCESS', already: true }

  try {
    const r = await wxpay.queryRefund(c.refundNo || ('RF' + c.orderId))
    const st = r.status || 'PROCESSING'
    if (st === 'SUCCESS') {
      await db.collection(C.COMMISSION).doc(commissionId).update({
        data: { status: 'paid', channelStatus: 'REFUND_SUCCESS', paidAt: now() }
      }).catch(() => {})
      await settleLedger(c.orderId, 'paid_out', 'REFUND_SUCCESS')
    } else if (st === 'CLOSED' || st === 'ABNORMAL') {
      await db.collection(C.COMMISSION).doc(commissionId).update({
        data: { status: 'exception', channelStatus: st }
      }).catch(() => {})
      await settleLedger(c.orderId, 'exception', st)
    } else {
      await db.collection(C.COMMISSION).doc(commissionId).update({
        data: { channelStatus: st, refundId: r.refund_id || c.refundId || '' }
      }).catch(() => {})
    }
    await log('adminSyncRefund', { commissionId, status: st })
    return { ok: true, status: st }
  } catch (e) {
    return { ok: false, code: e.code || 'WXPAY_ERROR', message: e.message }
  }
}

// ---------- 查询 ----------
async function getInvitation(event) {
  const key = event.code ? { code: String(event.code).toUpperCase() } : { _id: event.invitationId }
  const inv = await db.collection(C.INVITATION).where(key).get()
  if (inv.data.length === 0) return { ok: false, code: 'NOT_FOUND' }
  const i = inv.data[0]
  const orderDoc = await db.collection(C.ORDER).doc(i.orderId).get().catch(() => null)
  const order = orderDoc && orderDoc.data
  const actDoc = await db.collection(C.ACTIVITY).doc(i.activityId).get().catch(() => null)
  const act = (actDoc && actDoc.data) || {}
  const cm = await db.collection(C.COMMISSION).where({ invitationId: i._id }).get().catch(() => ({ data: [] }))
  const c = cm.data[0]
  return {
    ok: true,
    invitation: {
      code: i.code,
      validCount: i.validCount,
      // 达标人数优先取快照：运营后改配置不影响已下单用户
      target: i.target || i.targetSnapshot || (order && order.inviteTargetSnapshot) || act.inviteTarget || 3,
      status: i.status,
      shortfall: !!i.shortfall,
      // 邀请截止同样以快照为准
      inviteDeadline: i.deadlineSnapshot || act.inviteDeadline,
      amountFen: (order && (order.priceFenSnapshot || order.amountFen)) || act.priceFen
    },
    // 脱敏：不返回 buyer openid、商户退款单号等内部字段
    commission: c ? {
      _id: c._id,
      status: c.status,
      amountFen: c.amountFen,
      paidAt: c.paidAt || null
    } : null
  }
}

async function getMyOrders(event = {}) {
  const limit = Math.min(Math.max(Number(event.limit) || 50, 1), 100)
  const list = await db.collection(C.ORDER).where({ buyer: openid() }).orderBy('createdAt', 'desc').limit(limit).get()
  const invMap = {}
  const invs = await db.collection(C.INVITATION).where({ buyer: openid() }).limit(limit).get()
  invs.data.forEach(i => { invMap[i.orderId] = i })
  return {
    ok: true,
    orders: list.data.map(o => ({
      ...o,
      inviteCode: invMap[o._id] ? invMap[o._id].code : null,
      invitationId: invMap[o._id] ? invMap[o._id]._id : null
    })),
    limit
  }
}

async function getOrderDetail(event) {
  const o = (await db.collection(C.ORDER).doc(event.orderId).get()).data
  if (!o || o.buyer !== openid()) return { ok: false, code: 'FORBIDDEN' }
  const inv = await db.collection(C.INVITATION).where({ orderId: event.orderId }).get()
  const cm = await db.collection(C.COMMISSION).where({ orderId: event.orderId }).get()
  const c = cm.data[0]
  return {
    ok: true,
    order: o,
    invitation: inv.data.length ? inv.data[0] : null,
    // 与邀请页保持一致：只给展示所需字段
    commission: c ? {
      _id: c._id, status: c.status, amountFen: c.amountFen, paidAt: c.paidAt || null
    } : null
  }
}

// 生成短时核销码（服务端校验用，5 分钟有效）
async function genVerifyCode(event) {
  const o = (await db.collection(C.ORDER).doc(event.orderId).get()).data
  if (!o || o.buyer !== openid()) return { ok: false, code: 'FORBIDDEN' }
  if (o.status !== 'paid') return { ok: false, code: 'ORDER_NOT_PAYABLE' }
  const code = String(Math.floor(100000 + Math.random() * 900000))
  await db.collection(C.ORDER).doc(event.orderId).update({
    data: { verifyCode: code, verifyCodeExpire: now() + 5 * 60 * 1000 }
  })
  return { ok: true, code, expireAt: now() + 5 * 60 * 1000 }
}

// ---------- 店员 ----------
// 两档角色模型下：管理员拥有全部门店权限（可看全部订单/核销），普通店员按 storeIds 限定。
// 优先使用明确绑定的 staff 记录（自检脚本会造「限店员」验证 WRONG_STORE），
// 仅当该身份没有任何绑定记录、且角色为 admin 时，才兜底赋予全部门店。
async function isStaff() {
  const oid = openid()
  const s = await db.collection(C.STAFF).where({ openid: oid }).get().catch(() => ({ data: [] }))
  if (s.data.length) return s.data[0]
  if (__role === 'admin') {
    const stores = await db.collection(C.STORE).limit(100).get().catch(() => ({ data: [] }))
    return { openid: oid, name: '管理员', storeIds: stores.data.map(x => x._id), isAdmin: true }
  }
  return null
}

async function staffOrders(event = {}) {
  const staff = await isStaff()
  if (!staff) return { ok: false, code: 'NOT_STAFF' }
  const ids = staff.storeIds || []
  // 没有绑定门店时不构造 in([])，那会得到一个非法查询
  if (!ids.length) return { ok: true, orders: [], storeIds: [], limit: 0 }
  const limit = Math.min(Math.max(Number(event.limit) || 100, 1), 100)
  const list = await db.collection(C.ORDER).where({
    storeId: _.in(ids), status: _.in(['paid', 'verified', 'cancel_processing', 'cancelled'])
  }).orderBy('createdAt', 'desc').limit(limit).get()
  return { ok: true, orders: list.data, storeIds: ids, limit }
}

async function staffVerify(event) {
  const staff = await isStaff()
  if (!staff) return { ok: false, code: 'NOT_STAFF' }
  const { orderId, code } = event
  const o = (await db.collection(C.ORDER).doc(orderId).get()).data
  if (!o) return { ok: false, code: 'NOT_FOUND' }
  if (!staff.storeIds.includes(o.storeId)) return { ok: false, code: 'WRONG_STORE' }
  if (o.status !== 'paid') return { ok: false, code: 'ORDER_NOT_PAYABLE' }
  if (!o.verifyCode || o.verifyCode !== String(code)) return { ok: false, code: 'BAD_CODE' }
  if (!o.verifyCodeExpire || now() > o.verifyCodeExpire) return { ok: false, code: 'CODE_EXPIRED' }

  // CAS：核销只可成功一次
  const r = await db.collection(C.ORDER).where({ _id: orderId, status: 'paid' }).update({
    data: { status: 'verified', verifiedAt: now(), verifyCode: null }
  })
  if (r.stats.updated === 0) return { ok: false, code: 'ALREADY_VERIFIED' }
  await log('staffVerify', { orderId })
  return { ok: true }
}

async function staffCancel(event) {
  const staff = await isStaff()
  if (!staff) return { ok: false, code: 'NOT_STAFF' }
  const { orderId } = event
  const od = await db.collection(C.ORDER).doc(orderId).get().catch(() => null)
  const o = od && od.data
  if (!o) return { ok: false, code: 'NOT_FOUND' }
  if (!staff.storeIds.includes(o.storeId)) return { ok: false, code: 'WRONG_STORE' }
  if (o.status !== 'paid') return { ok: false, code: 'CANCEL_NOT_ALLOWED' }

  // 查询该单佣金状态，决定可退金额（已作为佣金退出去的部分不再重复退）
  const cm = await db.collection(C.COMMISSION).where({ orderId }).get().catch(() => ({ data: [] }))
  const commission = cm.data.length ? cm.data[0] : null
  const paidOut = commission && commission.status === 'paid' ? commission.amountFen : 0
  const inFlight = commission && ['pending', 'processing'].includes(commission.status) ? commission.amountFen : 0
  const refundable = Math.max(0, (o.amountFen || 0) - paidOut - inFlight)

  const r = await db.collection(C.ORDER).where({ _id: orderId, status: 'paid' }).update({
    data: { status: 'cancel_processing', cancelRefundableFen: refundable, cancelAt: now() }
  })
  if (!r.stats || r.stats.updated === 0) return { ok: false, code: 'CONFLICT' }

  // 1) 本单作为「邀请人」的资格作废：订单都不存在了，不能再靠它拿退款。
  //    否则会形成「取消退款 129 + 后续凑满 N 人再退 129」的重复出款，这是原先最严重的资金漏洞。
  const ownInv = await db.collection(C.INVITATION).where({ orderId }).get().catch(() => ({ data: [] }))
  for (const inv of ownInv.data) {
    if (inv.status === 'void') continue
    await db.collection(C.INVITATION).doc(inv._id)
      .update({ data: { status: 'void', voidAt: now(), voidReason: 'order_cancelled' } })
      .catch(() => {})
    // 该邀请下的受邀关系一并作废，停止累计
    await db.collection(C.INVITE_RECORD).where({ invitationId: inv._id })
      .update({ data: { status: 'void' } }).catch(() => {})
    // 已锁定但尚未出款的佣金作废；已出款的只记录，供运营人工核对（钱已到用户账上，无法自动追回）
    const ownCm = await db.collection(C.COMMISSION).where({ invitationId: inv._id }).get().catch(() => ({ data: [] }))
    const c = ownCm.data[0]
    if (c && c.status !== 'paid') {
      await db.collection(C.COMMISSION).doc(c._id)
        .update({ data: { status: 'void', voidAt: now(), voidReason: 'order_cancelled' } }).catch(() => {})
      await db.collection(C.LEDGER).doc('LG_COMM_' + orderId)
        .update({ data: { status: 'void', voidAt: now() } }).catch(() => {})
    } else if (c && c.status === 'paid') {
      await log('cancel_after_refund', { orderId, commissionId: c._id, amountFen: c.amountFen })
    }
  }

  // 2) 本单作为「受邀人」：撤掉对邀请人的计数，并触发重算（未出款则回退作废）
  if (o.inviterInvitationId) {
    await db.collection(C.INVITE_RECORD).where({
      invitationId: o.inviterInvitationId, invitee: o.buyer
    }).update({ data: { status: 'held' } }).catch(() => {})
    await recomputeInvitation(o.inviterInvitationId)
  }

  // 预览：直接确认取消成功，写流水
  await confirmCancel(orderId)
  await log('staffCancel', { orderId, refundable })
  return { ok: true, refundableFen: refundable }
}

async function confirmCancel(orderId) {
  const od = await db.collection(C.ORDER).doc(orderId).get().catch(() => null)
  const o = od && od.data
  if (!o) return
  // CAS：只有 cancel_processing -> cancelled 的第一次成功，避免重复回补库存
  const r = await db.collection(C.ORDER).where({ _id: orderId, status: 'cancel_processing' }).update({
    data: { status: 'cancelled', cancelledAt: now() }
  }).catch(() => ({ stats: { updated: 0 } }))
  if (!r.stats || r.stats.updated === 0) return
  await db.collection(C.STORE).doc(o.storeId).update({ data: { stock: _.inc(1) } }).catch(() => {})
  const ledId = 'LG_CANCEL_' + orderId
  const led = await db.collection(C.LEDGER).doc(ledId).get().catch(() => null)
  if (!led || !led.data) {
    await db.collection(C.LEDGER).add({
      data: {
        _id: ledId, orderId, type: 'store_cancel',
        amountFen: o.cancelRefundableFen || 0, status: 'paid_out', createdAt: now()
      }
    }).catch(() => {})
  }
}

// ---------- 运营 / 财务 ----------
// 统计一律走 count() 聚合：原实现用 get() 全表拉取，云开发单次最多返回 100 条，
// 订单量一上来看板数字就会默默失真。
async function dashboard() {
  const actDoc = await db.collection(C.ACTIVITY).doc('act_linyou_v1').get().catch(() => null)
  const act = (actDoc && actDoc.data) || {}
  const [paidCnt, verifiedCnt, lockedCnt, cmPaidCnt, cmOpenCnt, cmVoidCnt] = await Promise.all([
    db.collection(C.ORDER).where({ status: _.in(['paid', 'verified']) }).count().catch(() => ({ total: 0 })),
    db.collection(C.ORDER).where({ status: 'verified' }).count().catch(() => ({ total: 0 })),
    db.collection(C.INVITATION).where({ status: 'locked' }).count().catch(() => ({ total: 0 })),
    db.collection(C.COMMISSION).where({ status: 'paid' }).count().catch(() => ({ total: 0 })),
    db.collection(C.COMMISSION).where({ status: _.in(['pending', 'processing', 'exception']) }).count().catch(() => ({ total: 0 })),
    db.collection(C.COMMISSION).where({ status: 'void' }).count().catch(() => ({ total: 0 }))
  ])
  const paidTotal = paidCnt.total || 0
  const lockedTotal = lockedCnt.total || 0
  return {
    ok: true,
    stats: {
      paidOrderCount: paidTotal,
      inviteTarget: act.inviteTarget || 3,
      lockedCount: lockedTotal,
      // 口径统一：已支付订单中邀请已达标的比例（每单对应一个邀请，分子分母同源）
      achievedRate: paidTotal ? Math.round(lockedTotal / paidTotal * 100) : 0,
      commissionPaid: cmPaidCnt.total || 0,
      commissionPending: cmOpenCnt.total || 0,
      commissionVoid: cmVoidCnt.total || 0,
      verifyRate: paidTotal ? Math.round((verifiedCnt.total || 0) / paidTotal * 100) : 0
    }
  }
}

async function ledger(event = {}) {
  const limit = Math.min(Math.max(Number(event.limit) || 100, 1), 100)
  const list = await db.collection(C.LEDGER).orderBy('createdAt', 'desc').limit(limit).get()
  return { ok: true, ledger: list.data, limit }
}

// ---------- 端到端自检 ----------
// 在单个云函数进程内，用不同 _testOpenid 模拟多用户，跑完整条真实数据链路。
// 仅用于联调验证（读写真实云数据库），小程序正常业务不调用此 action。
const testStores = [
  { _id: 'test_store_01', name: '自检门店一', stock: 50 },
  { _id: 'test_store_02', name: '自检门店二', stock: 30 }
]

async function cleanupE2E() {
  // 双保险：即使被内部调用，也不允许在未开启自检时清库
  if (!ALLOW_SELF_TEST) throw new Error('SELF_TEST_DISABLED')
  const colls = [C.ORDER, C.INVITATION, C.INVITE_RECORD, C.COMMISSION, C.LEDGER, C.STAFF, C.OPLOG]
  for (const c of colls) {
    try { await db.collection(c).where({ _id: _.exists(true) }).remove() } catch (e) { /* 忽略空集合 */ }
  }
}

async function e2eTest() {
  if (!ALLOW_SELF_TEST) {
    return {
      ok: false, code: 'SELF_TEST_DISABLED',
      message: '自检接口已禁用：它会清空订单/佣金/流水等业务数据。确需运行请先在云函数环境变量设置 ALLOW_SELF_TEST=true，跑完立即移除。'
    }
  }
  const steps = []
  let allOk = true
  const run = async (name, fn) => {
    try {
      const r = await fn()
      const ok = !(r && r.ok === false)
      if (!ok) allOk = false
      steps.push({ name, ok, result: r })
      return r
    } catch (e) {
      allOk = false
      steps.push({ name, ok: false, error: String(e.message || e) })
      return null
    }
  }

  await cleanupE2E()

  // 1) 初始化（店员身份）
  __testOpenid = 'staff'
  await run('初始化活动/门店/店员', () => seed({ force: true }, testStores))

  // 2) 发起人 A 下单并支付，拿到邀请码
  __testOpenid = 'A'
  const orderA = await run('A 下单', () => createOrder({ storeId: testStores[0]._id }))
  const payA = await run('A 支付成功', () => mockPay({ orderId: orderA && orderA.order._id }))
  const inviteCode = payA && payA.code

  // 3) 三位受邀人通过邀请码下单并支付 -> 达标
  for (const u of ['B', 'C', 'D']) {
    __testOpenid = u
    const o = await run(u + ' 用邀请码下单', () => createOrder({ storeId: testStores[0]._id, inviteCode }))
    await run(u + ' 支付成功（累计有效邀请）', () => mockPay({ orderId: o && o.order._id }))
  }

  // 4) 校验达标锁定 + 佣金单生成
  __testOpenid = 'A'
  const inv = await run('查询邀请进度（应达标锁定）', () => getInvitation({ code: inviteCode }))
  const commissionId = inv && inv.commission && inv.commission._id

  // 5) mock 退款到账
  await run('退款到账（mock）', () => mockRefund({ commissionId, result: 'success' }))

  // 6) 核销 A 的订单（店员）
  const vc = await run('A 生成核销码', () => genVerifyCode({ orderId: orderA && orderA.order._id }))
  __testOpenid = 'staff'
  await run('店员核销 A 订单', () => staffVerify({ orderId: orderA && orderA.order._id, code: vc && vc.code }))

  // 7) 门店取消场景：E 下单支付后由店员取消
  __testOpenid = 'E'
  const orderE = await run('E 下单', () => createOrder({ storeId: testStores[1]._id }))
  await run('E 支付成功', () => mockPay({ orderId: orderE && orderE.order._id }))
  __testOpenid = 'staff'
  await run('店员取消 E 订单（未达标，全额可退）', () => staffCancel({ orderId: orderE && orderE.order._id }))

  // 8) 看板与资金流水
  const dash = await run('运营看板', () => dashboard())
  const led = await run('资金流水', () => ledger())

  return {
    ok: allOk,
    inviteCode,
    steps,
    summary: {
      validCount: inv && inv.invitation && inv.invitation.validCount,
      invitationStatus: inv && inv.invitation && inv.invitation.status,
      commissionStatus: commissionId ? '见步骤' : null,
      orderCount: dash && dash.stats && dash.stats.paidOrderCount,
      ledgerCount: led && led.ledger && led.ledger.length
    }
  }
}

// 幂等/边界自检：重复回调、自邀、错门店、重复受邀去重、重复退款
async function edgeTest() {
  if (!ALLOW_SELF_TEST) {
    return {
      ok: false, code: 'SELF_TEST_DISABLED',
      message: '自检接口已禁用：它会清空订单/佣金/流水等业务数据。确需运行请先在云函数环境变量设置 ALLOW_SELF_TEST=true，跑完立即移除。'
    }
  }
  const steps = []
  let allOk = true
  const run = async (name, fn) => {
    try {
      const r = await fn()
      steps.push({ name, ok: true, result: r })
      return r
    } catch (e) {
      allOk = false
      steps.push({ name, ok: false, error: String(e.message || e) })
      return null
    }
  }
  const assert = (name, cond, detail) => {
    if (!cond) allOk = false
    steps.push({ name, ok: !!cond, detail })
  }

  await cleanupE2E()
  __testOpenid = 'staff'
  await seed({ force: true }, testStores)

  // 1) 支付回调幂等：同一订单重复 mockPay，第二次应被 CAS 拒绝
  __testOpenid = 'A'
  const oA = await createOrder({ storeId: testStores[0]._id })
  await mockPay({ orderId: oA.order._id })
  const pay2 = await mockPay({ orderId: oA.order._id })
  assert('支付回调重复 -> PAY_ALREADY_PROCESSED', pay2.ok === false && pay2.code === 'PAY_ALREADY_PROCESSED', pay2)

  const invA = await db.collection(C.INVITATION).where({ orderId: oA.order._id }).get()
  const inviteCode = invA.data[0].code

  // 2) 自邀拒绝：A 用自己的邀请码再下单（先让 A 的订单状态允许——用另一身份验证自邀逻辑）
  __testOpenid = 'A2'
  const selfTry = await createOrder({ storeId: testStores[0]._id, inviteCode: '__self__' })
  assert('无效邀请码 -> INVALID_INVITE_CODE', selfTry.ok === false && selfTry.code === 'INVALID_INVITE_CODE', selfTry)

  // 3) 三位受邀人达标，其中 B 尝试重复归因（两次支付不同订单归因同一邀请人 -> 只算一次）
  for (const u of ['B', 'C', 'D']) {
    __testOpenid = u
    const o = await createOrder({ storeId: testStores[0]._id, inviteCode })
    await mockPay({ orderId: o.order._id })
  }
  // 用 D 的账号再下一单归因同一邀请人验证去重（先撤掉其已支付单以便再下单）
  await db.collection(C.ORDER).where({ buyer: 'test_D', activityId: 'act_linyou_v1' }).remove()
  __testOpenid = 'D'
  const oD2 = await createOrder({ storeId: testStores[0]._id, inviteCode })
  await mockPay({ orderId: oD2.order._id })
  const invCheck = (await db.collection(C.INVITATION).where({ code: inviteCode }).get()).data[0]
  assert('同一受邀账号重复归因 -> 去重(validCount保持3)', invCheck.validCount === 3, { validCount: invCheck.validCount })

  // 4) 退款回调幂等：重复 mockRefund 不改变状态、不重复出款
  const cm = (await db.collection(C.COMMISSION).where({ invitationId: invCheck._id }).get()).data[0]
  await mockRefund({ commissionId: cm._id, result: 'success' })
  const refund2 = await mockRefund({ commissionId: cm._id, result: 'success' })
  assert('退款回调重复 -> already=true(幂等)', refund2.ok === true && refund2.already === true, refund2)
  const ledCount = (await db.collection(C.LEDGER).where({ orderId: oA.order._id, type: 'commission' }).count()).total
  assert('重复退款不重复写流水(佣金流水=1)', ledCount === 1, { ledCount })

  // 5) 错门店核销：店员不属于订单门店 -> WRONG_STORE
  __testOpenid = 'staff'
  // 创建一个只能核销自检门店一的店员。
  await db.collection(C.STAFF).add({ data: {
    _id: 'staff_limited', openid: 'test_staff_limited', name: '限店员', storeIds: [testStores[0]._id], createdAt: Date.now()
  } })
  __testOpenid = 'staff_limited'
  // 尝试核销自检门店二的订单。
  __testOpenid = 'E'
  const oE = await createOrder({ storeId: testStores[1]._id })
  await mockPay({ orderId: oE.order._id })
  const vcE = await genVerifyCode({ orderId: oE.order._id })
  __testOpenid = 'staff_limited'
  const wrongStore = await staffVerify({ orderId: oE.order._id, code: vcE.code })
  assert('错门店核销 -> WRONG_STORE', wrongStore.ok === false && wrongStore.code === 'WRONG_STORE', wrongStore)

  return { ok: allOk, steps }
}

// ---------- 路由 ----------
exports.main = async (event) => {
  // 微信支付回调：必须在解析 body 之前拦截。
  // v3 的签名是对「原始报文字节」计算的，一旦被 JSON.parse 再序列化，签名就对不上。
  const rawHeaders = (event && event.headers) || {}
  let hasPaySig = false
  for (const k of Object.keys(rawHeaders)) {
    if (String(k).toLowerCase() === 'wechatpay-signature') { hasPaySig = true; break }
  }
  if (hasPaySig) {
    const rawBody = typeof event.body === 'string' ? event.body : JSON.stringify(event.body || {})
    __identity = { openid: null, source: 'wxpay_notify', isTest: false }
    return await handlePayNotify(rawHeaders, rawBody)
  }

  // 兼容两种调用：
  // 1) wx.cloud.callFunction：参数直接在 event 上
  // 2) HTTP 访问服务（小程序 wx.request）：参数在 event.body（JSON 字符串）
  let e = event || {}
  if (typeof e.body === 'string' && e.body) {
    try { e = Object.assign({}, e, JSON.parse(e.body)) } catch (_) {}
  }
  // GET 请求（如 image 组件加载海报）：参数在 queryStringParameters，并入 e
  const query = (event && event.queryStringParameters) || {}
  if (Object.keys(query).length) e = Object.assign({}, query, e)
  const action = e.action

  // 公开接口：不要求登录（登录本身、首页数据、海报图片、邀请进度、身份查询）
  const PUBLIC_ACTIONS = ['login', 'getActivity', 'getPosterRaw', 'getInvitation', 'whoAmI']
  // 管理员接口：运营配置、店员工作台、经营/资金数据、自检、渠道退款。
  // 两档模型：普通登录用户只能访问「活动 + 订单」类接口，以下全部要求 admin 角色。
  const ADMIN_ACTIONS = [
    'adminGetConfig', 'adminSaveActivity', 'adminSavePoster',
    'adminPosterInit', 'adminPosterChunk', 'adminPosterMerge', 'adminResetPoster',
    'adminSaveStore', 'adminDeleteStore',
    'adminRevoke', 'adminListAdmins', 'adminCommissions', 'adminMarkRefund',
    'adminRefund', 'adminSyncRefund',
    'staffOrders', 'staffVerify', 'staffCancel', 'mockRefund',
    'seed', 'dashboard', 'ledger', 'e2eTest', 'edgeTest'
  ]

  // 每次调用重设身份与角色，避免云函数进程内串号
  __testOpenid = null
  __identity = { openid: null, source: 'none', isTest: false }
  __role = 'user'
  if (action !== 'login') {
    __identity = await resolveIdentity(e)
    // 测试通道同时设置 __testOpenid，兼容 e2e/edgeTest 内部的多用户模拟
    if (__identity.isTest) __testOpenid = e._testOpenid
    __role = await resolveRole(e)
  }

  try {
    // 非公开接口必须拿到身份；token 过期时明确要求前端重新登录
    if (!PUBLIC_ACTIONS.includes(action) && !__identity.openid) {
      return {
        ok: false, code: 'NO_LOGIN',
        message: e.token ? '登录态已失效，请重新登录' : '请先完成微信登录'
      }
    }
    // adminGrant 首位自举在接口内部自行鉴权（要求真实微信身份且尚无任何管理员）
    if (ADMIN_ACTIONS.includes(action)) {
      const denied = requireAdmin()
      if (denied) return denied
    }
    // 自检接口：管理员之外还要满足环境开关，双重拦截避免线上误触清库
    if ((action === 'e2eTest' || action === 'edgeTest') && !ALLOW_SELF_TEST) {
      return {
        ok: false, code: 'SELF_TEST_DISABLED',
        message: '自检接口已禁用：它会清空订单/佣金/流水等业务数据。确需运行请先设置环境变量 ALLOW_SELF_TEST=true，跑完立即移除。'
      }
    }
    switch (action) {
      case 'login': return await login(e)
      case 'whoAmI': return await whoAmI()
      case 'getProfile': return await getProfile()
      case 'saveProfile': return await saveProfile(e)
      case 'deleteAccount': return await deleteAccount()
      case 'seed': return await seed(e)
      case 'getActivity': return await getActivity()
      case 'getPosterRaw': return await getPosterRaw()
      case 'adminGetConfig': return await adminGetConfig()
      case 'adminSaveActivity': return await adminSaveActivity(e)
      case 'adminSavePoster': return await adminSavePoster(e)
      case 'adminPosterInit': return await adminPosterInit(e)
      case 'adminPosterChunk': return await adminPosterChunk(e)
      case 'adminPosterMerge': return await adminPosterMerge(e)
      case 'adminResetPoster': return await adminResetPoster()
      case 'adminSaveStore': return await adminSaveStore(e)
      case 'adminDeleteStore': return await adminDeleteStore(e)
      case 'adminGrant': return await adminGrant(e)
      case 'adminRevoke': return await adminRevoke(e)
      case 'adminListAdmins': return await adminListAdmins()
      case 'adminCommissions': return await adminCommissions(e)
      case 'adminMarkRefund': return await adminMarkRefund(e)
      case 'adminRefund': return await adminRefund(e)
      case 'adminSyncRefund': return await adminSyncRefund(e)
      case 'createOrder': return await createOrder(e)
      case 'prepay': return await prepay(e)
      case 'payQuery': return await payQuery(e)
      case 'mockPay': return await mockPay(e)
      case 'mockRefund': return await mockRefund(e)
      case 'getInvitation': return await getInvitation(e)
      case 'getMyOrders': return await getMyOrders(e)
      case 'getOrderDetail': return await getOrderDetail(e)
      case 'genVerifyCode': return await genVerifyCode(e)
      case 'staffOrders': return await staffOrders(e)
      case 'staffVerify': return await staffVerify(e)
      case 'staffCancel': return await staffCancel(e)
      case 'dashboard': return await dashboard()
      case 'ledger': return await ledger(e)
      case 'e2eTest': return await e2eTest()
      case 'edgeTest': return await edgeTest()
      default: return { ok: false, code: 'UNKNOWN_ACTION' }
    }
  } catch (err) {
    return { ok: false, code: 'SERVER_ERROR', message: err.message }
  }
}
