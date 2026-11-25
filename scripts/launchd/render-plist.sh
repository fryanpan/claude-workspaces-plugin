#!/usr/bin/env bash
# Renders the server's LaunchAgent plist for scripts/launchd/install.sh.
#
# It lives in its own sourceable file so a test can render the real template
# and read the result. install.sh itself cannot run in a test: it kills
# whatever listens on :8787, which on this machine is production.
#
# render_plist <template> <default-label> <label>
#   Prints the filled-in plist on stdout. The first expression renames the
#   template's label (and the log files named after it) when <label> differs
#   from <default-label>; with the default it changes nothing. The caller
#   validates <label> first, so it carries no `|`. Every other value comes
#   from the variables install.sh sets: REPO_DIR, BUN_BIN, BUN_DIR, HOME,
#   DATA_DIR, LOG_DIR and the optional settings below them.
render_plist() {
    local template="$1" default_label="$2" label="$3"
    local default_label_re="${default_label//./\\.}"
    sed \
        -e "s|${default_label_re}|${label}|g" \
        -e "s|{{REPO_DIR}}|${REPO_DIR}|g" \
        -e "s|{{BUN_BIN}}|${BUN_BIN}|g" \
        -e "s|{{BUN_DIR}}|${BUN_DIR}|g" \
        -e "s|{{HOME_DIR}}|${HOME}|g" \
        -e "s|{{DATA_DIR}}|${DATA_DIR}|g" \
        -e "s|{{LOG_DIR}}|${LOG_DIR}|g" \
        -e "s|{{PUBLIC_BASE_URL}}|${PUBLIC_BASE_URL}|g" \
        -e "s|{{REQUIRE_EMAIL_AUTH}}|${REQUIRE_EMAIL_AUTH}|g" \
        -e "s|{{OWNER_EMAIL}}|${OWNER_EMAIL}|g" \
        -e "s|{{SHARE_PUBLIC_HOSTNAME}}|${SHARE_PUBLIC_HOSTNAME}|g" \
        -e "s|{{ACCESS_TUNNEL_HOSTS}}|${ACCESS_TUNNEL_HOSTS}|g" \
        -e "s|{{PROXIED_TRUSTED_HOSTS}}|${PROXIED_TRUSTED_HOSTS}|g" \
        -e "s|{{PROXIED_TRUSTED_EMAILS}}|${PROXIED_TRUSTED_EMAILS}|g" \
        -e "s|{{ACCESS_TEAM_DOMAIN}}|${ACCESS_TEAM_DOMAIN}|g" \
        -e "s|{{ACCESS_AUD}}|${ACCESS_AUD}|g" \
        "${template}"
}
