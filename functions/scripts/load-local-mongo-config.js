import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const secretFile = fileURLToPath(new URL('../.secret.local', import.meta.url))

export function loadLocalMongoConfig() {
  let contents = ''
  try {
    contents = readFileSync(secretFile, 'utf8')
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }

  for (const line of contents.split(/\r?\n/)) {
    const match = line.match(/^\s*(MONGODB_URI|MONGODB_DB)\s*=\s*(.*?)\s*$/)
    if (!match || process.env[match[1]]) continue
    const value = match[2].replace(/^(['"])(.*)\1$/, '$2')
    if (value) process.env[match[1]] = value
  }

  if (!process.env.MONGODB_URI) {
    throw new Error('MongoDB is not configured. Add MONGODB_URI to the ignored functions/.secret.local file.')
  }
  if (process.env.MONGODB_URI.includes('<')) {
    throw new Error('Replace the Atlas URI placeholders in functions/.secret.local before connecting.')
  }
}
