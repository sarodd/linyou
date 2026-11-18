// 自定义 tabBar：按角色渲染可见条目
// 普通用户（user）只能看到「活动 / 我的订单」；管理员（admin）看到全部四个。
// 真正的权限边界在云函数（ADMIN_ACTIONS + requireAdmin），这里只做入口展示。
const ALL = [
  { path: '/pages/index/index', text: '活动', icon: '惠', adminOnly: false },
  { path: '/pages/orders/orders', text: '我的订单', icon: '单', adminOnly: false },
  { path: '/pages/staff/staff', text: '店员', icon: '店', adminOnly: true },
  { path: '/pages/admin/admin', text: '运营', icon: '管', adminOnly: true },
  { path: '/pages/mine/mine', text: '我的', icon: '我', adminOnly: false }
]

Component({
  data: {
    role: 'user',
    selected: 0,
    list: []
  },
  lifetimes: {
    attached() {
      this.rebuild('user', 0)
    }
  },
  methods: {
    // 由各 tab 页 onShow 调用：同步角色与选中项
    sync(role, path) {
      const r = role === 'admin' ? 'admin' : 'user'
      const idx = ALL.findIndex(x => x.path === path)
      this.rebuild(r, idx < 0 ? 0 : idx)
    },
    rebuild(role, selected) {
      const sel = selected === undefined ? this.data.selected : selected
      const list = ALL
        .filter(x => !x.adminOnly || role === 'admin')
        .map((x) => Object.assign({}, x, { active: ALL.indexOf(x) === sel }))
      this.setData({ role, selected: sel, list })
    },
    onTap(e) {
      const path = e.currentTarget.dataset.path
      const cur = ALL[this.data.selected]
      if (cur && path === cur.path) return
      wx.switchTab({ url: path })
    }
  }
})
