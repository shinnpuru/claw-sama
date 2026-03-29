const DEFAULT_OPENCLAW_BASE_URL = 'http://127.0.0.1:18789'
const STORAGE_KEY = 'claw-sama.openclawBaseUrl'
const OPENCLAW_URL_CHANGED_EVENT = 'claw-sama:openclaw-url-changed'

function normalizeBaseUrl(input: string): string {
  const raw = input.trim()
  if (!raw) return DEFAULT_OPENCLAW_BASE_URL

  const withProtocol = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`
  return withProtocol.replace(/\/+$/, '')
}

export function getOpenClawBaseUrl(): string {
  if (typeof window === 'undefined') return DEFAULT_OPENCLAW_BASE_URL

  try {
    const saved = window.localStorage.getItem(STORAGE_KEY)
    return normalizeBaseUrl(saved || DEFAULT_OPENCLAW_BASE_URL)
  } catch {
    return DEFAULT_OPENCLAW_BASE_URL
  }
}

export function setOpenClawBaseUrl(nextUrl: string): string {
  const normalized = normalizeBaseUrl(nextUrl)

  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(STORAGE_KEY, normalized)
    } catch {
      // ignore localStorage failures
    }

    window.dispatchEvent(new CustomEvent(OPENCLAW_URL_CHANGED_EVENT, { detail: normalized }))
  }

  return normalized
}

export function onOpenClawBaseUrlChange(listener: (nextUrl: string) => void): () => void {
  if (typeof window === 'undefined') return () => {}

  const handler = (event: Event) => {
    const detail = (event as CustomEvent<string>).detail
    listener(normalizeBaseUrl(detail || getOpenClawBaseUrl()))
  }

  window.addEventListener(OPENCLAW_URL_CHANGED_EVENT, handler)
  return () => window.removeEventListener(OPENCLAW_URL_CHANGED_EVENT, handler)
}

export function buildOpenClawUrl(path: string, baseUrl = getOpenClawBaseUrl()): string {
  const normalizedBase = normalizeBaseUrl(baseUrl)
  const normalizedPath = path.startsWith('/') ? path : `/${path}`
  return `${normalizedBase}${normalizedPath}`
}
