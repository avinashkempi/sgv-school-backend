/**
 * Force HTTPS Middleware
 * 
 * Automatically redirects all unencrypted HTTP requests to HTTPS.
 * - Detects reverse-proxy headers (e.g. X-Forwarded-Proto on Render, AWS, Heroku, Cloudflare, Nginx).
 * - Preserves HTTP methods on non-GET/HEAD requests using HTTP 308 (Permanent Redirect) so request bodies are retained.
 * - Preserves original URL path, parameters, and query strings.
 * - Enforces HTTP Strict Transport Security (HSTS) on secure requests in production.
 * - Bypasses localhost/127.0.0.1 in non-production environments to avoid breaking local development.
 * - Bypasses OPTIONS preflight and container health-check probes.
 */
function forceHttps(req, res, next) {
  // Determine if request is already HTTPS
  // Express 'req.secure' relies on 'trust proxy' being configured (e.g. app.set('trust proxy', 1))
  const forwardedProto = req.headers['x-forwarded-proto'];
  const proto = forwardedProto
    ? forwardedProto.split(',')[0].trim().toLowerCase()
    : (req.secure ? 'https' : req.protocol);

  const isSecure = req.secure || proto === 'https';

  if (isSecure) {
    // Add HSTS header for all HTTPS requests in production
    if (process.env.NODE_ENV === 'production') {
      res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
    return next();
  }

  // Bypass health checks to avoid breaking cloud orchestration / container probes
  if (req.path === '/health' || req.path === '/api/health') {
    return next();
  }

  // Bypass CORS preflight requests (browsers do not follow redirects on OPTIONS preflights)
  if (req.method === 'OPTIONS') {
    return next();
  }

  // Only enforce HTTPS redirects in production environment
  if (process.env.NODE_ENV !== 'production') {
    return next();
  }

  // Check if request is running on local development or private LAN network
  const rawHost = req.get('host') || req.hostname || '';
  const hostname = req.hostname || '';
  const isPrivateOrLocal =
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '::1' ||
    hostname === '10.0.2.2' ||
    /^192\.168\./.test(hostname) ||
    /^10\./.test(hostname) ||
    /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(hostname);

  if (isPrivateOrLocal) {
    return next();
  }

  // Build target HTTPS URL preserving host, path, and query string.
  // Strip non-standard HTTP port (e.g. :80, :5000) when redirecting to production domain.
  const host = rawHost.replace(/^[/\\]+/, '').replace(/:\d+$/, '');
  const targetUrl = `https://${host}${req.originalUrl || req.url}`;

  // Use 301 Moved Permanently for GET/HEAD, 308 Permanent Redirect for POST/PUT/DELETE/etc.
  // 308 guarantees that clients preserve the HTTP method and request body across redirect.
  const statusCode = (req.method === 'GET' || req.method === 'HEAD') ? 301 : 308;

  return res.redirect(statusCode, targetUrl);
}

module.exports = forceHttps;
