Page({
  data: {
    code: '',
    activityName: '',
    priceYuan: ''
  },
  onLoad(options) {
    const code = options.code || ''
    this.setData({ code })
    // 带参进入：展示邀请归因，引导去活动页确认下单（邀请码带入）
    wx.setNavigationBarTitle({ title: '好友邀请' })
  },
  goOrder() {
    wx.redirectTo({ url: '/pages/activity/activity?code=' + this.data.code })
  },
  goHome() {
    wx.switchTab({ url: '/pages/index/index' })
  }
})
