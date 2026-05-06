# Groundwork · Milwaukee Development Intelligence

Auto-updating newsletter tracking new construction, developments, and renovations within 50 miles of Milwaukee, WI. Updates every Monday and Thursday morning.

## Setup

### 1. GitHub Secrets
Go to your repo → Settings → Secrets and variables → Actions → New repository secret

Add these three secrets:
- `GEMINI_API_KEY` — from Google AI Studio
- `RESEND_API_KEY` — from Resend dashboard
- `RECIPIENT_EMAIL` — email address to deliver the newsletter

### 2. GitHub Pages
Go to repo → Settings → Pages → Source: Deploy from branch → Branch: main → Folder: / (root)

### 3. Manual test run
Go to Actions → Groundwork Update → Run workflow

## Sources
- Urban Milwaukee
- BizTimes Milwaukee
- Milwaukee Journal Sentinel
- WisBusiness

## Filters
- Residential: 5+ units
- Commercial: 3,000+ sqft minimum
- Renovation: public approval required
- Geographic radius: ~50 miles from Milwaukee

## Schedule
- Monday 8:00 AM CT
- Thursday 8:00 AM CT
- Skips if fewer than 3 qualifying projects found
