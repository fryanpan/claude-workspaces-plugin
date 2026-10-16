# A project machine on Fly

One client project's board server runs on a Fly Machine of its own, reached
only through a Cloudflare Tunnel the machine dials out to, with its data dir
backed up, encrypted, to a bucket of the project's own. This is the runbook
Bryan follows once per project, after his Fly account exists. The files it
uses are in `infra/project-machine/`.

Agents never run these steps: every one of them creates an account resource
or holds a credential. Each step names what to type; `<project>` is a short
lower-case name such as the project's board name, used for every resource
below.

## What is on the machine

| Part | What it does |
| --- | --- |
| `Dockerfile` | The board server and both browser bundles, plus cloudflared. Runs as the `cw` user; root only hands the volume to `cw` at boot |
| `fly.toml` | One machine, one volume at `/data`, no public service ports |
| `entrypoint.sh` | Starts the server on `127.0.0.1:8787`, the tunnel, a loopback health check and the backup loop; if any stops, the machine exits and Fly restarts it |
| `backup.ts` | Tars the data dir, encrypts it to the project's public key and PUTs it to the bucket. Every 6 hours, the first an hour after boot |
| `restore.ts` | Decrypts a downloaded snapshot and restores it onto a data dir that is missing or empty. Refuses anything else |
| `keygen.ts` | Makes the project's backup key pair |

**The machine holds only the public half of the backup key.** It can write
snapshots but cannot read one back, and the bucket sees only ciphertext.
The private half (the identity) stays with Bryan, and without it no snapshot
restores.

**The bucket credential is create-only.** The machine may put new objects;
it cannot list, read, overwrite or delete them. A steered agent on the
machine can add junk snapshots but cannot destroy the good ones.

**Claude features are off on the machine.** The server spends prod's Claude
key only under the Mac's launchd label (`packages/server/src/claude-key-source.ts`).
A key slot for project machines is separate work.

## Why Google Cloud Storage for the bucket

GCS's `roles/storage.objectCreator` role is exactly a write-only credential:
it creates objects and cannot list, read or delete them, and since replacing
an object needs delete permission, it cannot overwrite one either. Bryan
already has a Google Cloud account for a client project's builds. Cloudflare R2's tokens
were ruled out because none is write-only: the narrowest that writes can also
read. AWS S3 and Backblaze B2 can both do write-only (an IAM policy allowing
only `s3:PutObject`; a B2 key with only `writeFiles`), and `backup.ts` works
with either, since it takes any S3-compatible endpoint through
`BACKUP_S3_ENDPOINT`. Use one Google Cloud project per client project, so no
credential reaches another project's backups.

## Before the first project

- `flyctl` installed and signed in (`fly auth login`).
- `gcloud` installed and signed in.
- The board router Worker deployed with the Mac alone in its table
  (`infra/board-router-worker/README.md`, steps 1 to 5).
- A clean clone of the repo at `origin/main`, never a working copy with local
  `node_modules` or a `data/` folder:

  ```bash
  git clone --depth 1 https://github.com/fryanpan/claude-workspaces-plugin.git ~/cw-deploy
  cd ~/cw-deploy
  ```

## 1. The backup key pair

```bash
bun infra/project-machine/keygen.ts --identity-file ~/<project>-backup.key
```

It prints `BACKUP_RECIPIENT=cwsnap-pub-…`; keep that line for step 5. Copy the
identity file's one line into the password manager as `<project> backup
identity`, then remove the local file. A lost identity means every snapshot
of this project is unreadable.

## 2. The bucket and its create-only credential

```bash
gcloud projects create cw-<project>-backups
gcloud config set project cw-<project>-backups
gcloud billing projects link cw-<project>-backups --billing-account=<Bryan's billing account id>
gcloud storage buckets create gs://cw-<project>-backups \
  --location=us-west1 --uniform-bucket-level-access --public-access-prevention
gcloud iam service-accounts create backup-writer
gcloud storage buckets add-iam-policy-binding gs://cw-<project>-backups \
  --member=serviceAccount:backup-writer@cw-<project>-backups.iam.gserviceaccount.com \
  --role=roles/storage.objectCreator
gcloud storage hmac create backup-writer@cw-<project>-backups.iam.gserviceaccount.com
```

The last command prints an access id and a secret, once. They are
`BACKUP_S3_ACCESS_KEY_ID` and `BACKUP_S3_SECRET_ACCESS_KEY` in step 5; do not
save them anywhere else.

Old snapshots are pruned by the bucket, since the machine cannot delete. Keep
30 days:

```bash
echo '{"rule":[{"action":{"type":"Delete"},"condition":{"age":30}}]}' > /tmp/lifecycle.json
gcloud storage buckets update gs://cw-<project>-backups --lifecycle-file=/tmp/lifecycle.json
```

## 3. The Fly app and its volume

Each project gets its own Fly organization, so no private network joins two
projects.

```bash
fly orgs create cw-<project>
fly apps create cw-<project> --org cw-<project>
fly volumes create cw_data --app cw-<project> --region sjc --size 20
```

Size the volume from the plan's table of projects: the 20 above suits a
project with a staging site, and one that holds only a board needs 1. Fly keeps its own daily volume snapshots for five days on top of
these backups.

## 4. The tunnel

In the Cloudflare dashboard, Zero Trust, Networks, Tunnels: create a tunnel
named `cw-<project>` of type cloudflared and copy its token (it is
`CLOUDFLARE_TUNNEL_TOKEN` in step 5). Then, as the board router README's
steps 1 and 2 describe:

- give the machine an origin hostname whose DNS record points at this tunnel,
  with no Access application on it;
- add the ingress rule: the one address, service `http://localhost:8787`.

