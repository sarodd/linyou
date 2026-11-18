const api = require('../../utils/api')

const STATUS_TEXT = {
  pending_pay: '待支付', paid: '待核销', verified: '已核销',
  cancel_processing: '取消处理中', cancelled: '已取消'
}
const CM_TEXT = {
  pending: '待提交', processing: '发放中', paid: '已到账', exception: '异常'
}

Page({
  data: {
    id: '', loading: true, order: null, invitation: null, commission: null,
    verifyCode: null
  },
  onLoad(options) {
    this.setData({ id: options.id || '' })
    this.load()
  },
  async load() {
    const res = await api.getOrderDetail({ orderId: this.data.id })
    if (res.ok) {
      this.setData({
        order: Object.assign({}, res.order, {
          statusText: STATUS_TEXT[res.order.status] || res.order.status,
          amountYuan: api.fen2yuan(res.order.amountFen),
          paidText: api.fmtTime(res.order.paidAt),
          storeAddress: ''
        }),
        invitation: res.invitation,
        commission: res.commission ? Object.assign({}, res.commission, {
          statusText: CM_TEXT[res.commission.status] || res.commission.status,
          amountYuan: api.fen2yuan(res.commission.amountFen)
        }) : null
      })
    }
    this.setData({ loading: false })
  },
  async genCode() {
    const res = await api.genVerifyCode({ orderId: this.data.id })
    if (res.ok) {
      this.setData({ verifyCode: res.code })
    } else {
      const map = { ORDER_NOT_PAYABLE: '仅待核销订单可生成核销码' }
      wx.showToast({ title: map[res.code] || '生成失败', icon: 'none' })
    }
  },
  goInvite() {
    if (this.data.invitation) {
      wx.navigateTo({ url: '/pages/invite/invite?id=' + this.data.invitation._id })
    }
  }
})
