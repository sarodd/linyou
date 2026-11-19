const api = require('../../utils/api')

Page({
  data: {
    activity: null,
    stores: [],
    storeIndex: 0,
    inviteCode: '',
    submitting: false
  },
  onLoad(options) {
    // 优先用页面参数；没有则用分享卡片暂存的邀请码（自动带参，无需手输）
    const code = (options && options.code) || getApp().getPendingInviteCode()
    if (code) this.setData({ inviteCode: String(code).toUpperCase() })
    this.load()
  },
  async load() {
    const res = await api.getActivity()
    if (res.ok) {
      this.setData({
        activity: Object.assign({}, res.activity, { priceYuan: api.fen2yuan(res.activity.priceFen) }),
        stores: res.stores
      })
    }
  },
  onStoreChange(e) {
    this.setData({ storeIndex: Number(e.detail.value) })
  },
  onInviteInput(e) {
    this.setData({ inviteCode: e.detail.value })
  },
  async submit() {
    if (this.data.submitting) return
    const store = this.data.stores[this.data.storeIndex]
    if (!store) {
      wx.showToast({ title: '暂无可下单门店', icon: 'none' })
      return
    }
    this.setData({ submitting: true })
    wx.showLoading({ title: '提交中' })
    const res = await api.createOrder({ storeId: store._id, inviteCode: this.data.inviteCode })
    wx.hideLoading()
    this.setData({ submitting: false })
    if (!res.ok) {
      const map = {
        ALREADY_ORDERED: '本活动你已有订单', OUT_OF_STOCK: '该门店已售罄',
        INVALID_INVITE_CODE: '邀请码无效', SELF_INVITE: '不能邀请自己',
        ACTIVITY_ENDED: '活动已结束', ORDER_DEADLINE_PASSED: '已过下单截止时间',
        INVITE_CLOSED: '该邀请已结束', INVITE_DEADLINE_PASSED: '该邀请已过截止时间',
        NO_ACTIVITY: '活动还没有配置'
      }
      // 邀请码失效时清掉本地归因与输入框，否则用户会被一个死码卡住无法下单
      if (['INVALID_INVITE_CODE', 'INVITE_CLOSED', 'INVITE_DEADLINE_PASSED', 'SELF_INVITE'].includes(res.code)) {
        getApp().clearPendingInviteCode()
        this.setData({ inviteCode: '' })
      }
      wx.showToast({ title: map[res.code] || '下单失败', icon: 'none' })
      return
    }
    // 下单成功 -> 模拟支付 -> 跳转邀请进度
    wx.showLoading({ title: '模拟支付中' })
    const pay = await api.mockPay({ orderId: res.order._id })
    wx.hideLoading()
    if (!pay.ok) {
      const payMap = {
        OUT_OF_STOCK: '该门店刚售罄，请换一家门店重新下单',
        MOCK_PAY_DISABLED: '演示支付已关闭，等待接入微信支付',
        PAY_ALREADY_PROCESSED: '该订单已处理，请到订单页查看'
      }
      wx.showToast({ title: payMap[pay.code] || '支付处理异常', icon: 'none' })
      return
    }
    // 归因已落到订单上，本地暂存可以清掉，避免影响下一单
    getApp().clearPendingInviteCode()
    wx.redirectTo({ url: `/pages/invite/invite?id=${pay.invitationId}` })
  }
})
