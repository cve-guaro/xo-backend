function platformDetection(req, res, next) {
  const platform = (req.headers['x-platform'] || '').toLowerCase();

  // NUCLEAR LOCKOUT: Only explicitly web-tagged traffic is allowed.
  // The old Expo app sends 'mobile' or nothing — both are now blocked.
  // Our web frontend ALWAYS sends 'x-platform: web' in every request.
  if (platform === 'web') {
    req.isWeb = true;
  } else {
    // Everything else (mobile, empty, unknown) → treated as native app → blocked
    req.isWeb = false;
  }

  next();
}

module.exports = { platformDetection };