## 5. Secrets and settings

```bash
fly secrets set --app cw-<project> --stage \
  CLOUDFLARE_TUNNEL_TOKEN=<from step 4> \
  BACKUP_RECIPIENT=<from step 1> \
  BACKUP_S3_ENDPOINT=https://storage.googleapis.com \
  BACKUP_S3_BUCKET=cw-<project>-backups \
  BACKUP_S3_ACCESS_KEY_ID=<from step 2> \
  BACKUP_S3_SECRET_ACCESS_KEY=<from step 2> \
  CF_ACCESS_TEAM_DOMAIN=<the Mac's value> \
  CF_ACCESS_AUD=<the one address's Access application> \
  CW_PROXIED_TRUSTED_HOSTS=<the one address> \
  CW_PROXIED_TRUSTED_EMAILS=<the owner's email> \
  CW_OWNER_EMAIL=<the owner's email> \
  CW_PUBLIC_BASE_URL=https://<the one address>
```

`--stage` stores them without starting anything; the deploy picks them up.
The settings that are not secret go through `fly secrets` too, so no
project's values are written into the repo.

## 6. Deploy

From the clean clone:

```bash
fly deploy . --app cw-<project> \
  --config infra/project-machine/fly.toml \
  --dockerfile infra/project-machine/Dockerfile \
  --ha=false
```

`--ha=false` keeps it to one machine: two machines on one board would be two
servers writing one corpus.

Check it:

```bash
fly logs --app cw-<project>
fly ssh console --app cw-<project> -C \
  "curl -s -H 'host: localhost:8787' http://127.0.0.1:8787/api/deploy"
```

The curl answers with a JSON `liveness` field (and a 501 for the deploy
half, because a project machine is deployed by `fly deploy`, never by pulling
itself). Then add the project's boards under the machine's origin hostname in
the router's `BOARD_ORIGINS` and open one at the one address.

The plan's unchecked point belongs here too: whether Claude Code's Remote
Control session runs on this machine in a long-lived terminal. That needs the
lead's own user on the machine and is the next task, not this image.

## 7. The first backup

Run one now rather than waiting an hour:

```bash
fly ssh console --app cw-<project> -C \
  "setpriv --reuid=cw --regid=cw --init-groups env HOME=/home/cw bun run /app/infra/project-machine/backup.ts"
```

It prints `[backup] uploaded snapshots/<host>/<time>.cwsnap`. From the Mac,
with Bryan's own Google login (the machine's credential cannot list):

```bash
gcloud storage ls -l gs://cw-<project>-backups/snapshots/**
```

This step is also the first real test of the upload against GCS: the
upload's tests use a stand-in bucket on loopback. If it fails, the error
names the request.

## 8. The restore drill

Do this once before any outsider gets a link, then after any change to
`infra/project-machine/`. It restores onto the Mac, so the identity never goes
near the machine.

```bash
mkdir -p ~/cw-drill && cd ~/cw-drill
gcloud storage cp gs://cw-<project>-backups/snapshots/<host>/<newest>.cwsnap .
# Paste the identity from the password manager into a mode-600 file.
(umask 077 && pbpaste > identity.key)
bun ~/cw-deploy/infra/project-machine/restore.ts \
  --snapshot <newest>.cwsnap --identity-file identity.key --data-dir ~/cw-drill/data
bun ~/cw-deploy/packages/server/src/bin.ts \
  --host 127.0.0.1 --port 8799 --data-dir ~/cw-drill/data
```

Open `http://localhost:8799/workspaces/<board>`: the board, its tasks and
its docs should all be there. Stop the server, then remove `identity.key`.
Keep `data/` until the drill is written up, then delete it; it is a copy.

## Restoring the machine itself

When the volume is lost or its data is bad:

1. Stop the services without stopping the machine:
   `fly ssh console --app cw-<project> -C "touch /data/maintenance"`, then
   `fly machine restart --app cw-<project>`. With that file present the
   machine starts nothing.
2. Move the old data dir aside, never delete it:
   `mv /data/cw /data/cw.before-restore-<date>`.
3. Restore onto the Mac as in step 8, then pack the restored dir and copy it
   up: `tar -czf restored.tgz -C ~/cw-drill/data .`, then
   `fly ssh sftp shell --app cw-<project>` and `put restored.tgz /data/restored.tgz`.
4. On the machine: `mkdir /data/cw && tar -xzf /data/restored.tgz -C /data/cw && chown -R cw:cw /data/cw`,
   then remove `/data/restored.tgz` and `/data/maintenance` and restart the machine.

The restored data is the newest snapshot, up to six hours old. Anything
written after it is in `/data/cw.before-restore-<date>`, if that survived.
