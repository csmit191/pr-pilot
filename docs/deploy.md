# Deploying PR Pilot

This guide deploys PR Pilot to [Render](https://render.com), the only one of the usual hobby hosts that
still has a real free web service. The Dockerfile is host-neutral, so the same image runs on Fly.io or
Railway (both are paid for new accounts) or anywhere that runs containers.

## Read this first: free hosts go to sleep

Render's free web services **spin down after 15 minutes without inbound requests** and take about a
minute to wake up. A GitHub webhook is only given 10 seconds, and GitHub does not retry failed
deliveries by itself, so **a pull request opened while the service is asleep can be missed**.

Two fixes, use at least the first:

1. **Keep it awake** with a free uptime monitor that requests `/healthz` every 5 minutes (see
   [Keeping it awake](#keeping-it-awake)).
2. **Redeliver by hand** when it does miss one: GitHub App settings → Advanced → Recent deliveries →
   Redeliver.

Other free-tier facts worth knowing (from Render's docs): the 750 free instance hours per month are
shared by your whole workspace, so one always-on service fits (about 744 hours in a 31-day month) but
two do not; the filesystem is ephemeral (PR Pilot keeps no state on disk, so this is fine); and Render
may restart a free service at any time (PR Pilot drains in-flight reviews on shutdown, but a hard
restart can still lose one, and you can redeliver it).

## Step by step

### 1. Prepare

- The repository is pushed to GitHub, with `package-lock.json` committed (the Docker build needs it).
- You have the GitHub App's **App ID**, a downloaded **private key** (`.pem`), and the **webhook
  secret** you chose. See "Register the GitHub App" in the README.
- Optional: an Anthropic API key. Without it PR Pilot still runs all the rule-based checks and just
  skips the AI summary.

### 2. Turn the private key into one line

Render stores each secret as a single value. PR Pilot accepts the key with `\n` in place of line
breaks (the same format as in `.env`). In PowerShell, from the folder with the key:

```powershell
(Get-Content .\private-key.pem -Raw) -replace "\r?\n", "\n" | Set-Clipboard
```

That copies the one-line form to your clipboard.

### 3. Create the service

1. Sign in to Render with GitHub.
2. **New → Blueprint**, choose your `pr-pilot` repository. Render reads `render.yaml`.
3. It asks for the four secrets (`sync: false` in the blueprint keeps them out of git):
   - `WEBHOOK_SECRET`: the secret from your GitHub App settings
   - `GITHUB_APP_ID`: the numeric App ID
   - `GITHUB_PRIVATE_KEY`: paste the one-line key from step 2
   - `ANTHROPIC_API_KEY`: your key, or leave it empty
4. Apply. The first build takes a few minutes.

To pick a different model, add `LLM_MODEL` under the service's **Environment** tab. The default is
`claude-haiku-5-5`.

Prefer clicking through? **New → Web Service**, connect the repo, set **Runtime: Docker**, **Instance
type: Free**, **Health Check Path: `/healthz`**, and add the same environment variables.

### 4. Check that it is alive

Open `https://<your-service>.onrender.com/healthz`. It should answer `ok`. If the first request is
slow, the service was waking up.

### 5. Point the GitHub App at it

GitHub App settings → **Webhook URL**: `https://<your-service>.onrender.com/webhook`. Leave the
webhook secret as it is (it must match `WEBHOOK_SECRET`). Make sure the app is subscribed to **Pull
request** events and has the permissions listed in the README.

Click **Advanced → Recent deliveries → Redeliver** on any earlier delivery to test without opening a
PR. A `202` response means PR Pilot accepted it.

### 6. Keep it awake

Create a free monitor that requests `https://<your-service>.onrender.com/healthz` every 5 minutes
(for example UptimeRobot or cron-job.org; check their current free limits). Any interval under 15
minutes works. The monitor counts as inbound traffic, so Render never spins the service down.

### 7. Try it

Open a pull request on a repository where the app is installed. Within a few seconds a **PR Pilot
review** comment appears. Push another commit and the same comment is edited. Render's **Logs** tab
shows one JSON line per step; look for `Review comment posted`.

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| GitHub shows timeouts or 5xx for deliveries | The service was asleep | Set up the monitor (step 6), then Redeliver |
| Deliveries show `401 invalid signature` | `WEBHOOK_SECRET` differs from the secret in the GitHub App | Make them identical |
| Deliveries are `202` but no comment appears | Missing permission | Logs show `Failed to post review comment` with status 403: set **Pull requests: Read & write** and accept it on the installation |
| Logs say `Could not read .prpilot.yml` | **Contents: Read-only** not granted | Add it and accept it on the installation. Reviews still run with defaults |
| Build fails at `npm ci` | `package-lock.json` is not committed | Commit it |
| Deploy fails the health check | Wrong health check path, or the app crashed at startup | Path must be `/healthz`. Check the logs for a missing environment variable |
| Startup error about the private key | Key pasted with real line breaks lost or mangled | Re-copy it using the PowerShell command in step 2 |
| No AI summary, comment says "unavailable" | LLM call failed (key, credit, or provider outage) | Check the logs for `LLM summary failed`. The rule-based sections still post |

## Updating

Pushing to `main` redeploys automatically (Render's default for Blueprints). Rotating a secret: change
it in Render's Environment tab, and for the webhook secret change it in the GitHub App at the same
time.

## Other hosts

- **Fly.io**: new accounts have only a short trial and need a card. `fly launch` detects the
  Dockerfile. Set the same environment variables with `fly secrets set`, and make sure the machine is
  not configured to stop when idle.
- **Railway**: a one-time trial credit, then paid. Deploy from the repo (it builds the Dockerfile) and
  set the same variables.
- Any container host: `docker build -t pr-pilot .` then `docker run -p 3000:3000` with the environment
  variables from `.env.example`.
