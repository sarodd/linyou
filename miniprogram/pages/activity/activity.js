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
    // 下单成功 -> 拉起微信支付；真实支付未配置时回落到演示支付
    const done = await this.payOrder(res.order._id)
    if (!done) return
    // 归因已落到订单上，本地暂存可以清掉，避免影响下一单
    getApp().clearPendingInviteCode()
    wx.redirectTo({ url: `/pages/invite/invite?id=${done.invitationId}` })
  },

  // 支付：优先真实微信支付，未配置则演示支付
  // 注意：客户端 requestPayment 的 success 只代表「用户付了」，
  // 订单是否真的入账必须以服务端查单结果为准，否则可能被改包的客户端骗成已支付。
  async payOrder(orderId) {
    const pre = await api.prepay({ orderId })

    if (!pre.ok && pre.code !== 'PAY_NOT_CONFIGURED') {
      // 登录态问题文案较长，用弹窗而不是 toast，否则被截断后用户看不懂
      if (pre.code === 'NEED_WX_LOGIN' || pre.code === 'NO_WX_LOGIN') {
        wx.showModal({
          title: '需要微信登录',
          content: pre.message || '请退出小程序重新进入后再支付',
          showCancel: false
        })
        return null
      }
      const map = {
        OUT_OF_STOCK: '该门店刚售罄，请重新下单',
        PAY_ALREADY_PROCESSED: '该订单已处理，请到订单页查看',
        FORBIDDEN: '订单属于之前的登录身份，请返回重新下单',
        WXPAY_ERROR: '支付下单失败，请稍后再试'
      }
      wx.showToast({ title: map[pre.code] || pre.message || '支付下单失败', icon: 'none' })
      return null
    }

    // 真实支付
    if (pre.ok) {
      const p = pre.payParams
      const canceled = await new Promise((resolve) => {
        wx.requestPayment({
          timeStamp: p.timeStamp,
          nonceStr: p.nonceStr,
          package: p.package,
          signType: p.signType,
          paySign: p.paySign,
          success: () => resolve(false),
          fail: (err) => resolve(String((err && err.errMsg) || '').indexOf('cancel') >= 0 ? 'cancel' : 'fail')
        })
      })
      if (canceled === 'cancel') return null

      // 无论客户端成功还是失败，都以服务端查单为准（回调可能还在路上）
      for (let i = 0; i < 3; i++) {
        const q = await api.payQuery({ orderId })
        if (q.ok && q.paid) return { invitationId: q.invitationId }
        if (i < 2) await new Promise(r => setTimeout(r, 1500))
      }
      wx.showModal({
        title: '支付结果确认中',
        content: '钱已付出但订单还没同步成功，请到「我的订单」下拉刷新，或稍后重试。如长时间未到账请联系门店。',
        showCancel: false
      })
      return null
    }

    // 演示支付
    wx.showLoading({ title: '模拟支付中' })
    const pay = await api.mockPay({ orderId })
    wx.hideLoading()
    if (!pay.ok) {
      const payMap = {
        OUT_OF_STOCK: '该门店刚售罄，请换一家门店重新下单',
        MOCK_PAY_DISABLED: '微信支付尚未配置，暂时无法支付',
        PAY_ALREADY_PROCESSED: '该订单已处理，请到订单页查看'
      }
      wx.showToast({ title: payMap[pay.code] || '支付处理异常', icon: 'none' })
      return null
    }
    return { invitationId: pay.invitationId }
  }
})
