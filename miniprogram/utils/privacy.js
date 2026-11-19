// 隐私授权统一处理
// 微信要求：调用头像/昵称/位置等隐私接口前，必须先获得《小程序用户隐私保护指引》授权。
// 未授权时微信会回调 onNeedPrivacyAuthorization，页面弹出 privacy-popup 组件引导用户同意。
// 用法：
//   onLoad() { privacy.attach(this) }
//   onUnload() { privacy.detach(this) }
//   页面上绑 bind:agree="onPrivacyAgree" bind:reject="onPrivacyReject"
//   onPrivacyAgree() { privacy.agree(this) }
//   onPrivacyReject() { privacy.reject(this, '提示文案') }

function attach(page) {
  page.setData({ showPrivacy: false })
  if (wx.onNeedPrivacyAuthorization) {
    page._privacyHandler = (resolve) => {
      page._privacyResolve = resolve
      page.setData({ showPrivacy: true })
    }
    wx.onNeedPrivacyAuthorization(page._privacyHandler)
  }
  // 进页面先查一次：已配置隐私指引但用户还没同意时，主动给出入口
  if (wx.getPrivacySetting) {
    wx.getPrivacySetting({
      success: (r) => {
        if (r && r.needAuthorization) page.setData({ showPrivacy: true })
      }
    })
  }
}

function detach(page) {
  if (wx.offNeedPrivacyAuthorization && page._privacyHandler) {
    wx.offNeedPrivacyAuthorization(page._privacyHandler)
  }
  page._privacyHandler = null
  page._privacyResolve = null
}

// 注意：必须把 { buttonId: 'agree-btn', event: 'agree' } 回传给微信，
// buttonId 对应组件里 open-type="agreePrivacyAuthorization" 的按钮 id。
function agree(page) {
  page.setData({ showPrivacy: false })
  const resolve = page._privacyResolve
  page._privacyResolve = null
  if (resolve) resolve({ buttonId: 'agree-btn', event: 'agree' })
}

function reject(page, tip) {
  page.setData({ showPrivacy: false })
  const resolve = page._privacyResolve
  page._privacyResolve = null
  if (resolve) resolve({ event: 'disagree' })
  if (tip) wx.showToast({ title: tip, icon: 'none' })
}

module.exports = { attach, detach, agree, reject }
