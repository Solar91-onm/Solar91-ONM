# Render deployment

The maintained deployment instructions are in [RENDER_DEPLOYMENT_RUNBOOK.md](./RENDER_DEPLOYMENT_RUNBOOK.md).

The production web process does not apply database migrations automatically. Review and back up the target database before applying any migration. Render Free services may sleep and are not suitable for time-critical background jobs or continuous business availability.
