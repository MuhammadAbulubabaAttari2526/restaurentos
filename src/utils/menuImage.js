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

export function optimizeMenuImageUrl(value, width = 960) {
  const normalized = normalizeMenuImageUrl(value)
  if (!normalized) return ''

  try {
    const url = new URL(normalized)
    if (url.hostname === 'images.unsplash.com') {
      url.searchParams.set('auto', 'format')
      url.searchParams.set('fit', 'crop')
      url.searchParams.set('w', String(width))
      url.searchParams.set('q', '78')
    } else if (url.hostname === 'images.pexels.com') {
      url.searchParams.set('auto', 'compress')
      url.searchParams.set('cs', 'tinysrgb')
      url.searchParams.set('w', String(width))
    } else if (url.hostname === 'res.cloudinary.com' && url.pathname.includes('/upload/')) {
      url.pathname = url.pathname.replace('/upload/', `/upload/f_auto,q_auto,w_${width},c_limit/`)
    }
    return url.href
  } catch {
    return normalized
  }
}
