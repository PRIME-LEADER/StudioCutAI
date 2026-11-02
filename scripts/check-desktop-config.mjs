const rawUrl = process.env.VITE_API_BASE_URL?.trim()
if (!rawUrl) {
  console.error('Set VITE_API_BASE_URL in .env.local to the secured StudioCut API before building a Windows installer.')
  process.exitCode = 1
} else {
  try {
    const url = new URL(rawUrl)
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
      throw new Error('Use HTTPS for the hosted API, or HTTP only for a local development server.')
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'VITE_API_BASE_URL is invalid.')
    process.exitCode = 1
  }
}
