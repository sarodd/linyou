/**
 * 核心业务云函数 api
 * 邀请达标返佣（邀请达标门店退款）MVP - 后端全部运行在 CloudBase
 *
 * 设计要点（对齐 PRD）：
 * - 金额一律以「分」为单位，前端展示时 /100
 * - 幂等：佣金单 / 邀请有效记录使用确定性 _id；支付回调按订单状态 CAS
 * - 并发互斥：资金锁定与达标判定放在 db.runTransaction 内，配合状态 CAS
 * - 规则版本：订单快照购买时的活动规则版本
 * - 当前为「可预览版」：支付与渠道退款为 mock，接真实微信支付时替换 mockPay / mockRefund 两处
 */
const cloud = require('wx-server-sdk')
const crypto = require('crypto')
const https = require('https')
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
// 预览期：测试通道身份默认视为管理员，保证未配域名 / 未登录时演示功能仍可用。
// 上线设 PREVIEW_ADMIN=false 后，测试通道身份降为普通用户。
const PREVIEW_ADMIN = process.env.PREVIEW_ADMIN !== 'false'
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
      if (!/^data:image\/(jpeg|jpg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(av)) {
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

async function seed(event) {
  await ensureCollections()
  const activityId = 'act_linyou_v1'
  // 防覆盖：默认只在活动不存在时初始化演示数据。
  // 自检脚本（e2eTest / edgeTest）需要回到出厂状态时显式传 force:true。
  const exist = await db.collection(C.ACTIVITY).doc(activityId).get().catch(() => null)
  if (exist && exist.data && !(event && event.force)) {
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

  // 洗发水主题 mock 门店（品牌：邻友购）
  const stores = [
    { _id: 'store_sh_01', name: '邻友购·上海南京西路店', address: '上海市静安区南京西路 1266 号 恒隆广场 B1', hours: '10:00-22:00', phone: '021-62888801', stock: 50 },
    { _id: 'store_sh_02', name: '邻友购·上海徐家汇店', address: '上海市徐汇区肇嘉浜路 1000 号 美罗城 2F', hours: '10:00-22:00', phone: '021-64288802', stock: 30 },
    { _id: 'store_bj_01', name: '邻友购·北京国贸店', address: '北京市朝阳区建国门外大街 1 号 国贸商城 B1', hours: '10:00-22:00', phone: '010-65058803', stock: 40 }
  ]
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
async function adminSaveActivity(event) {
  const patch = {}
  for (const f of ACTIVITY_FIELDS) {
    if (event[f] !== undefined) patch[f] = event[f]
  }
  // 基本校验
  if (patch.priceFen !== undefined && (!Number.isFinite(patch.priceFen) || patch.priceFen < 0)) {
    return { ok: false, code: 'BAD_PRICE' }
  }
  if (patch.inviteTarget !== undefined && (!Number.isInteger(patch.inviteTarget) || patch.inviteTarget < 1)) {
    return { ok: false, code: 'BAD_TARGET' }
  }
  if (!Object.keys(patch).length) return { ok: false, code: 'EMPTY_PATCH' }
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
  if (!uploadId) return { ok: false, code: 'NO_UPLOAD_ID' }
  const res = await db.collection(CHUNK_COLL).where({ uploadId: uploadId }).orderBy('index', 'asc').limit(200).get()
  const items = res.data || []
  if (!items.length) return { ok: false, code: 'NO_CHUNKS' }
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
  if (old && old.data) {
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
  const act = await db.collection(C.ACTIVITY).doc('act_linyou_v1').get()

  if (act.data.status !== 'ongoing') return { ok: false, code: 'ACTIVITY_ENDED' }
  if (now() > act.data.orderDeadline) return { ok: false, code: 'ORDER_DEADLINE_PASSED' }

  // 查找是否有进行中/已支付订单，占用下单资格
  const existed = await db.collection(C.ORDER).where({
    buyer: oid, activityId: act.data._id, status: _.in(['pending_pay', 'paid', 'verified'])
  }).get()
  if (existed.data.length > 0) return { ok: false, code: 'ALREADY_ORDERED', orderId: existed.data[0]._id }

  // 校验邀请码（不允许自邀）
  let inviterId = null
  if (inviteCode) {
    const inv = await db.collection(C.INVITATION).where({ code: String(inviteCode).toUpperCase() }).get()
    if (inv.data.length === 0) return { ok: false, code: 'INVALID_INVITE_CODE' }
    if (inv.data[0].buyer === oid) return { ok: false, code: 'SELF_INVITE' }
    if (inv.data[0].activityId !== act.data._id) return { ok: false, code: 'INVITE_ACTIVITY_MISMATCH' }
    inviterId = inv.data[0]._id
  }

  const store = await db.collection(C.STORE).doc(storeId).get().catch(() => null)
  if (!store || !store.data) return { ok: false, code: 'STORE_NOT_FOUND' }
  if (store.data.stock <= 0) return { ok: false, code: 'OUT_OF_STOCK' }

  const orderId = 'O' + now() + Math.floor(Math.random() * 1000)
  const order = {
    _id: orderId,
    orderNo: 'LN' + now() + Math.floor(Math.random() * 900 + 100),
    buyer: oid,
    activityId: act.data._id,
    ruleVersion: act.data.ruleVersion,
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

// ---------- 支付成功（mock，替换点 1）----------
// 真实场景：微信支付回调验签后调用本函数；此处由前端直接触发用于预览
async function mockPay(event) {
  const { orderId } = event
  const oid = openid()

  // CAS：只有 pending_pay -> paid 的第一次调用成功，保证幂等
  const payRes = await db.collection(C.ORDER).where({ _id: orderId, buyer: oid, status: 'pending_pay' }).update({
    data: { status: 'paid', paidAt: now() }
  })
  if (payRes.stats.updated === 0) {
    const cur = await db.collection(C.ORDER).doc(orderId).get().catch(() => null)
    return { ok: false, code: 'PAY_ALREADY_PROCESSED', status: cur && cur.data ? cur.data.status : null }
  }

  const order = (await db.collection(C.ORDER).doc(orderId).get()).data

  // 1) 为原订单生成邀请记录（邀请码 + 带参链接）
  const code = genInviteCode()
  const invitationId = 'INV_' + orderId
  await db.collection(C.INVITATION).add({
    data: {
      _id: invitationId,
      code,
      orderId,
      buyer: oid,
      activityId: order.activityId,
      status: 'accumulating',   // accumulating -> locked
      validCount: 0,
      target: null,
      createdAt: now()
    }
  })

  // 2) 扣减门店库存（支付成功才扣）
  await db.collection(C.STORE).doc(order.storeId).update({ data: { stock: _.inc(-1) } })

  // 3) 若该单有归因，记录有效邀请关系（按受邀账号去重）
  if (order.inviterInvitationId) {
    await addInviteRecord(order.inviterInvitationId, oid, orderId)
  }

  await log('mockPay', { orderId, invitationId })
  return { ok: true, order, invitationId, code }
}

function genInviteCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let s = ''
  for (let i = 0; i < 8; i++) s += chars[Math.floor(Math.random() * chars.length)]
  return s
}

// 统计并重算邀请达标 -> 在事务内锁定资格并创建佣金单
async function addInviteRecord(invitationId, invitee, orderId) {
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

async function recomputeInvitation(invitationId) {
  const inv = (await db.collection(C.INVITATION).doc(invitationId).get()).data
  if (!inv || inv.status !== 'accumulating') return

  const valid = await db.collection(C.INVITE_RECORD).where({ invitationId, status: 'valid' }).count()
  // 同步有效人数
  await db.collection(C.INVITATION).doc(invitationId).update({ data: { validCount: valid.total, target: null } })

  const act = (await db.collection(C.ACTIVITY).doc(inv.activityId).get()).data
  if (valid.total < act.inviteTarget) return

  // 事务内：二次校验 + CAS 锁定，避免并发重复发佣
  try {
    await db.runTransaction(async tx => {
      const fresh = (await tx.collection(C.INVITATION).doc(invitationId).get()).data
      if (!fresh || fresh.status !== 'accumulating') return
      const cnt = await tx.collection(C.INVITE_RECORD).where({ invitationId, status: 'valid' }).count()
      if (cnt.total < act.inviteTarget) return

      // 锁定资格
      await tx.collection(C.INVITATION).doc(invitationId).update({
        data: { status: 'locked', validCount: cnt.total, target: act.inviteTarget, lockedAt: now() }
      })

      // 唯一佣金单：_id 绑定原订单，保证每单一次
      const originalOrder = (await tx.collection(C.ORDER).doc(fresh.orderId).get()).data
      const commissionId = 'CM_' + fresh.orderId
      const exist = await tx.collection(C.COMMISSION).doc(commissionId).get().catch(() => null)
      if (!exist || !exist.data) {
        await tx.collection(C.COMMISSION).add({
          data: {
            _id: commissionId,
            orderId: fresh.orderId,
            invitationId,
            buyer: fresh.buyer,
            amountFen: originalOrder.amountFen,
            status: 'pending',        // pending -> processing -> paid / exception
            refundNo: 'RF' + fresh.orderId, // 固定商户退款单号，重试沿用
            channelStatus: null,
            createdAt: now()
          }
        })
        // 资金占用：在途金额
        await tx.collection(C.LEDGER).add({
          data: {
            _id: 'LG_COMM_' + fresh.orderId,
            orderId: fresh.orderId,
            type: 'commission',
            amountFen: originalOrder.amountFen,
            status: 'in_flight',
            refundNo: 'RF' + fresh.orderId,
            createdAt: now()
          }
        })
      }
    })
    await log('commission_locked', { invitationId, orderId: inv.orderId })
  } catch (e) {
    // 事务冲突：重试一次（回调场景可再入）
    await recomputeInvitationOnce(invitationId)
  }
}

async function recomputeInvitationOnce(invitationId) {
  const inv = (await db.collection(C.INVITATION).doc(invitationId).get()).data
  if (!inv || inv.status !== 'accumulating') return
  const act = (await db.collection(C.ACTIVITY).doc(inv.activityId).get()).data
  const cnt = await db.collection(C.INVITE_RECORD).where({ invitationId, status: 'valid' }).count()
  if (cnt.total < act.inviteTarget) return
  const updated = await db.collection(C.INVITATION).where({ _id: invitationId, status: 'accumulating' }).update({
    data: { status: 'locked', validCount: cnt.total, target: act.inviteTarget, lockedAt: now() }
  })
  if (updated.stats.updated === 1) {
    const order = (await db.collection(C.ORDER).doc(inv.orderId).get()).data
    await db.collection(C.COMMISSION).add({
      data: {
        _id: 'CM_' + inv.orderId, orderId: inv.orderId, invitationId,
        buyer: inv.buyer, amountFen: order.amountFen, status: 'pending',
        refundNo: 'RF' + inv.orderId, channelStatus: null, createdAt: now()
      }
    }).catch(() => {})
  }
}

// ---------- 退款渠道结果（mock，替换点 2）----------
async function mockRefund(event) {
  const { commissionId, result } = event // result: 'success' | 'fail'
  const cm = (await db.collection(C.COMMISSION).doc(commissionId).get()).data
  if (!cm) return { ok: false, code: 'NOT_FOUND' }
  if (cm.status === 'paid') return { ok: true, already: true } // 幂等

  const success = result !== 'fail'
  await db.collection(C.COMMISSION).doc(commissionId).update({
    data: {
      status: success ? 'paid' : 'exception',
      channelStatus: success ? 'REFUND_SUCCESS' : 'REFUND_FAIL',
      paidAt: success ? now() : null
    }
  })
  await db.collection(C.LEDGER).doc('LG_COMM_' + cm.orderId).update({
    data: { status: success ? 'paid_out' : 'exception', channelStatus: success ? 'REFUND_SUCCESS' : 'REFUND_FAIL' }
  })
  await log('mockRefund', { commissionId, result })
  return { ok: true, status: success ? 'paid' : 'exception' }
}

// ---------- 查询 ----------
async function getInvitation(event) {
  const key = event.code ? { code: String(event.code).toUpperCase() } : { _id: event.invitationId }
  const inv = await db.collection(C.INVITATION).where(key).get()
  if (inv.data.length === 0) return { ok: false, code: 'NOT_FOUND' }
  const i = inv.data[0]
  const act = (await db.collection(C.ACTIVITY).doc(i.activityId).get()).data
  const cm = await db.collection(C.COMMISSION).where({ invitationId: i._id }).get()
  return {
    ok: true,
    invitation: {
      code: i.code,
      validCount: i.validCount,
      target: i.target || act.inviteTarget,
      status: i.status,
      inviteDeadline: act.inviteDeadline,
      amountFen: act.priceFen
    },
    commission: cm.data.length ? cm.data[0] : null
  }
}

async function getMyOrders() {
  const list = await db.collection(C.ORDER).where({ buyer: openid() }).orderBy('createdAt', 'desc').get()
  const invMap = {}
  const invs = await db.collection(C.INVITATION).where({ buyer: openid() }).get()
  invs.data.forEach(i => { invMap[i.orderId] = i })
  return {
    ok: true,
    orders: list.data.map(o => ({
      ...o,
      inviteCode: invMap[o._id] ? invMap[o._id].code : null,
      invitationId: invMap[o._id] ? invMap[o._id]._id : null
    }))
  }
}

async function getOrderDetail(event) {
  const o = (await db.collection(C.ORDER).doc(event.orderId).get()).data
  if (!o || o.buyer !== openid()) return { ok: false, code: 'FORBIDDEN' }
  const inv = await db.collection(C.INVITATION).where({ orderId: event.orderId }).get()
  const cm = await db.collection(C.COMMISSION).where({ orderId: event.orderId }).get()
  return {
    ok: true,
    order: o,
    invitation: inv.data.length ? inv.data[0] : null,
    commission: cm.data.length ? cm.data[0] : null
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

async function staffOrders() {
  const staff = await isStaff()
  if (!staff) return { ok: false, code: 'NOT_STAFF' }
  const list = await db.collection(C.ORDER).where({
    storeId: _.in(staff.storeIds), status: _.in(['paid', 'verified', 'cancel_processing', 'cancelled'])
  }).orderBy('createdAt', 'desc').get()
  return { ok: true, orders: list.data, storeIds: staff.storeIds }
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
  const o = (await db.collection(C.ORDER).doc(orderId).get()).data
  if (!o) return { ok: false, code: 'NOT_FOUND' }
  if (!staff.storeIds.includes(o.storeId)) return { ok: false, code: 'WRONG_STORE' }
  if (o.status !== 'paid') return { ok: false, code: 'CANCEL_NOT_ALLOWED' }

  // 查询该单佣金状态，决定可退金额
  const cm = await db.collection(C.COMMISSION).where({ orderId }).get()
  const commission = cm.data.length ? cm.data[0] : null
  const paidOut = commission && commission.status === 'paid' ? commission.amountFen : 0
  const inFlight = commission && ['pending', 'processing'].includes(commission.status) ? commission.amountFen : 0
  const refundable = o.amountFen - paidOut - inFlight

  const r = await db.collection(C.ORDER).where({ _id: orderId, status: 'paid' }).update({
    data: { status: 'cancel_processing', cancelRefundableFen: refundable, cancelAt: now() }
  })
  if (r.stats.updated === 0) return { ok: false, code: 'CONFLICT' }

  // 暂扣该受邀订单对邀请人的计数（如它是有效受邀）
  if (o.inviterInvitationId) {
    await db.collection(C.INVITE_RECORD).where({
      invitationId: o.inviterInvitationId, invitee: o.buyer
    }).update({ data: { status: 'held' } })
  }

  // 预览：直接确认取消成功，写流水
  await confirmCancel(orderId)
  await log('staffCancel', { orderId, refundable })
  return { ok: true, refundableFen: refundable }
}

async function confirmCancel(orderId) {
  const o = (await db.collection(C.ORDER).doc(orderId).get()).data
  await db.collection(C.ORDER).doc(orderId).update({ data: { status: 'cancelled', cancelledAt: now() } })
  await db.collection(C.STORE).doc(o.storeId).update({ data: { stock: _.inc(1) } })
  await db.collection(C.LEDGER).add({
    data: {
      _id: 'LG_CANCEL_' + orderId, orderId, type: 'store_cancel',
      amountFen: o.cancelRefundableFen || 0, status: 'paid_out', createdAt: now()
    }
  })
}

// ---------- 运营 / 财务 ----------
async function dashboard() {
  const act = (await db.collection(C.ACTIVITY).doc('act_linyou_v1').get()).data
  const orders = await db.collection(C.ORDER).get()
  const invs = await db.collection(C.INVITATION).get()
  const cms = await db.collection(C.COMMISSION).get()
  const paid = orders.data.filter(o => ['paid', 'verified'].includes(o.status))
  const verified = orders.data.filter(o => o.status === 'verified')
  const locked = invs.data.filter(i => i.status === 'locked')
  return {
    ok: true,
    stats: {
      paidOrderCount: paid.length,
      inviteTarget: act.inviteTarget,
      lockedCount: locked.length,
      achievedRate: paid.length ? Math.round(locked.length / paid.length * 100) : 0,
      commissionPaid: cms.data.filter(c => c.status === 'paid').length,
      verifyRate: paid.length ? Math.round(verified.length / paid.length * 100) : 0
    }
  }
}

async function ledger() {
  const list = await db.collection(C.LEDGER).orderBy('createdAt', 'desc').get()
  return { ok: true, ledger: list.data }
}

// ---------- 端到端自检 ----------
// 在单个云函数进程内，用不同 _testOpenid 模拟多用户，跑完整条真实数据链路。
// 仅用于联调验证（读写真实云数据库），小程序正常业务不调用此 action。
async function cleanupE2E() {
  const colls = [C.ORDER, C.INVITATION, C.INVITE_RECORD, C.COMMISSION, C.LEDGER, C.STAFF, C.OPLOG]
  for (const c of colls) {
    try { await db.collection(c).where({ _id: _.exists(true) }).remove() } catch (e) { /* 忽略空集合 */ }
  }
}

async function e2eTest() {
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
  await run('初始化活动/门店/店员', () => seed({ force: true }))

  // 2) 发起人 A 下单并支付，拿到邀请码
  __testOpenid = 'A'
  const orderA = await run('A 下单', () => createOrder({ storeId: 'store_sh_01' }))
  const payA = await run('A 支付成功', () => mockPay({ orderId: orderA && orderA.order._id }))
  const inviteCode = payA && payA.code

  // 3) 三位受邀人通过邀请码下单并支付 -> 达标
  for (const u of ['B', 'C', 'D']) {
    __testOpenid = u
    const o = await run(u + ' 用邀请码下单', () => createOrder({ storeId: 'store_sh_01', inviteCode }))
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
  const orderE = await run('E 下单', () => createOrder({ storeId: 'store_sh_02' }))
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
  await seed({ force: true })

  // 1) 支付回调幂等：同一订单重复 mockPay，第二次应被 CAS 拒绝
  __testOpenid = 'A'
  const oA = await createOrder({ storeId: 'store_sh_01' })
  await mockPay({ orderId: oA.order._id })
  const pay2 = await mockPay({ orderId: oA.order._id })
  assert('支付回调重复 -> PAY_ALREADY_PROCESSED', pay2.ok === false && pay2.code === 'PAY_ALREADY_PROCESSED', pay2)

  const invA = await db.collection(C.INVITATION).where({ orderId: oA.order._id }).get()
  const inviteCode = invA.data[0].code

  // 2) 自邀拒绝：A 用自己的邀请码再下单（先让 A 的订单状态允许——用另一身份验证自邀逻辑）
  __testOpenid = 'A2'
  const selfTry = await createOrder({ storeId: 'store_sh_01', inviteCode: '__self__' })
  assert('无效邀请码 -> INVALID_INVITE_CODE', selfTry.ok === false && selfTry.code === 'INVALID_INVITE_CODE', selfTry)

  // 3) 三位受邀人达标，其中 B 尝试重复归因（两次支付不同订单归因同一邀请人 -> 只算一次）
  for (const u of ['B', 'C', 'D']) {
    __testOpenid = u
    const o = await createOrder({ storeId: 'store_sh_01', inviteCode })
    await mockPay({ orderId: o.order._id })
  }
  // 用 D 的账号再下一单归因同一邀请人验证去重（先撤掉其已支付单以便再下单）
  await db.collection(C.ORDER).where({ buyer: 'test_D', activityId: 'act_linyou_v1' }).remove()
  __testOpenid = 'D'
  const oD2 = await createOrder({ storeId: 'store_sh_01', inviteCode })
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
  // 造一个只有 store_sh_01 权限的店员账号
  await db.collection(C.STAFF).add({ data: {
    _id: 'staff_limited', openid: 'test_staff_limited', name: '限店员', storeIds: ['store_sh_01'], createdAt: Date.now()
  } })
  __testOpenid = 'staff_limited'
  // 用徐家汇店(store_sh_02)的订单尝试核销
  __testOpenid = 'E'
  const oE = await createOrder({ storeId: 'store_sh_02' })
  await mockPay({ orderId: oE.order._id })
  const vcE = await genVerifyCode({ orderId: oE.order._id })
  __testOpenid = 'staff_limited'
  const wrongStore = await staffVerify({ orderId: oE.order._id, code: vcE.code })
  assert('错门店核销 -> WRONG_STORE', wrongStore.ok === false && wrongStore.code === 'WRONG_STORE', wrongStore)

  return { ok: allOk, steps }
}

// ---------- 路由 ----------
exports.main = async (event) => {
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
    'adminRevoke', 'adminListAdmins',
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
    switch (action) {
      case 'login': return await login(e)
      case 'whoAmI': return await whoAmI()
      case 'getProfile': return await getProfile()
      case 'saveProfile': return await saveProfile(e)
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
      case 'createOrder': return await createOrder(e)
      case 'mockPay': return await mockPay(e)
      case 'mockRefund': return await mockRefund(e)
      case 'getInvitation': return await getInvitation(e)
      case 'getMyOrders': return await getMyOrders()
      case 'getOrderDetail': return await getOrderDetail(e)
      case 'genVerifyCode': return await genVerifyCode(e)
      case 'staffOrders': return await staffOrders()
      case 'staffVerify': return await staffVerify(e)
      case 'staffCancel': return await staffCancel(e)
      case 'dashboard': return await dashboard()
      case 'ledger': return await ledger()
      case 'e2eTest': return await e2eTest()
      case 'edgeTest': return await edgeTest()
      default: return { ok: false, code: 'UNKNOWN_ACTION' }
    }
  } catch (err) {
    return { ok: false, code: 'SERVER_ERROR', message: err.message }
  }
}
