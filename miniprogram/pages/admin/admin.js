const api = require('../../utils/api')
const tab = require('../../utils/tab')

Page({
  data: {
    stats: null, ledger: [], loading: true, tab: 'overview',
    identity: null, noAccess: false, admins: [], newAdmin: '', adminsLoaded: false
  },
  async onShow() {
    tab.sync(this, tab.PATH.admin)
    const ok = await tab.requireAdmin(this)
    if (ok) this.load()
  },
  async load() {
    const [d, l, me] = await Promise.all([api.dashboard(), api.ledger(), api.whoAmI()])
    if (d.ok) {
      this.setData({ stats: Object.assign({}, d.stats, { achievedRate: d.stats.achievedRate + '%', verifyRate: d.stats.verifyRate + '%' }) })
    }
    if (l.ok) {
      this.setData({ ledger: l.ledger.map(x => Object.assign({}, x, {
        amountYuan: api.fen2yuan(x.amountFen),
        typeText: x.type === 'commission' ? '活动佣金' : '门店取消退款',
        statusText: { in_flight: '在途占用', paid_out: '已出款', exception: '异常' }[x.status] || x.status,
        timeText: api.fmtTime(x.createdAt)
      })) })
    }
    const diag = api.getLoginDiag() || {}
    if (me && me.ok) {
      this.setData({ identity: {
        modeText: me.isTest ? '预览身份（未登录）' : '真实微信登录',
        modeClass: me.isTest ? 'preview' : 'wx',
        openid: me.openid,
        roleText: me.role === 'admin' ? '管理员' : '普通用户',
        roleClass: me.role === 'admin' ? 'admin' : '',
        appSecretText: me.appSecretConfigured ? '已配置' : '未配置（登录不可用）',
        isAdminText: me.isAdmin ? '有运营权限' : '无运营权限',
        diagText: me.isTest ? (diag.reason || '登录未完成，已回退预览身份') : ''
      } })
    } else {
      // 连云端都没通（真机调试常见于 request 合法域名未配置）
      this.setData({ identity: {
        modeText: '身份获取失败',
        modeClass: 'preview',
        openid: '-',
        roleText: '-',
        roleClass: '',
        appSecretText: '-',
        isAdminText: '-',
        diagText: diag.reason || (me && me.message) || '无法连接云端，请检查 request 合法域名'
      } })
    }
    this.setData({ loading: false })
    if (this.data.tab === 'members') this.loadAdmins()
  },
  switchTab(e) {
    const t = e.currentTarget.dataset.tab
    this.setData({ tab: t })
    if (t === 'members' && !this.data.adminsLoaded) this.loadAdmins()
  },
  goConfig() { wx.navigateTo({ url: '/pages/config/config' }) },
  goHome() { wx.switchTab({ url: '/pages/index/index' }) },
  copyOpenid() {
    const id = this.data.identity && this.data.identity.openid
    if (!id || id === '-') return
    wx.setClipboardData({ data: id, success: () => wx.showToast({ title: '已复制 openid', icon: 'none' }) })
  },
  // 重新登录并弹窗给出明确结果（微信登录是静默的，平时不会有任何弹窗）
  async reLogin() {
    wx.showLoading({ title: '正在登录', mask: true })
    await api.reLogin()
    wx.hideLoading()
    await this.load()
    const diag = api.getLoginDiag() || {}
    wx.showModal({
      title: diag.status === 'ok' ? '登录成功' : '登录未完成',
      content: diag.status === 'ok'
        ? '已通过微信身份静默登录，无需授权弹窗。\n当前 openid 已在上方卡片显示。'
        : (diag.reason || '未知原因，请检查网络与 request 合法域名'),
      showCancel: false
    })
  },
  // ---- 管理员成员管理 ----
  async loadAdmins() {
    const r = await api.adminListAdmins()
    if (r.ok) {
      this.setData({
        admins: (r.admins || []).map(x => Object.assign({}, x, { timeText: api.fmtTime(x.createdAt) })),
        envAdmins: r.envAdmins || [],
        adminsLoaded: true
      })
    }
  },
  onNewAdmin(e) { this.setData({ newAdmin: e.detail.value }) },
  async addAdmin() {
    const openid = (this.data.newAdmin || '').trim()
    if (!openid) { wx.showToast({ title: '请填写 openid', icon: 'none' }); return }
    const r = await api.adminGrant({ openid })
    if (r.ok) {
      wx.showToast({ title: '已添加管理员', icon: 'success' })
      this.setData({ newAdmin: '' })
      await this.loadAdmins()
    } else {
      wx.showModal({ title: '添加失败', content: r.message || r.code || '未知错误', showCancel: false })
    }
  },
  removeAdmin(e) {
    const openid = e.currentTarget.dataset.openid
    wx.showModal({
      title: '移除管理员', content: '确认移除 ' + openid + ' 的管理员权限？',
      success: async (r) => {
        if (!r.confirm) return
        const res = await api.adminRevoke({ openid })
        if (res.ok) { wx.showToast({ title: '已移除', icon: 'success' }); await this.loadAdmins() }
        else wx.showModal({ title: '移除失败', content: res.message || res.code || '未知错误', showCancel: false })
      }
    })
  }
})
