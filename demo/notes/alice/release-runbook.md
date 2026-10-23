# Release runbook

Owner: platform team. Last reviewed in September.

## Before a release

1. Merge to `main` and wait for CI to pass.
2. Tag the commit: `git tag v1.8.0 && git push --tags`.
3. Post the tag and the changelog link in #releases.

## Deploy

Run `./deploy.sh v1.8.0 staging`, check the dashboard for ten minutes,
then run `./deploy.sh v1.8.0 production`. The script drains one region
at a time and stops if the error rate goes above 2%.

## Roll back a release

1. Find the last good tag in #releases, for example `v1.7.3`.
2. Run `./deploy.sh v1.7.3 production --rollback`. This skips the
   staging step and redeploys the old build to all regions.
3. Database migrations are not reverted automatically. If the release
   ran a migration, run `./migrate.sh down 1` before the rollback.
4. Post in #incidents with the bad tag, the time and who rolled back.

A rollback takes about six minutes. Do not delete the bad tag; mark it
as broken in the changelog so nobody redeploys it.
