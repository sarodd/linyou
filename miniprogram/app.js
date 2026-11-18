// app.js
App({
  globalData: {
    // CloudBase 国内站环境（linyougo-dev）
    env: 'linyougo-dev-d0gkgswl0504c86e2',
    // HTTP 访问服务地址：小程序通过 wx.request 直接调用云端 api 云函数，
    // 不依赖微信侧「云开发」开通（该 AppID 未认证，无法开通微信云开发）
    apiBase: 'https://linyougo-dev-d0gkgswl0504c86e2-1534792212.ap-shanghai.app.tcloudbase.com/api',
    // 活动海报图片地址（GET，云函数从数据库读 base64 输出 image/jpeg）
    posterUrl: 'https://linyougo-dev-d0gkgswl0504c86e2-1534792212.ap-shanghai.app.tcloudbase.com/api?action=getPosterRaw',
    // HTTP 调用无微信上下文：优先走真实微信登录（token），登录不可用时回退固定预览身份
    previewOpenid: 'preview',
    token: null,            // 自定义登录态（wx.login -> code2session 签发，存本地缓存）
    loginMode: 'preview',   // 'wx' = 真实微信身份；'preview' = 预览兜底
    myOpenid: null,         // 当前微信号对应的 openid
    loginDiag: null,        // 登录诊断（成功/失败原因），运营页可见
    openid: null,
    // 角色（两档）：'user' 普通用户 | 'admin' 管理员，由云端 whoAmI 判定后写入
    role: 'user',
    identity: null,         // whoAmI 完整结果
    // 运营配置版本标记：配置页保存成功后递增；首页 onShow 检测到变化即重载，保证海报/活动秒级更新
    configVersion: 0
  },
  onLaunch: function () {
    // 仍保留 wx.cloud.init，兼容将来微信侧开通云开发后的 callFunction 路径；
    // 当前业务调用统一走 HTTP（见 utils/api.js），不依赖此处。
    if (wx.cloud) {
      try {
        wx.cloud.init({ env: this.globalData.env, traceUser: true })
      } catch (e) {
        console.warn('wx.cloud.init skipped:', e.message)
      }
    }
  }
})
