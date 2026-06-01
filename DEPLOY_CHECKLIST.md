# XO ET — Production Deployment Checklist

## Pre-Deployment

### 1. Database Migration (Run FIRST)
```bash
# Connect to production Supabase and run the structure-only migration
psql "postgresql://postgres.szfphzuygiabvxtxemiy:<PASSWORD>@aws-1-eu-west-1.pooler.supabase.com:6543/postgres" -f migration_production.sql
```
- [ ] Migration ran without errors
- [ ] No data was inserted (verify with: `SELECT COUNT(*) FROM fake_ticker_entries;` — should be 0 or same as before)

### 2. Railway Environment Variables (Backend)
Ensure ALL of these are set in Railway dashboard → Variables:

| Variable | Required | Notes |
|----------|----------|-------|
| `NODE_ENV` | ✅ | Must be `production` |
| `JWT_SECRET` | ✅ | 128+ char random string |
| `DATABASE_URL` | ✅ | Supabase pooler URL |
| `REDIS_URL` | ✅ | Upstash Redis URL |
| `CHAPA_SECRET_KEY` | ✅ | Chapa API secret (CHASECK_...) |
| `CHAPA_WEBHOOK_SECRET` | ✅ | From Chapa dashboard → Settings → Webhooks |
| `CHAPA_PUBLIC_KEY` | ✅ | Chapa public key |
| `CHAPA_ENCRYPTION_KEY` | ✅ | Chapa encryption key |
| `CHAPA_WEBHOOK_URL` | ✅ | `https://xogpt-production.up.railway.app/payments/webhook` |
| `GEEZ_SMS_TOKEN` | ✅ | GeezSMS API token |
| `SUPER_ADMIN_NUMBERS` | ✅ | Comma-separated admin phone numbers |
| `SENTRY_DSN` | ⚠️ | Sentry error tracking DSN (optional but recommended) |
| `PORT` | ⚠️ | Railway sets this automatically |

### 3. Vercel Environment Variables (Frontend)
Set in Vercel dashboard → Settings → Environment Variables:

| Variable | Value |
|----------|-------|
| `EXPO_PUBLIC_API_URL` | `https://xogpt-production.up.railway.app` |
| `EXPO_PUBLIC_SOCKET_URL` | `https://xogpt-production.up.railway.app` |
| `EXPO_PUBLIC_APP_URL` | `https://xoethiopia.com` |
| `EXPO_PUBLIC_CHAPA_PUBLIC_KEY` | Your Chapa public key |

### 4. Security Verification
- [ ] Webhook signature verification is ENFORCED (invalid = rejected)
- [ ] Admin 2FA bypass code `4444` is REMOVED
- [ ] JWT fallback `"supersecret"` is REMOVED
- [ ] Auth rate limiter is set to 30/15min (not 500)
- [ ] OTP codes are NOT logged in production
- [ ] Localhost lockdown bypass only works in development
- [ ] Backend Railway URL is NOT in frontend CSP headers
- [ ] Source maps are blocked (returns 404)

---

## Deployment Steps

### Step 1: Deploy Backend (Railway)
```bash
cd xoet_backend
git add -A
git commit -m "security: production hardening — webhook enforcement, 2FA fix, CSP tightening, rate limits"
git push origin main
```
Railway auto-deploys on push to main.

### Step 2: Verify Backend Health
```bash
curl https://xogpt-production.up.railway.app/health
# Expected: {"status":"ok","timestamp":"..."}
```

### Step 3: Deploy Frontend (Vercel)
```bash
cd xoet-3
git add -A
git commit -m "security: remove backend URL from CSP, clean config, add cache headers"
git push origin main
```
Vercel auto-deploys on push to main.

### Step 4: Verify Frontend
- [ ] https://xoethiopia.com loads correctly
- [ ] Login/OTP flow works
- [ ] Deposit flow works (test with minimum amount)
- [ ] Game matchmaking works
- [ ] Admin dashboard accessible and 2FA works

---

## Post-Deployment

### Secret Rotation (RECOMMENDED)
After confirming everything works:

1. **Rotate JWT_SECRET** on Railway → all users will need to re-login
2. **Rotate CHAPA_WEBHOOK_SECRET** on both Chapa dashboard AND Railway
3. **Rotate GEEZ_SMS_TOKEN** if you suspect it was ever exposed
4. **Rotate REDIS_URL password** via Upstash dashboard → update Railway

### Monitoring
- Check Railway logs for any `[WEBHOOK SECURITY]` alerts
- Check Sentry for new errors after deploy
- Monitor `/admin` audit logs for unusual activity
- Check `system_alerts` table: `SELECT * FROM system_alerts WHERE resolved = false ORDER BY created_at DESC LIMIT 20;`

---

## Rollback Plan
If anything breaks:
1. Railway: Click "Rollback" on the previous deployment in Railway dashboard
2. Vercel: Click "Rollback" in Vercel → Deployments
3. Database: The migration is additive-only (ADD COLUMN, CREATE TABLE) — no rollback needed
