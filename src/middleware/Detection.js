function platformDetection(req, res, next) {
  const platform = (req.headers['x-platform'] || '').toLowerCase();
  const userAgent = (req.headers['user-agent'] || '').toLowerCase();

  if (platform === 'web') {
    req.isWeb = true;
  } else if (platform === 'mobile') {
    req.isWeb = false;
  } else {
    // Fallback: Check User-Agent for common browser strings if x-platform is missing
    const isBrowser = userAgent.includes('mozilla') || userAgent.includes('chrome') || userAgent.includes('safari');
    const isMobileApp = userAgent.includes('expo') || userAgent.includes('mobile');
    req.isWeb = isBrowser && !isMobileApp;
  }

  next();
}

module.exports = { platformDetection };
