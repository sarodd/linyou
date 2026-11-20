const api = require('../../utils/api')
const qrcode = require('../../utils/qrcode')
const { buildPayload } = require('../../utils/verify-code')

const STATUS_TEXT = {
  pending_pay: '待支付', paid: '待核销', verified: '已核销',
  cancel_processing: '取消处理中', cancelled: '已取消'
}
const CM_TEXT = {
  pending: '待提交', processing: '发放中', paid: '已到账', exception: '异常'
}

// 画布 CSS 尺寸（px），与 wxss 中 .qr-canvas 保持一致
const QR_SIZE = 220

Page({
  data: {
    id: '', loading: true, order: null, invitation: null, commission: null,
    verifyCode: null, countdownText: '', paying: false
  },
  onLoad(options) {
    this.setData({ id: options.id || '' })
    this.load()
  },
  onUnload() { this.stopCountdown() },

  // 待支付订单继续付款：用户取消支付后不能就此卡住，
  // 否则 createOrder 会因「已有订单」拒绝再次下单，等于永久无法购买。
  async payNow() {
    if (this.data.paying) return
    this.setData({ paying: true })
    const pre = await api.prepay({ orderId: this.data.id })
    if (!pre.ok) {
      this.setData({ paying: false })
      wx.showModal({ title: '无法发起支付', content: pre.message || pre.code || '未知错误', showCancel: false })
      return
    }
    const p = pre.payParams
    wx.requestPayment({
      timeStamp: p.timeStamp,
      nonceStr: p.nonceStr,
      package: p.package,
      signType: p.signType,
      paySign: p.paySign,
      success: async () => {
        // 客户端成功不等于入账，以服务端查单为准
        for (let i = 0; i < 3; i++) {
          const q = await api.payQuery({ orderId: this.data.id })
          if (q.ok && q.paid) break
          if (i < 2) await new Promise(r => setTimeout(r, 1500))
        }
        this.setData({ paying: false })
        this.load()
      },
      fail: (err) => {
        this.setData({ paying: false })
        const msg = String((err && err.errMsg) || '')
        if (msg.indexOf('cancel') >= 0) return
        wx.showToast({ title: '支付未完成', icon: 'none' })
      }
    })
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
      // 订单已不是待核销状态时，页面上的码立即失效，避免误导
      if (res.order.status !== 'paid' && this.data.verifyCode) {
        this.stopCountdown()
        this.setData({ verifyCode: null, countdownText: '' })
      }
    }
    this.setData({ loading: false })
  },
  async genCode() {
    const res = await api.genVerifyCode({ orderId: this.data.id })
    if (res.ok) {
      this.setData({ verifyCode: res.code }, () => {
        this.drawQr(buildPayload(this.data.id, res.code))
        this.startCountdown(res.expireAt)
      })
    } else {
      const map = { ORDER_NOT_PAYABLE: '仅待核销订单可生成核销码' }
      wx.showToast({ title: map[res.code] || '生成失败', icon: 'none' })
    }
  },
  // 把核销凭证画成二维码，店员用「扫码核销」直接扫
  drawQr(payload, tries) {
    const attempt = tries || 0
    let qr
    try {
      qr = qrcode(0, 'M')
      qr.addData(payload)
      qr.make()
    } catch (e) {
      wx.showToast({ title: '二维码生成失败，请点刷新', icon: 'none' })
      return
    }
    const count = qr.getModuleCount()
    wx.createSelectorQuery().select('#qrCanvas').fields({ node: true, size: true }).exec((res) => {
      const item = res && res[0]
      const canvas = item && item.node
      // 节点可能还没挂载（首次 setData 之后），重试几次
      if (!canvas) {
        if (attempt < 3) setTimeout(() => this.drawQr(payload, attempt + 1), 80)
        return
      }
      const ctx = canvas.getContext('2d')
      const dpr = (wx.getWindowInfo ? wx.getWindowInfo().pixelRatio : wx.getSystemInfoSync().pixelRatio) || 2
      canvas.width = QR_SIZE * dpr
      canvas.height = QR_SIZE * dpr
      if (ctx.setTransform) ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.scale(dpr, dpr)

      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, QR_SIZE, QR_SIZE)

      const quiet = 4 // 二维码四周留白（模块数），留太少会扫不出来
      const module = Math.floor(QR_SIZE / (count + quiet * 2))
      const offset = (QR_SIZE - module * count) / 2
      ctx.fillStyle = '#000000'
      for (let r = 0; r < count; r++) {
        for (let c = 0; c < count; c++) {
          if (!qr.isDark(r, c)) continue
          ctx.fillRect(
            Math.round(offset + c * module),
            Math.round(offset + r * module),
            Math.ceil(module),
            Math.ceil(module)
          )
        }
      }
    })
  },
  startCountdown(expireAt) {
    this.stopCountdown()
    if (!expireAt) return
    const tick = () => {
      const left = Math.max(0, Math.round((expireAt - Date.now()) / 1000))
      if (left <= 0) {
        this.stopCountdown()
        this.setData({ verifyCode: null, countdownText: '' })
        wx.showToast({ title: '核销码已过期，请重新生成', icon: 'none' })
        return
      }
      const m = Math.floor(left / 60)
      const s = left % 60
      this.setData({ countdownText: m + ':' + (s < 10 ? '0' + s : s) + ' 后失效' })
    }
    tick()
    this._timer = setInterval(tick, 1000)
  },
  stopCountdown() {
    if (this._timer) {
      clearInterval(this._timer)
      this._timer = null
    }
  },
  goInvite() {
    if (this.data.invitation) {
      wx.navigateTo({ url: '/pages/invite/invite?id=' + this.data.invitation._id })
    }
  }
})
