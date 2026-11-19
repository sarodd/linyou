const api = require('../../utils/api')
const tab = require('../../utils/tab')
const privacy = require('../../utils/privacy')

// 与云端 saveProfile 的 AVATAR_MAX_CHARS 保持一致（base64 字符数）
// HTTP 网关请求体约 96KB，头像连同 JSON 外壳必须留足余量
const AVATAR_MAX = 45 * 1024

// 头像压缩档位：先按 240 方形 + 0.7 质量，超限再逐级降
const AVATAR_PLANS = [
  { quality: 0.7, size: 240 },
  { quality: 0.55, size: 200 },
  { quality: 0.4, size: 160 }
]

Page({
  data: {
    loading: true,
    saving: false,
    nickname: '',
    initial: '',
    avatar: '',
    openid: '',
    roleText: '普通用户',
    isAdmin: false,
    loginText: '',
    updatedText: '',
    nickMax: 20,
    showPrivacy: false,
    canDelete: false,
    stats: { total: 0, paid: 0, verified: 0 }
  },

  // 隐私回调是全局单例，只在当前可见页注册，避免离开页面后仍被别的页面触发
  onShow() {
    privacy.attach(this)
    tab.sync(this, tab.PATH.mine)
    this.load()
  },

  onHide() {
    privacy.detach(this)
  },

  onUnload() {
    privacy.detach(this)
  },

  // ---- 隐私授权 ----
  // 头像/昵称属于隐私接口，未同意《隐私政策》时先由 privacy-popup 引导授权
  onPrivacyAgree() {
    privacy.agree(this)
  },

  onPrivacyReject() {
    privacy.reject(this, '未同意隐私政策，暂时无法设置头像昵称')
  },

  async load() {
    const [p, o] = await Promise.all([api.getProfile(), api.getMyOrders()])
    const patch = { loading: false }

    if (p && p.ok) {
      const nick = p.nickname || ''
      Object.assign(patch, {
        nickname: nick,
        initial: nick ? nick.charAt(0) : '',
        avatar: p.avatar || '',
        openid: p.openid || '',
        roleText: p.roleText || '普通用户',
        isAdmin: !!p.isAdmin,
        loginText: p.loginText || '',
        nickMax: p.nickMax || 20,
        updatedText: p.updatedAt ? api.fmtTime(p.updatedAt) : '',
        // 只有真实微信身份可注销；预览身份、管理员（需先移除权限）不给入口
        canDelete: !!p.openid && !p.isTest && !p.isAdmin
      })
    }
    if (o && o.ok) {
      const list = o.orders || []
      patch.stats = {
        total: list.length,
        paid: list.filter(x => x.status === 'paid').length,
        verified: list.filter(x => x.status === 'verified').length
      }
    }
    this.setData(patch)
  },

  onPullDownRefresh() {
    this.load().then(() => wx.stopPullDownRefresh())
  },

  // ---- 昵称 ----
  // <input type="nickname"> 在用户点「使用微信昵称」后会回填，失焦/确认时保存
  onNickChange(e) {
    const v = String((e.detail && e.detail.value) || '').trim().slice(0, this.data.nickMax)
    if (v === this.data.nickname) return
    this.saveNick(v)
  },

  async saveNick(nick) {
    if (this._saving) return
    const prev = this.data.nickname
    this._saving = true
    this.setData({ saving: true })
    const r = await api.saveProfile({ nickname: nick })
    this._saving = false
    this.setData({ saving: false })
    if (r && r.ok) {
      this.setData({
        nickname: r.nickname || '',
        initial: r.nickname ? r.nickname.charAt(0) : '',
        updatedText: r.updatedAt ? api.fmtTime(r.updatedAt) : this.data.updatedText
      })
    } else {
      // 保存失败要把输入框回退到上一版，避免界面显示未落库的昵称
      this.setData({ nickname: prev, initial: prev ? prev.charAt(0) : '' })
      wx.showToast({ title: (r && (r.message || r.code)) || '昵称保存失败', icon: 'none' })
    }
  },

  // ---- 头像 ----
  onChooseAvatar(e) {
    const path = e.detail && e.detail.avatarUrl
    if (!path) return
    this.setData({ saving: true })
    wx.showLoading({ title: '正在处理头像', mask: true })
    this.compressAvatar(path, 0).then((base64) => {
      wx.hideLoading()
      if (!base64) return
      this.uploadAvatar(base64)
    }).catch((err) => {
      wx.hideLoading()
      this.setData({ saving: false })
      wx.showModal({ title: '头像处理失败', content: (err && err.message) || '未知错误', showCancel: false })
    })
  },

  // 逐级压缩直到低于服务端上限；方形居中裁剪，避免头像变形
  async compressAvatar(filePath, idx) {
    const plan = AVATAR_PLANS[idx]
    if (!plan) return ''
    const base64 = await this.renderSquareJpeg(filePath, plan.size, plan.quality)
    if (base64.length <= AVATAR_MAX) return base64
    return await this.compressAvatar(filePath, idx + 1)
  },

  renderSquareJpeg(filePath, size, quality) {
    return new Promise((resolve, reject) => {
      wx.getImageInfo({
        src: filePath,
        success: (info) => {
          const w = info.width || size
          const h = info.height || size
          wx.createSelectorQuery().select('#avatar-canvas').fields({ node: true, size: true }).exec((res) => {
            const canvas = res && res[0] && res[0].node
            if (!canvas) { reject(new Error('画布初始化失败')); return }
            canvas.width = size
            canvas.height = size
            const img = canvas.createImage()
            img.onload = () => {
              const ctx = canvas.getContext('2d')
              // 以短边为基准居中裁剪出正方形，再绘制到 size×size 画布
              const side = Math.min(w, h)
              const sx = (w - side) / 2
              const sy = (h - side) / 2
              ctx.clearRect(0, 0, size, size)
              // JPEG 不支持透明：先铺白底，避免带透明通道的头像变黑
              ctx.fillStyle = '#ffffff'
              ctx.fillRect(0, 0, size, size)
              ctx.drawImage(img, sx, sy, side, side, 0, 0, size, size)
              wx.canvasToTempFilePath({
                canvas, fileType: 'jpeg', quality,
                width: size, height: size,
                success: (r) => {
                  wx.getFileSystemManager().readFile({
                    filePath: r.tempFilePath,
                    encoding: 'base64',
                    success: (fr) => resolve('data:image/jpeg;base64,' + fr.data),
                    fail: () => reject(new Error('读取压缩头像失败'))
                  })
                },
                fail: () => reject(new Error('导出压缩头像失败'))
              })
            }
            img.onerror = () => reject(new Error('头像图片加载失败'))
            img.src = filePath
          })
        },
        fail: () => reject(new Error('获取头像信息失败'))
      })
    })
  },

  async uploadAvatar(base64) {
    const r = await api.saveProfile({ avatar: base64 })
    this.setData({ saving: false })
    if (r && r.ok) {
      this.setData({
        avatar: r.avatar || base64,
        updatedText: r.updatedAt ? api.fmtTime(r.updatedAt) : this.data.updatedText
      })
      wx.showToast({ title: '头像已更新', icon: 'success' })
    } else {
      wx.showModal({
        title: '头像保存失败',
        content: (r && (r.message || r.code)) || '未知错误',
        showCancel: false
      })
    }
  },

  // ---- 其它 ----
  copyOpenid() {
    if (!this.data.openid) return
    wx.setClipboardData({
      data: this.data.openid,
      success: () => wx.showToast({ title: '已复制 openid', icon: 'none' })
    })
  },
  goOrders() {
    wx.switchTab({ url: '/pages/orders/orders' })
  },
  goIndex() {
    wx.switchTab({ url: '/pages/index/index' })
  },
  goAdmin() {
    wx.switchTab({ url: '/pages/admin/admin' })
  },

  // ---- 协议 ----
  goPrivacy() {
    wx.navigateTo({ url: '/pages/legal/legal?type=privacy' })
  },
  goTerms() {
    wx.navigateTo({ url: '/pages/legal/legal?type=terms' })
  },

  // ---- 注销 ----
  confirmDelete() {
    wx.showModal({
      title: '注销账号',
      content: '注销后将删除你的昵称、头像与登录信息，并作废你的邀请码；订单与邀请记录依法去标识化留存。注销后不可恢复，是否继续？',
      confirmText: '继续注销',
      confirmColor: '#e64545',
      success: (r) => { if (r.confirm) this.doDelete() }
    })
  },

  async doDelete() {
    wx.showLoading({ title: '正在注销', mask: true })
    let res
    try {
      res = await api.deleteAccount()
    } catch (e) {
      res = { ok: false, code: 'NETWORK_ERROR' }
    }
    wx.hideLoading()
    if (!res || !res.ok) {
      wx.showModal({
        title: '注销未完成',
        content: (res && (res.message || res.code)) || '请稍后重试',
        showCancel: false
      })
      return
    }
    // 服务端会话已删除，本地登录态一并清掉，避免拿着废 token 继续请求
    api.clearLogin()
    try { wx.removeStorageSync('ly_pending_invite') } catch (e) { /* 缓存不可用忽略 */ }
    wx.showToast({ title: '已注销', icon: 'success' })
    setTimeout(() => wx.reLaunch({ url: '/pages/index/index' }), 800)
  }
})
