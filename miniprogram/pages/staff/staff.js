const api = require('../../utils/api')
const tab = require('../../utils/tab')

const STATUS_TEXT = {
  paid: '待核销', verified: '已核销',
  cancel_processing: '取消处理中', cancelled: '已取消'
}

Page({
  data: { orders: [], loading: true, notStaff: false, noAccess: false },
  async onShow() {
    tab.sync(this, tab.PATH.staff)
    const ok = await tab.requireAdmin(this)
    if (ok) this.load()
  },
  async load() {
    const res = await api.staffOrders()
    if (res.ok) {
      const orders = res.orders.map(o => Object.assign({}, o, {
        statusText: STATUS_TEXT[o.status] || o.status,
        amountYuan: api.fen2yuan(o.amountFen)
      }))
      this.setData({ orders, notStaff: false })
    } else if (res.code === 'NOT_STAFF') {
      this.setData({ notStaff: true })
    }
    this.setData({ loading: false })
  },
  async verify(e) {
    const id = e.currentTarget.dataset.id
    const code = await this.promptCode('核销', '请输入用户出示的6位核销码')
    if (!code) return
    const res = await api.staffVerify({ orderId: id, code })
    if (res.ok) { wx.showToast({ title: '核销成功', icon: 'success' }); this.load() }
    else {
      const map = { WRONG_STORE: '非本门店订单', BAD_CODE: '核销码错误', CODE_EXPIRED: '核销码已过期', ORDER_NOT_PAYABLE: '订单状态不允许核销', ALREADY_VERIFIED: '已核销' }
      wx.showToast({ title: map[res.code] || '核销失败', icon: 'none' })
    }
  },
  async cancel(e) {
    const id = e.currentTarget.dataset.id
    const confirm = await this.confirm('取消订单', '确认办理未核销取消？将按规则计算可退金额')
    if (!confirm) return
    const res = await api.staffCancel({ orderId: id })
    if (res.ok) {
      wx.showToast({ title: '已办理，可退 ¥' + api.fen2yuan(res.refundableFen), icon: 'none', duration: 3000 })
      this.load()
    } else {
      wx.showToast({ title: '办理失败：' + (res.code || ''), icon: 'none' })
    }
  },
  promptCode(title, placeholder) {
    return new Promise(resolve => {
      wx.showModal({
        title, editable: true, placeholderText: placeholder,
        success: (r) => resolve(r.confirm ? (r.content || '').trim() : null)
      })
    })
  },
  confirm(title, content) {
    return new Promise(resolve => {
      wx.showModal({ title, content, success: (r) => resolve(!!r.confirm) })
    })
  },
  goHome() { wx.switchTab({ url: '/pages/index/index' }) }
})
