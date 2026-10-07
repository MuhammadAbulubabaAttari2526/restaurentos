let activeOperations = 0
let updateInstalling = false

function beginActivity() {
  if (updateInstalling) throw new Error('An update is preparing to install. Please try again shortly.')
  activeOperations += 1
  let completed = false
  return () => {
    if (completed) return
    completed = true
    activeOperations = Math.max(0, activeOperations - 1)
  }
}

function beginUpdateInstall() {
  if (activeOperations > 0 || updateInstalling) return false
  updateInstalling = true
  return true
}

function cancelUpdateInstall() {
  updateInstalling = false
}

function hasActiveOperations() {
  return activeOperations > 0
}

module.exports = { beginActivity, beginUpdateInstall, cancelUpdateInstall, hasActiveOperations }