# Sourced by entrypoint.sh and backup-once.sh, which run as root. Each helper
# changes the environment of the shell it runs in, so call them inside a
# subshell: `( drop_secrets; run_as cw … ) &`.

# The secrets the board server must never hold. Its own Claude key and its
# Access settings are not here: those are the server's to use. The lead's
# Claude Code sign-in and deploy key are the lead's alone (lead.sh).
MACHINE_SECRETS=(CLOUDFLARE_TUNNEL_TOKEN TUNNEL_TOKEN BACKUP_S3_ACCESS_KEY_ID BACKUP_S3_SECRET_ACCESS_KEY CLAUDE_CODE_OAUTH_TOKEN CW_LEAD_GITHUB_DEPLOY_KEY)

# Where the users' homes are. Overridable only so a test can run this off a
# machine.
HOMES="${CW_MACHINE_HOME_ROOT:-/home}"

drop_secrets() {
  local s
  for s in "${MACHINE_SECRETS[@]}"; do unset "$s"; done
}

# Unset every exported variable but the ones named.
only_env() {
  local v keep=" $* "
  for v in $(compgen -e); do
    [[ $keep == *" $v "* ]] || unset "$v" 2>/dev/null || true
  done
}

# Replace this shell with `$@` running as user `$1`, with that user's home.
# setpriv passes the environment through unchanged, and leaving root drops
# every capability.
run_as() {
  local user=$1
  shift
  export HOME="$HOMES/$user" USER="$user" LOGNAME="$user"
  exec setpriv --reuid="$user" --regid="$user" --init-groups -- "$@"
}
