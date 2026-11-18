const api = require('../../utils/api')
const tab = require('../../utils/tab')

Page({
  data: {
    loading: true,
    activity: null,
    stores: [],
    error: null
  },
  onLoad() {
    this.load()
  },
  // 首页是 tab 页，从配置页返回时 onLoad 不会再触发；
  // 检测到配置版本变化（或首次进入）就重载，保证海报/活动配置立即生效
  onShow() {
    tab.sync(this, tab.PATH.index)
    const v = getApp().globalData.configVersion || 0
    if (this._loaded && this._lastVersion !== v) {
      this.load()
    }
    this._lastVersion = v
  },
  async load() {
    this.setData({ loading: true, error: null })
    let res = await api.getActivity()
    const firstErr = (!res.ok) ? res : null
    // 只在云端确实还没有活动时初始化；网络抖动/服务异常一律不碰线上配置
    if (!res.ok && res.code === 'NO_ACTIVITY') {
      await api.seed()
      res = await api.getActivity()
    }
    if (res.ok && res.activity) {
      const app = getApp()
      const posterSrc = res.activity.posterCloud
        ? (app.globalData.posterUrl + '&t=' + Date.now())
        : (res.activity.poster || '/images/poster.jpg')
      this.setData({
        activity: Object.assign({}, res.activity, {
          priceYuan: api.fen2yuan(res.activity.priceFen),
          originalPriceYuan: api.fen2yuan(res.activity.originalPriceFen || res.activity.priceFen),
          orderDeadlineText: api.fmtTime(res.activity.orderDeadline).slice(0, 10),
          inviteDeadlineText: api.fmtTime(res.activity.inviteDeadline).slice(0, 10),
          posterSrc: posterSrc
        }),
        stores: res.stores || [],
        error: null
      })
      this._loaded = true
      this._lastVersion = getApp().globalData.configVersion || 0
    } else {
      const e = (res && !res.activity && !res.code) ? { code: 'NO_DATA', message: '云端未返回活动数据' } : (firstErr || res)
      this.setData({
        error: {
          code: (e && e.code) || 'UNKNOWN',
          message: (e && (e.message || e.errMsg)) || '云端数据加载失败'
        }
      })
    }
    this.setData({ loading: false })
  },
  previewPoster() {
    wx.previewImage({ urls: [this.data.activity.posterSrc || '/images/poster.jpg'] })
  },
  goActivity() {
    wx.navigateTo({ url: '/pages/activity/activity' })
  },
  onPullDownRefresh() {
    this.load().then(() => wx.stopPullDownRefresh())
  }
})
