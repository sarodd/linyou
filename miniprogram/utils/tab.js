// tabBar 同步 + 页面权限守卫
const api = require('./api')

const PATH = {
  index: '/pages/index/index',
  orders: '/pages/orders/orders',
  staff: '/pages/staff/staff',
  admin: '/pages/admin/admin',
  mine: '/pages/mine/mine'
}

function bar(page) {
  return typeof page.getTabBar === 'function' ? page.getTabBar() : null
}

// 每个 tab 页 onShow 调用：先用本地缓存角色立即渲染（不闪烁），再拉云端角色校正
function sync(page, path) {
  const b = bar(page)
  if (!b) return
  b.sync(api.getRole(), path)
  api.refreshRole().then((role) => {
    const b2 = bar(page)
    if (b2) b2.sync(role, path)
  }).catch(() => {})
}

// 管理类页面守卫：非管理员设置 noAccess，页面据此显示无权限覆盖层
async function requireAdmin(page) {
  const role = await api.refreshRole()
  if (role === 'admin') {
    page.setData({ noAccess: false })
    return true
  }
  page.setData({ noAccess: true, loading: false })
  return false
}

module.exports = { sync, requireAdmin, PATH }
