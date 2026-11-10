#!/usr/bin/env bash
# Runs as root inside the container of project-machine-lead-limits-container.test.ts;
# each check prints one `name=value` line.
set -u
D=/app/infra/project-machine
# The image's WORKDIR is root's; the lead's tools run in a folder they can read.
cd /tmp
as() { local u=$1; shift; env -i PATH="$PATH" HOME=/home/$u setpriv --reuid="$u" --regid="$u" --init-groups -- "$@"; }
try() { timeout 6 bash -c "exec 3<>/dev/tcp/$1/$2" 2>/dev/null && echo connected || echo refused; }

bun $D/lead-egress.ts apply >/tmp/apply 2>&1; echo "apply=$?"
echo "apply_line=$(head -1 /tmp/apply)"
as cwproxy bun $D/lead-proxy.ts serve 2>/tmp/proxy &
as lead bun $D/lead-egress.ts probe >/tmp/probe 2>&1; echo "probe=$?"
echo "probe_line=$(head -1 /tmp/probe)"
echo "root_public=$(try 1.1.1.1 443)"
echo "lead_public=$(as lead bash -c "$(declare -f try); try 1.1.1.1 443")"
echo "cwdev_public=$(as cwdev bash -c "$(declare -f try); try 1.1.1.1 443")"
echo "proxy_public=$(as cwproxy bash -c "$(declare -f try); try 1.1.1.1 443")"

# The lead's tools, each given the proxy only through the environment the
# entrypoint sets.
P=http://127.0.0.1:3128
lead() { as lead env HTTPS_PROXY=$P HTTP_PROXY=$P https_proxy=$P http_proxy=$P NO_PROXY=localhost,127.0.0.1,::1 "$@"; }
fetch='try{const r=await fetch(process.argv[1],{signal:AbortSignal.timeout(8000)});console.log(r.status)}catch{console.log("refused")}'
echo "lead_fetch_npm=$(lead bun -e "$fetch" https://registry.npmjs.org/is-number)"
echo "lead_fetch_unlisted=$(lead bun -e "$fetch" https://example.com/)"
lead bash -c 'mkdir -p ~/pkg && cd ~/pkg && echo "{\"dependencies\":{\"is-number\":\"7.0.0\"}}" >package.json && timeout 60 bun install' >/tmp/install 2>&1
echo "lead_bun_install=$?"
lead timeout 30 git ls-remote https://github.com/git/git HEAD >/tmp/git 2>&1; echo "lead_git_https=$?"
ssh_opts=(-T -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=/dev/null -o ConnectTimeout=6)
echo "lead_ssh_proxied=$(lead timeout 20 ssh "${ssh_opts[@]}" -o "ProxyCommand=bun $D/lead-proxy.ts connect %h %p" git@github.com 2>&1 | tr '\n' ' ')"
echo "lead_ssh_direct=$(lead timeout 20 ssh "${ssh_opts[@]}" git@github.com 2>&1 | tr '\n' ' ')"
echo "proxy_log=$(tr '\n' ' ' </tmp/proxy)"

bun $D/lead-egress.ts apply >/dev/null 2>&1; echo "refresh=$?"
echo "jumps=$(iptables -S OUTPUT | grep -c CW-LEAD-EGRESS) jumps6=$(ip6tables -S OUTPUT | grep -c CW-LEAD-EGRESS)"

# Memory: the lead raises its oom_score_adj floor only through root, and the
# watchdog kills a lead process that grows past a 48 MiB cap.
as lead sleep 30 & child=$!
sleep 0.5
echo 1000 > /proc/$child/oom_score_adj
echo "oom=$(cat /proc/$child/oom_score_adj)"
as lead bash -c "echo 0 > /proc/$child/oom_score_adj" 2>/dev/null && echo "oom_lowered=yes" || echo "oom_lowered=no"
kill $child; wait $child 2>/dev/null
as lead bun -e 'const a=[];for(let i=0;i<12;i++){a.push(Buffer.alloc(8<<20,1));await Bun.sleep(100)}console.log("survived");await Bun.sleep(20000)' >/tmp/grow 2>&1 & grow=$!
CW_LEAD_MEMORY_POLL=0.2 bash $D/lead-memory.sh watch 48M 10004 >/tmp/watch 2>&1 & dog=$!
wait $grow; echo "grow_exit=$?"
kill $dog
echo "grow_out=$(cat /tmp/grow | tr '\n' ' ')"
echo "watch_line=$(grep 'killing' /tmp/watch | head -1)"
echo "lead_left=$(bash $D/lead-memory.sh total 10004)"
