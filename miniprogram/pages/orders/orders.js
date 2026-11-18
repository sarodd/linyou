const api = require('../../utils/api')
const tab = require('../../utils/tab')

const STATUS_TEXT = {
  pending_pay: '待支付', paid: '待核销', verified: '已核销',
  cancel_processing: '取消处理中', cancelled: '已取消'
}

Page({
  data: {
    orders: [], loading: true,
    canSelfGrant: false, granting: false
  },
  onShow() {
    tab.sync(this, tab.PATH.orders)
    this.load()
    this.loadIdentity()
  },
  async load() {
    const res = await api.getMyOrders()
    if (res.ok) {
      const orders = res.orders.map(o => Object.assign({}, o, {
        statusText: STATUS_TEXT[o.status] || o.status,
        amountYuan: api.fen2yuan(o.amountFen),
        createdText: api.fmtTime(o.createdAt)
      }))
      this.setData({ orders })
    }
    this.setData({ loading: false })
  },
  // 只在「系统还没有任何管理员」时暴露自举入口；身份信息不在本页展示
  async loadIdentity() {
    const me = await api.refreshRole().then(() => api.getIdentity())
    if (!me) return
    this._openid = me.openid || ''
    this.setData({ canSelfGrant: !!me.canSelfGrant && !!this._openid })
  },
  // 首位管理员自举：仅当系统还没有任何管理员、且当前是真实微信身份时可用
  grantSelf() {
    if (!this.data.canSelfGrant || !this._openid) return
    wx.showModal({
      title: '设为管理员',
      content: '当前系统还没有管理员。将把你的微信账号设为首位管理员，之后只有管理员能添加其他成员。确认吗？',
      success: async (r) => {
        if (!r.confirm) return
        this.setData({ granting: true })
        const res = await api.adminGrant({ openid: this._openid })
        this.setData({ granting: false })
        if (res.ok) {
          wx.showToast({ title: '已设为首位管理员', icon: 'success' })
          getApp().globalData.role = 'admin'
          this.setData({ canSelfGrant: false })
          tab.sync(this, tab.PATH.orders)
        } else {
          wx.showModal({ title: '设置失败', content: res.message || res.code || '未知错误', showCancel: false })
        }
      }
    })
  },
  goDetail(e) {
    wx.navigateTo({ url: '/pages/order-detail/order-detail?id=' + e.currentTarget.dataset.id })
  },
  goHome() {
    wx.switchTab({ url: '/pages/index/index' })
  }
})
