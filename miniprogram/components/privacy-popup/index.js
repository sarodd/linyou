Component({
  properties: {
    show: { type: Boolean, value: false }
  },
  methods: {
    noop() {},
    onAgree() {
      // 这里由页面统一处理（同时 resolve onNeedPrivacyAuthorization）
      this.triggerEvent('agree')
    },
    onReject() {
      this.triggerEvent('reject')
    },
    openPrivacy() {
      wx.navigateTo({ url: '/pages/legal/legal?type=privacy' })
    },
    openTerms() {
      wx.navigateTo({ url: '/pages/legal/legal?type=terms' })
    }
  }
})
