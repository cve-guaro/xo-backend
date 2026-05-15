// Known web origins — requests from these are always "web" regardless of headers
const WEB_ORIGINS = [
  'xoethiopia.com',
  'xo-et-frontend.vercel.app',
  'xoet-pro-frontend.vercel.app',
];

function platformDetection(req, res, next) {
  const platform = (req.headers['x-platform'] || '').toLowerCase();

  if (platform === 'web') {
    // Explicit web header → trust it
    req.isWeb = true;
  } else if (platform === 'mobile') {
    // Explicit mobile header → old native app
    req.isWeb = false;
  } else {
    // No x-platform header sent — infer from request context.
    // Web browsers ALWAYS send Origin (CORS) or Referer headers.
    // If the request comes from a known web origin, treat as web.
    const origin  = (req.headers.origin || '').toLowerCase();
    const referer = (req.headers.referer || '').toLowerCase();

    const isFromWeb = WEB_ORIGINS.some(o => origin.includes(o) || referer.includes(o));

    // Also check: requests with no origin AND no x-platform are server-to-server
    // (webhooks, cron, etc.) — let them through as web to avoid blocking
    const isServerToServer = !origin && !referer && !platform;

    req.isWeb = isFromWeb || isServerToServer;
  }

  next();
}

module.exports = { platformDetection };
