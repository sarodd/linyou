const api = require('../../utils/api')
const tab = require('../../utils/tab')
const privacy = require('../../utils/privacy')

// 毫秒时间戳 -> { d: 'YYYY-MM-DD', t: 'HH:mm' }（picker 所需格式）
const splitDeadline = (ts) => {
  if (!ts) return { d: '', t: '' }
  const d = new Date(ts)
  const p = (x) => (x < 10 ? '0' + x : '' + x)
  return {
    d: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`,
    t: `${p(d.getHours())}:${p(d.getMinutes())}`
  }
}
// 'YYYY-MM-DD' + 'HH:mm' -> 毫秒时间戳（日期为空表示不限制，返回 0）
const joinDeadline = (d, t) => {
  if (!d) return 0
  const v = new Date(`${d}T${t || '00:00'}`).getTime()
  return isNaN(v) ? 0 : v
}

Page({
  data: {
    tab: 'activity',
    loading: true,
    saving: false,
    toast: '',
    // 活动/商品表单
    form: {
      brand: '', name: '', subtitle: '', goodsName: '', spec: '',
      priceYuan: '', originalPriceYuan: '', inviteTarget: 3,
      status: 'ongoing'
    },
    // 活动截止时间（日期/时间分开，供 picker 使用）
    orderDate: '', orderTime: '',
    inviteDate: '', inviteTime: '',
    verifyDate: '', verifyTime: '',
    // 门店
    stores: [],
    storeEdit: null,
    // 海报
    posterCloud: false,
    posterSrc: '',
    noAccess: false,
    showPrivacy: false
  },

  async onLoad() {
    const ok = await tab.requireAdmin(this)
    if (ok) this.load()
  },
  // 隐私回调是全局单例：只在当前可见页注册，离开即解绑，避免串页
  onShow() {
    privacy.attach(this)
  },
  onHide() {
    privacy.detach(this)
  },
  onUnload() {
    privacy.detach(this)
  },
  // 地图选点前需先同意隐私政策
  onPrivacyAgree() {
    privacy.agree(this)
  },
  onPrivacyReject() {
    privacy.reject(this, '未同意隐私政策，无法使用地图选点')
  },
  goHome() { wx.switchTab({ url: '/pages/index/index' }) },

  // 标记配置已变更：首页 onShow 检测到后自动重载（海报/活动/门店均适用）
  bumpVersion() {
    const app = getApp()
    app.globalData.configVersion = Date.now()
  },

  async load() {
    this.setData({ loading: true })
    const res = await api.adminGetConfig()
    if (res.ok && res.activity) {
      const a = res.activity
      const app = getApp()
      const o = splitDeadline(a.orderDeadline)
      const inv = splitDeadline(a.inviteDeadline)
      const vf = splitDeadline(a.verifyDeadline)
      this.setData({
        form: {
          brand: a.brand || '',
          name: a.name || '',
          subtitle: a.subtitle || '',
          goodsName: a.goodsName || '',
          spec: a.spec || '',
          priceYuan: api.fen2yuan(a.priceFen),
          originalPriceYuan: api.fen2yuan(a.originalPriceFen || a.priceFen),
          inviteTarget: a.inviteTarget || 3,
          status: a.status || 'ongoing'
        },
        orderDate: o.d, orderTime: o.t,
        inviteDate: inv.d, inviteTime: inv.t,
        verifyDate: vf.d, verifyTime: vf.t,
        stores: res.stores || [],
        posterCloud: !!a.posterCloud,
        // 用本地时间戳破坏图片缓存，确保上传新海报后立即显示（不依赖云端版本字段）
        posterSrc: a.posterCloud ? (app.globalData.posterUrl + '&t=' + Date.now()) : (a.poster || '/images/poster.jpg')
      })
    } else {
      this.showToast('加载配置失败：' + (res.code || '未知错误'))
    }
    this.setData({ loading: false })
  },

  switchTab(e) { this.setData({ tab: e.currentTarget.dataset.tab }) },
  showToast(msg) {
    this.setData({ toast: msg })
    clearTimeout(this._toastTimer)
    this._toastTimer = setTimeout(() => this.setData({ toast: '' }), 2500)
  },
  onField(e) {
    const key = e.currentTarget.dataset.key
    this.setData({ ['form.' + key]: e.detail.value })
  },

  // 截止时间 picker 变更：data-key 为 order/invite/verify，data-part 为 Date/Time
  onDeadlinePart(e) {
    const field = e.currentTarget.dataset.key + e.currentTarget.dataset.part
    this.setData({ [field]: e.detail.value })
  },
  // 清除某个截止时间（留空 = 不限制）
  clearDeadline(e) {
    const k = e.currentTarget.dataset.key
    this.setData({ [k + 'Date']: '', [k + 'Time']: '' })
  },

  // 保存活动/商品配置
  async saveActivity() {
    const f = this.data.form
    if (!f.name || !f.goodsName) { this.showToast('活动名称和商品名称必填'); return }
    this.setData({ saving: true })
    const yuan2fen = (v) => Math.round(Number(v || 0) * 100)
    const res = await api.adminSaveActivity({
      brand: f.brand, name: f.name, subtitle: f.subtitle,
      goodsName: f.goodsName, spec: f.spec,
      priceFen: yuan2fen(f.priceYuan), originalPriceFen: yuan2fen(f.originalPriceYuan),
      inviteTarget: Number(f.inviteTarget),
      orderDeadline: joinDeadline(this.data.orderDate, this.data.orderTime),
      inviteDeadline: joinDeadline(this.data.inviteDate, this.data.inviteTime),
      verifyDeadline: joinDeadline(this.data.verifyDate, this.data.verifyTime),
      status: f.status
    })
    this.setData({ saving: false })
    if (res.ok) { this.bumpVersion(); this.showToast('已保存到云端') }
    else this.showToast('保存失败：' + (res.code || '未知错误'))
  },

  // ---- 门店 ----
  addStore() {
    this.setData({ storeEdit: { name: '', address: '', hours: '', phone: '', stock: 10 } })
  },
  editStore(e) {
    const s = e.currentTarget.dataset.store
    this.setData({ storeEdit: Object.assign({}, s) })
  },
  onStoreField(e) {
    const key = e.currentTarget.dataset.key
    this.setData({ ['storeEdit.' + key]: e.detail.value })
  },
  chooseStoreLocation() {
    const store = this.data.storeEdit
    if (!store || this.data.saving) return
    const center = store.mapAddress ? { latitude: store.latitude, longitude: store.longitude } : {}
    wx.chooseLocation({
      ...center,
      success: ({ name, address, latitude, longitude }) => {
        const mapAddress = (address || name || '').trim()
        if (!mapAddress || !Number.isFinite(latitude) || !Number.isFinite(longitude)) {
          this.showToast('请选择有地址的地图地点')
          return
        }
        const patch = {
          'storeEdit.locationName': (name || '').trim(),
          'storeEdit.mapAddress': mapAddress,
          'storeEdit.latitude': latitude,
          'storeEdit.longitude': longitude
        }
        // 门店名称还没填时，自动带入地图搜索到的地点名，省掉用户手动再输一遍
        if (!String(store.name || '').trim() && String(name || '').trim()) {
          patch['storeEdit.name'] = String(name).trim()
        }
        this.setData(patch)
      },
      fail: ({ errMsg }) => {
        if (/cancel/i.test(errMsg)) return
        this.showToast('无法打开地图，请检查位置权限')
      }
    })
  },
  cancelStoreEdit() { this.setData({ storeEdit: null }) },
  async saveStore() {
    const s = this.data.storeEdit
    if (this.data.saving) return
    if (!s || !s.name.trim()) { this.showToast('门店名称必填'); return }
    if (!s._id && !s.mapAddress) { this.showToast('请先搜索并选择门店位置'); return }
    const location = s.mapAddress ? {
      locationName: s.locationName,
      mapAddress: s.mapAddress,
      addressDetail: s.addressDetail || '',
      latitude: s.latitude,
      longitude: s.longitude
    } : {}
    this.setData({ saving: true })
    const res = await api.adminSaveStore({
      id: s._id, name: s.name.trim(), hours: s.hours,
      phone: s.phone, stock: Number(s.stock || 0), ...location
    })
    this.setData({ saving: false })
    if (res.ok) { this.bumpVersion(); this.showToast('门店已保存'); this.setData({ storeEdit: null }); await this.load() }
    else if (res.code === 'BAD_STORE_LOCATION') this.showToast('请重新搜索并选择门店位置')
    else this.showToast('保存失败：' + (res.code || '未知错误'))
  },
  async deleteStore(e) {
    const id = e.currentTarget.dataset.id
    const name = e.currentTarget.dataset.name
    const confirm = await new Promise(resolve => {
      wx.showModal({ title: '删除门店', content: `确认删除「${name}」？`, success: r => resolve(r.confirm) })
    })
    if (!confirm) return
    const res = await api.adminDeleteStore({ id })
    if (res.ok) { this.bumpVersion(); this.showToast('已删除'); await this.load() }
    else this.showToast('删除失败：' + (res.code === 'STORE_IN_USE' ? '该门店已有订单，不能删除' : '未知错误'))
  },

  // ---- 海报 ----
  choosePoster() {
    wx.chooseImage({
      count: 1,
      sizeType: ['original', 'compressed'],
      sourceType: ['album', 'camera'],
      success: (r) => {
        const path = r.tempFilePaths[0]
        this.setData({ saving: true })
        wx.showLoading({ title: '正在处理图片', mask: true })
        // 逐级降质压缩，确保 base64 低于 HTTP 网关请求体上限
        this.compressAndUpload(path, [
          { quality: 0.8, maxWidth: 720 },
          { quality: 0.6, maxWidth: 640 },
          { quality: 0.4, maxWidth: 540 }
        ])
      },
      fail: () => { /* 用户取消选图，不提示 */ }
    })
  },

  // 用离屏 canvas 把图片重绘为 JPEG，返回 base64
  renderJpegBase64(filePath, quality, maxWidth) {
    return new Promise((resolve, reject) => {
      wx.getImageInfo({
        src: filePath,
        success: (info) => {
          let w = info.width || 720
          let h = info.height || 1280
          if (w > maxWidth) { h = Math.round(h * maxWidth / w); w = maxWidth }
          wx.createSelectorQuery().select('#poster-canvas').fields({ node: true, size: true }).exec((res) => {
            const canvas = res && res[0] && res[0].node
            if (!canvas) { reject(new Error('画布初始化失败')); return }
            canvas.width = w
            canvas.height = h
            const img = canvas.createImage()
            img.onload = () => {
              const ctx = canvas.getContext('2d')
              ctx.drawImage(img, 0, 0, w, h)
              wx.canvasToTempFilePath({
                canvas, fileType: 'jpeg', quality,
                success: (r) => {
                  wx.getFileSystemManager().readFile({
                    filePath: r.tempFilePath, encoding: 'base64',
                    success: (fr) => resolve('data:image/jpeg;base64,' + fr.data),
                    fail: () => reject(new Error('读取压缩图失败'))
                  })
                },
                fail: () => reject(new Error('导出压缩图失败'))
              })
            }
            img.onerror = () => reject(new Error('图片加载失败'))
            img.src = filePath
          })
        },
        fail: () => reject(new Error('获取图片信息失败'))
      })
    })
  },

  async compressAndUpload(path, plans) {
    // 分片上传可承载 2MB 内的图片，这里设 1.5MB 仅防止超大原图；正常海报走第一档画质
    const LIMIT = 1500 * 1024
    let last = ''
    try {
      for (const p of plans) {
        last = await this.renderJpegBase64(path, p.quality, p.maxWidth)
        if (last.length <= LIMIT) break
      }
      wx.hideLoading()
      if (last.length > LIMIT) {
        this.setData({ saving: false })
        wx.showModal({
          title: '图片过大',
          content: '已尽力压缩，但图片仍超过上传上限。请换一张更小的图片，或减少画面内容后重试。',
          showCancel: false
        })
        return
      }
      await this.uploadPoster(last, 'image/jpeg')
    } catch (e) {
      wx.hideLoading()
      this.setData({ saving: false })
      wx.showModal({ title: '图片处理失败', content: (e && e.message) || '未知错误', showCancel: false })
    }
  },

  async uploadPoster(base64, mime) {
    // HTTP 网关 payload 上限约 96KB，base64 必须分片传输（每片 60KB 留足余量）
    const CHUNK_SIZE = 60 * 1024
    const uploadId = 'poster_' + Date.now() + '_' + Math.floor(Math.random() * 100000)
    const data = String(base64).replace(/^data:image\/\w+;base64,/, '')
    const total = Math.ceil(data.length / CHUNK_SIZE)
    try {
      wx.showLoading({ title: '准备上传', mask: true })
      const init = await api.adminPosterInit({ uploadId: uploadId })
      if (!init.ok) throw new Error('初始化上传失败：' + (init.code || init.message || '未知错误'))
      for (let i = 0; i < total; i++) {
        const chunk = data.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE)
        const r = await api.adminPosterChunk({ uploadId: uploadId, index: i, total: total, data: chunk })
        if (!r.ok) throw new Error('第 ' + (i + 1) + '/' + total + ' 片上传失败：' + (r.code || r.message || '未知错误'))
        wx.showLoading({ title: '上传中 ' + (i + 1) + '/' + total, mask: true })
      }
      const merged = await api.adminPosterMerge({ uploadId: uploadId, mime: mime })
      wx.hideLoading()
      this.setData({ saving: false })
      if (merged.ok) {
        this.bumpVersion()
        this.showToast('海报已上传到云端')
        await this.load()
      } else {
        const friendly = {
          IMAGE_TOO_LARGE: '图片超过云端保存上限（2MB）',
          NO_CHUNKS: '没有收到图片数据，请重试'
        }
        wx.showModal({ title: '上传失败', content: friendly[merged.code] || merged.message || '合并失败，请重试', showCancel: false })
      }
    } catch (e) {
      wx.hideLoading()
      this.setData({ saving: false })
      wx.showModal({ title: '上传失败', content: (e && e.message) || '未知错误', showCancel: false })
    }
  },
  async resetPoster() {
    const confirm = await new Promise(resolve => {
      wx.showModal({ title: '恢复默认海报', content: '恢复为项目内置的洗发水海报？', success: r => resolve(r.confirm) })
    })
    if (!confirm) return
    const res = await api.adminResetPoster()
    if (res.ok) { this.bumpVersion(); this.showToast('已恢复默认海报'); await this.load() }
    else this.showToast('恢复失败')
  },
  previewPoster() {
    if (!this.data.posterSrc) return
    wx.previewImage({ urls: [this.data.posterSrc] })
  }
})
