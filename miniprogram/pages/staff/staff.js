const api = require('../../utils/api')
const tab = require('../../utils/tab')
const { parsePayload } = require('../../utils/verify-code')

const STATUS_TEXT = {
  paid: '待核销', verified: '已核销',
  cancel_processing: '取消处理中', cancelled: '已取消'
}
const ERR_TEXT = {
  WRONG_STORE: '非本门店订单',
  BAD_CODE: '核销码错误',
  CODE_EXPIRED: '核销码已过期，请顾客刷新后重扫',
  ORDER_NOT_PAYABLE: '订单状态不允许核销',
  ALREADY_VERIFIED: '该订单已核销',
  NOT_FOUND: '订单不存在',
  NOT_STAFF: '当前账号没有店员权限',
  NETWORK_ERROR: '网络异常，请重试'
}

Page({
  data: { orders: [], loading: true, notStaff: false, noAccess: false, scanning: false },
  async onShow() {
    tab.sync(this, tab.PATH.staff)
    const ok = await tab.requireAdmin(this)
    if (ok) this.load()
  },
  async load() {
    const res = await api.staffOrders()
    if (res.ok) {
      const orders = res.orders.map(o => Object.assign({}, o, {
        statusText: STATUS_TEXT[o.status] || o.status,
        amountYuan: api.fen2yuan(o.amountFen)
      }))
      this.setData({ orders, notStaff: false })
    } else if (res.code === 'NOT_STAFF') {
      this.setData({ notStaff: true })
    }
    this.setData({ loading: false })
  },
  // 真正的相机扫码：识别顾客订单页上的核销二维码
  async scanVerify() {
    if (this.data.scanning) return
    this.setData({ scanning: true })
    const raw = await new Promise(resolve => {
      wx.scanCode({
        onlyFromCamera: false,               // 允许从相册选图，方便测试/截图核销
        scanType: ['qrCode', 'barCode'],
        success: r => resolve(r.result || ''),
        fail: () => resolve('')              // 用户取消或相机不可用
      })
    })
    this.setData({ scanning: false })
    if (!raw) return

    const parsed = parsePayload(raw)
    if (!parsed) {
      wx.showModal({
        title: '无法识别',
        content: '这不是本小程序的核销二维码。请让顾客进入「我的订单 → 订单详情」，点开核销码后再扫。',
        showCancel: false
      })
      return
    }

    const hit = this.data.orders.filter(o => o._id === parsed.orderId)[0]
    const desc = hit
      ? hit.goodsName + '\n订单号 ' + hit.orderNo + '\n实付 ¥' + hit.amountYuan
      : '该订单不在当前门店的待办列表中'
    const ok = await this.confirm('确认核销', desc + '\n\n核销后不可撤销，是否继续？')
    if (!ok) return
    await this.doVerify(parsed.orderId, parsed.code)
  },
  // 相机不可用时的兜底：手输 6 位码
  async manualVerify(e) {
    const id = e.currentTarget.dataset.id
    const code = await this.promptCode('手动核销', '请输入顾客出示的 6 位核销码')
    if (!code) return
    if (!/^\d{6}$/.test(code)) {
      wx.showToast({ title: '请输入 6 位数字核销码', icon: 'none' })
      return
    }
    await this.doVerify(id, code)
  },
  async doVerify(orderId, code) {
    wx.showLoading({ title: '核销中', mask: true })
    let res
    try {
      res = await api.staffVerify({ orderId, code })
    } catch (e) {
      res = { ok: false, code: 'NETWORK_ERROR' }
    } finally {
      wx.hideLoading()
    }
    if (res && res.ok) {
      if (wx.vibrateShort) wx.vibrateShort({ type: 'medium' })
      wx.showToast({ title: '核销成功', icon: 'success' })
      this.load()
      return true
    }
    wx.showToast({ title: ERR_TEXT[(res && res.code)] || '核销失败', icon: 'none', duration: 2500 })
    return false
  },
  async cancel(e) {
    const id = e.currentTarget.dataset.id
    const confirm = await this.confirm('取消订单', '确认办理未核销取消？将按规则计算可退金额')
    if (!confirm) return
    const res = await api.staffCancel({ orderId: id })
    if (res.ok) {
      wx.showToast({ title: '已办理，可退 ¥' + api.fen2yuan(res.refundableFen), icon: 'none', duration: 3000 })
      this.load()
    } else {
      wx.showToast({ title: '办理失败：' + (res.code || ''), icon: 'none' })
    }
  },
  promptCode(title, placeholder) {
    return new Promise(resolve => {
      wx.showModal({
        title, editable: true, placeholderText: placeholder,
        success: (r) => resolve(r.confirm ? (r.content || '').trim() : null)
      })
    })
  },
  confirm(title, content) {
    return new Promise(resolve => {
      wx.showModal({ title, content, success: (r) => resolve(!!r.confirm) })
    })
  },
  goHome() { wx.switchTab({ url: '/pages/index/index' }) }
})
