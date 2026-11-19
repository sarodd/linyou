const api = require('../../utils/api')

Page({
  data: {
    code: '',
    activityName: '',
    goodsName: '',
    priceYuan: ''
  },
  onLoad(options) {
    const code = String((options && options.code) || '').toUpperCase()
    this.setData({ code })
    // 记下归因：即使用户不点「接受邀请」，之后从首页进入下单也能自动带上邀请码
    if (code) getApp().captureInviteCode(code)
    // 带参进入：展示邀请归因，引导去活动页确认下单（邀请码带入）
    wx.setNavigationBarTitle({ title: '好友邀请' })
    this.loadActivity()
  },
  async loadActivity() {
    const res = await api.getActivity()
    if (!res.ok || !res.activity) return
    const a = res.activity
    this.setData({
      activityName: a.name || '',
      goodsName: a.goodsName || '',
      priceYuan: api.fen2yuan(a.priceFen)
    })
  },
  goOrder() {
    wx.redirectTo({ url: '/pages/activity/activity?code=' + this.data.code })
  },
  goHome() {
    wx.switchTab({ url: '/pages/index/index' })
  }
})
