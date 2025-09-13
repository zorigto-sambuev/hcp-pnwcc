# 🔧 Environment Variables Guide

This guide explains all environment variables used in the HousecallPro booking automation system.

## 📋 Quick Setup for Render

### Step 1: In Render Dashboard
1. Go to your service → **Environment** tab
2. Add these variables:

### Step 2: Required Variables
```
PORT=8080
NODE_ENV=production  
HEADLESS=1
```

### Step 3: Optional Variables
```
WEBHOOK_SECRET=your-super-secret-key-here
SENTRY_DSN=https://your-sentry-dsn@sentry.io/project-id
```

## 📖 Complete Variables Reference

### 🚀 **Core Application Variables**

| Variable | Default | Description | Required |
|----------|---------|-------------|----------|
| `PORT` | `8080` | HTTP server port | ✅ Yes |
| `NODE_ENV` | `development` | Runtime environment | ✅ Yes |
| `HEADLESS` | `1` | Browser headless mode (1=yes, 0=no) | ✅ Yes |

### 🔐 **Authentication & Security**

| Variable | Default | Description | Required |
|----------|---------|-------------|----------|
| `WEBHOOK_SECRET` | `""` | Secret for webhook authentication | 🔶 Optional |
| `RUNNER_AUTH` | `""` | Authorization token for runner API | 🔶 Optional |

### 🌐 **External Services**

| Variable | Default | Description | Required |
|----------|---------|-------------|----------|
| `RUNNER_URL` | `wss://api.browsercat.com/connect` | WebSocket URL for remote browser | 🔶 Optional |
| `BROWSERCAT_API_KEY` | `""` | API key for Browsercat service | 🔶 Optional |
| `FORCE_BROWSERCAT` | `""` | Force use of Browsercat (any value) | 🔶 Optional |
| `SENTRY_DSN` | `""` | Sentry error tracking URL | 🔶 Optional |

### 🐛 **Debugging & Development**

| Variable | Default | Description | Required |
|----------|---------|-------------|----------|
| `SLOWMO` | `0` | Delay between actions (milliseconds) | ❌ No |
| `KEEP_OPEN` | `0` | Keep browser open after completion | ❌ No |

### 📄 **Payload Configuration**

| Variable | Default | Description | Required |
|----------|---------|-------------|----------|
| `PAYLOAD` | `./payload.json` | Path to payload file (local only) | ❌ No |
| `PAYLOAD_JSON` | `"{}"` | JSON payload string (production) | ❌ No |

## 🛠️ **Setting Variables in Render**

### Via Dashboard:
1. Navigate to your service
2. Click **Environment** tab  
3. Click **Add Environment Variable**
4. Enter **Key** and **Value**
5. Click **Save Changes**

### Via render.yaml:
```yaml
envVars:
  - key: PORT
    value: 8080
  - key: HEADLESS  
    value: "1"
  - key: NODE_ENV
    value: production
```

## 🔒 **Security Best Practices**

### Generate Secure Webhook Secret:
```bash
# Method 1: Using Node.js
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# Method 2: Using OpenSSL
openssl rand -hex 32

# Method 3: Using PowerShell (Windows)
[System.Web.Security.Membership]::GeneratePassword(64, 0)
```

### Security Checklist:
- ✅ Never commit secrets to Git
- ✅ Use strong, random webhook secrets  
- ✅ Rotate API keys regularly
- ✅ Monitor logs for unauthorized access
- ✅ Use HTTPS only (automatic with Render)
- ✅ Set up error tracking with Sentry

## 🎯 **Environment-Specific Configurations**

### Development (Local):
```bash
PORT=3000
NODE_ENV=development
HEADLESS=0          # Show browser
SLOWMO=100          # Slower automation
KEEP_OPEN=1         # Keep browser open
PAYLOAD=./payload.json
```

### Production (Render):
```bash
PORT=8080
NODE_ENV=production
HEADLESS=1          # Always headless
SLOWMO=0            # Full speed
KEEP_OPEN=0         # Close browser
WEBHOOK_SECRET=abc123...
SENTRY_DSN=https://...
```

## 📊 **Variable Validation**

The application validates these variables on startup:

### Warnings (non-critical):
- Missing `WEBHOOK_SECRET` - webhook auth disabled
- Missing `SENTRY_DSN` - error tracking disabled  
- Missing `BROWSERCAT_API_KEY` - local browser only

### Errors (critical):
- Invalid `PORT` - server won't start
- Invalid `HEADLESS` - browser may fail
- Missing required payload data

## 🔍 **Debugging Variables**

### Check Environment Variables:
```bash
# Via API endpoint
curl https://your-app.onrender.com/env

# Response example:
{
  "has_BROWSERCAT_API_KEY": true,
  "FORCE_BROWSERCAT": "",
  "NODE_VERSION": "v18.17.0"
}
```

### Common Issues:

| Issue | Cause | Solution |
|-------|-------|----------|
| Service won't start | Missing `PORT` | Set `PORT=8080` |
| Browser fails | Wrong `HEADLESS` value | Set `HEADLESS=1` |
| Webhook rejected | Missing/wrong secret | Set strong `WEBHOOK_SECRET` |
| No error tracking | Missing Sentry DSN | Add `SENTRY_DSN` |

## 📞 **Support**

Need help with environment variables?

1. **Check the logs** in Render Dashboard
2. **Test locally** with debug variables first  
3. **Verify syntax** - no spaces around `=`
4. **Use quotes** for values with special characters
5. **Restart service** after variable changes

---

**💡 Pro Tip**: Start with minimal required variables, then add optional ones as needed!
