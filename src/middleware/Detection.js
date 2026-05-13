function platformDetection(req, res, next) {
  const platform = (req.headers['x-platform'] || '').toLowerCase();
  const userAgent = (req.headers['user-agent'] || '').toLowerCase();

  if (platform === 'web') {
    // Explicit web header — always allow
    req.isWeb = true;
  } else if (platform === 'mobile') {
    // Explicit native app header — block if lockout is on
    req.isWeb = false;
  } else {
    // Fallback heuristic: flag as native app if UA contains known RN/Expo markers
    // NOTE: do NOT use "mobile" here — mobile browsers (Safari/Chrome on phones)
    //       include "mobile" in their UA, which would wrongly block real users.
    const isExpoApp = userAgent.includes('expo') || 
                      userAgent.includes('okhttp') ||
                      userAgent.includes('react-native') ||
                      userAgent.includes('expomodules') ||
                      userAgent.includes('reactnative');
    req.isWeb = !isExpoApp;
  }

  next();
}

module.exports = { platformDetection };
