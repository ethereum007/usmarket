# VM Deployment

This repository deploys the frontend to `alpha-radar-vm` automatically when code is pushed to `main`.

The workflow syncs the repository to `/home/charan/alpha-radar-frontend`, preserves VM-only files such as `.env`, `node_modules`, and `.next`, runs `npm ci`, builds the Next.js app, then restarts PM2 on port `3000`.

Nginx already proxies `https://alpha-radar.in` to `127.0.0.1:3000`.

## GitHub Repository Variables

Set these in `Settings > Secrets and variables > Actions > Variables`:

- `VM_USER`: `charan`
- `VM_PORT`: `22`
- `FRONTEND_PATH`: `/home/charan/alpha-radar-frontend`

The frontend build reads existing environment values from the VM, so keep `/home/charan/alpha-radar-frontend/.env` configured there.

## GitHub Repository Secrets

Set these in `Settings > Secrets and variables > Actions > Secrets`:

- `VM_HOST`: external IP or DNS name of `alpha-radar-vm`
- `VM_SSH_PRIVATE_KEY`: private key for an SSH key whose public key is in `/home/charan/.ssh/authorized_keys`

## Create The SSH Key On The VM

Run this on `alpha-radar-vm`:

```sh
mkdir -p ~/.ssh
chmod 700 ~/.ssh
ssh-keygen -t ed25519 -C "github-actions-alpha-radar" -f ~/.ssh/github-actions-alpha-radar -N ""
cat ~/.ssh/github-actions-alpha-radar.pub >> ~/.ssh/authorized_keys
chmod 600 ~/.ssh/authorized_keys
cat ~/.ssh/github-actions-alpha-radar
```

Copy the full private key output, including the `BEGIN OPENSSH PRIVATE KEY` and `END OPENSSH PRIVATE KEY` lines, into the GitHub secret `VM_SSH_PRIVATE_KEY`.

Get the VM external IP with:

```sh
curl -fsS -H "Metadata-Flavor: Google" \
  http://metadata.google.internal/computeMetadata/v1/instance/network-interfaces/0/access-configs/0/external-ip
```

Use that value for `VM_HOST`.
