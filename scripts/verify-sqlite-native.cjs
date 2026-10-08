const fs = require('fs')
const path = require('path')

const packageRoot = path.dirname(require.resolve('better-sqlite3/package.json'))
const windowsX64Prebuild = path.join(packageRoot, 'prebuilds', 'win32-x64.node')

if (!fs.existsSync(windowsX64Prebuild)) {
  throw new Error(`better-sqlite3 Windows x64 N-API binary is missing: ${windowsX64Prebuild}`)
}

if (process.platform === 'win32' && process.arch === 'x64') {
  const { getPrebuildPath } = require(path.join(packageRoot, 'lib', 'binding.js'))
  const selectedPrebuild = getPrebuildPath()
  if (selectedPrebuild !== windowsX64Prebuild) {
    throw new Error(`better-sqlite3 selected an unexpected native binary: ${selectedPrebuild || 'none'}`)
  }

  const Database = require('better-sqlite3')
  const db = new Database(':memory:')
  try {
    const result = db.prepare('SELECT sqlite_version() AS version').get()
    if (!result?.version) throw new Error('SQLite did not return a version.')
    console.log(`better-sqlite3 N-API prebuild loaded on win32-x64 (SQLite ${result.version}).`)
  } finally {
    db.close()
  }
} else {
  console.log(`better-sqlite3 Windows x64 N-API prebuild is present: ${windowsX64Prebuild}`)
}
