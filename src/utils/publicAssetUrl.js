export function publicAssetUrl(fileName) {
  const normalizedName = String(fileName).replace(/^\/+/, '')
  const appBase = window.location.protocol === 'file:'
    ? new URL(import.meta.env.BASE_URL, window.location.href)
    : new URL(import.meta.env.BASE_URL, window.location.origin)

  return new URL(normalizedName, appBase).href
}
