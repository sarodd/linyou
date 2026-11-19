const api = require('../../utils/api')

Page({
  data: {
    id: '',
    loading: true,
    inv: null,
    commission: null,
    percent: 0,
    shareText: ''
  },
  onLoad(options) {
    const id = options.id || ''
    this.setData({ id })
    if (!id) { this.setData({ loading: false }); return }
    this.load()
  },
  async load() {
    const res = await api.getInvitation({ invitationId: this.data.id })
    if (res.ok) {
      const inv = res.invitation
      const left = Math.max(0, (inv.target || 0) - (inv.validCount || 0))
      this.setData({
        inv: Object.assign({}, inv, { amountYuan: api.fen2yuan(inv.amountFen) }),
        commission: res.commission ? Object.assign({}, res.commission, { amountYuan: api.fen2yuan(res.commission.amountFen) }) : null,
        percent: Math.min(100, Math.round(inv.validCount / inv.target * 100)),
        shareText: left > 0
          ? `一起拼单，还差 ${left} 人。邀请码：${inv.code}`
          : `我这边已经凑齐了，邀请码：${inv.code}`
      })
    }
    this.setData({ loading: false })
  },
  copyCode() {
    wx.setClipboardData({ data: this.data.inv.code || '', success: () => wx.showToast({ title: '邀请码已复制', icon: 'success' }) })
  },
  copyText() {
    wx.setClipboardData({ data: this.data.shareText || '', success: () => wx.showToast({ title: '邀请文案已复制', icon: 'success' }) })
  },
  goOrders() {
    wx.switchTab({ url: '/pages/orders/orders' })
  },
  // 分享卡片：好友点击后进入 landing，邀请码自动带入并暂存，后续下单自动绑定
  onShareAppMessage() {
    const inv = this.data.inv || {}
    if (!inv.code) {
      return { title: '邻友购 · 一起拼单更划算', path: '/pages/index/index' }
    }
    const left = Math.max(0, (inv.target || 0) - (inv.validCount || 0))
    return {
      title: left > 0 ? `一起来拼单，还差 ${left} 人` : '我这边已经凑齐了，一起来看看',
      path: '/pages/landing/landing?code=' + inv.code
    }
  }
})
