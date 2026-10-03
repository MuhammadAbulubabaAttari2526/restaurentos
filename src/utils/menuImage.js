export function normalizeMenuImageUrl(value) {
  const raw = String(value || '').trim()
  if (!raw) return ''

  try {
    const url = new URL(raw)
    if (url.protocol !== 'https:' || url.username || url.password) return ''

    if (url.hostname === 'drive.google.com') {
      const fileId = url.pathname.match(/\/file\/d\/([^/]+)/)?.[1] || url.searchParams.get('id')
      if (fileId) return `https://drive.google.com/uc?export=view&id=${encodeURIComponent(fileId)}`
    }

    if (url.hostname === 'dropbox.com' || url.hostname.endsWith('.dropbox.com')) {
      url.searchParams.delete('dl')
      url.searchParams.set('raw', '1')
    }

    return url.href
  } catch {
    return ''
  }
}
