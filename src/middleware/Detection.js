// src/middleware/Detection.js
/**
 * Middleware to detect the platform (Web vs Mobile) 
 * using the 'x-platform' header.
 */
function platformDetection(req, res, next) {
  const platform = (req.headers['x-platform'] || '').toLowerCase();
  const userAgent = (req.headers['user-agent'] || '').toLowerCase();

  // If x-platform check
  if (platform === 'web') {
    req.isWeb = true;
  } else if (platform === 'mobile') {
    req.isWeb = false;
  } else {
    // Fallback: If header is missing or contains 'Expo'/'Mobile', it's mobile.
    // Otherwise, for safety, we treat it as mobile unless explicitly 'web'
    req.isWeb = false;
    
    // Extra check: If it's a browser requesting standard routes without headers
    // but we want to be strict as per the prompt: "if missing, set isWeb = false"
  }

  next();
}

module.exports = { platformDetection };
