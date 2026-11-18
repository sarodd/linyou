const api = require('../../utils/api')

Page({
  data: {
    id: '',
    loading: true,
    inv: null,
    commission: null,
    percent: 0,
    path: ''
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
      this.setData({
        inv: Object.assign({}, inv, { amountYuan: api.fen2yuan(inv.amountFen) }),
        commission: res.commission ? Object.assign({}, res.commission, { amountYuan: api.fen2yuan(res.commission.amountFen) }) : null,
        percent: Math.min(100, Math.round(inv.validCount / inv.target * 100)),
        path: '/pages/landing/landing?code=' + inv.code
      })
    }
    this.setData({ loading: false })
  },
  copyCode() {
    wx.setClipboardData({ data: this.data.inv.code || '', success: () => wx.showToast({ title: '邀请码已复制', icon: 'success' }) })
  },
  copyLink() {
    wx.setClipboardData({ data: this.data.path || '', success: () => wx.showToast({ title: '邀请路径已复制', icon: 'success' }) })
  },
  goOrders() {
    wx.switchTab({ url: '/pages/orders/orders' })
  },
  // 预览：模拟渠道退款回调，查看佣金到账状态流转
  async mockRefund(e) {
    const result = e.currentTarget.dataset.result
    if (!this.data.commission) return
    const res = await api.mockRefund({ commissionId: this.data.commission._id, result })
    if (res.ok) {
      wx.showToast({ title: result === 'fail' ? '已标记异常' : '退款已确认到账', icon: 'success' })
      this.setData({ loading: true })
      this.load()
    }
  }
})
