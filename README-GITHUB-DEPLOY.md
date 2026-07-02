# GitHub Auto Deploy

This project includes GitHub Actions auto deploy for PHP hosting.

## What gets deployed
Only the contents of the public/ folder are deployed.

## Live data protection
public/storage/rooms.json is excluded from deployment so active room data on hosting is preserved.

## Required GitHub Secrets
- FTP_SERVER
- FTP_USERNAME
- FTP_PASSWORD
- FTP_TARGET_DIR

## Workflow file
See .github/workflows/deploy-php-hosting.yml
