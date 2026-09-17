# dsh-vps-manager

[中文](README.zh-CN.md) | English

Manage your VPS fleet from inside DeepSeek Harness: **look things up with one click, tell the AI what to do, install common software with one line from the recipe library.**

All three share one execution engine, so locking, backups, task tracking and the audit log are implemented once and behave the same no matter which entrance you use.

---

## Three ways to use it

| | Look things up | Tell the AI | One-click install |
|---|---|---|---|
| How | `/vps-sysinfo` and friends | "set up a reverse proxy on hk" | `/vps-recipes` to pick, `/vps-install` to run |
| Uses the model | No | Yes | No |
| Cost | Zero tokens | Normal tokens | Near zero |
| Scope | Fixed read-only queries | Anything you can do over SSH | Curated, idempotent recipes |

---

## Requirements

- macOS or Linux host (Windows' bundled OpenSSH has no connection multiplexing)
- Node.js >= 22.13
- **Key-based SSH only.** Password login and password-prompting `sudo` are not supported: in a non-interactive session `sudo` would read your script as the password
- The remote user must be `root` or have passwordless `sudo` for anything that changes the system. Read-only queries work either way

---

## Install

Not on npm yet. To run it from source:

```bash
git clone https://github.com/AIcivilization/dsh-vps-manager.git
cd dsh-vps-manager && npm install
```

Then link it into your DSH profile and add it to the profile's bundle list:

```bash
ln -s "$PWD" ~/.dsh/profiles/desktop/node_modules/dsh-vps-manager
```

Add `"dsh-vps-manager"` to `dsh.profile.bundles` in `~/.dsh/profiles/desktop/package.json`, then **restart DSH**. Plugin code is loaded at boot; editing files does not hot-reload.

---

## Quick start

Open **DSH Settings → VPS Manager** and click **Add machine**. The wizard walks through four steps:

1. **Details** — address, port, user, alias, note, group
2. **Key** — generates a dedicated `~/.ssh/dsh_vps_ed25519`; your existing keys are left alone
3. **Place the public key** — three options, and the plugin never handles your password:
   - Paste the public key into your provider's "SSH keys" page (best for a fresh box)
   - Copy a one-liner and run it on a server you can already log into
   - Open a terminal with `ssh-copy-id` prefilled and type the password yourself
4. **Save** — writes `~/.ssh/config.d/dsh-vps.conf`, adds a single `Include` line at the top of your `~/.ssh/config` (backing it up first), then runs a health check

Your own `~/.ssh/config` entries are never rewritten. Machines you already have there can be adopted read-only via **Import from ~/.ssh/config**.

---

## Commands

Queries run without the model and cost no tokens. Each result starts with a one-line summary, because DSH collapses command output to its first line.

| Command | What it shows |
|---|---|
| **`/vps-help`** | **Everything: all commands with their arguments, how to target a machine, what to say to the AI, where machines are added** |
| `/vps-sysinfo` | OS, CPU, memory, disk, load, public IP |
| `/vps-disk` | Mounts, inodes, largest directories (time-capped) |
| `/vps-ports` | Listening ports and owning processes |
| `/vps-services` | Failed and running services |
| `/vps-net` | Interfaces, cumulative traffic, connection count |
| `/vps-docker` | Containers and disk usage |
| `/vps-ping` | Quick health line |
| `/vps-logs <service>` | Last 100 log lines |
| `/vps-probe` | Re-run the health check (OS, init, privilege, resources) |
| `/vps-reboot [--yes]` | Reboot the server. First checks why a reboot is needed, whether now is safe, and which containers will stop; `--yes` reboots, waits for the machine to come back, and reports kernel, containers and failed services |
| `/vps-sh [--yes] <command>` | Run a command on the current machine; output lands in the conversation. Dangerous commands need `--yes` |
| `/vps-q <recipe id>` | Run any read-only recipe that has no dedicated command |
| `/vps-list` | Registered machines and status |
| `/vps-use <alias>` | Bind this conversation to a machine (`off` to unbind) — the same thing the header switch does |
| `/vps-recipes [keyword]` | List recipes |
| `/vps-install <id> [key=value …] [--yes]` | Show the plan (with parameters and defaults), then run it with `--yes` |
| `/vps-tasks [id] [--stop]` | Remote tasks, their logs, and termination |
| `/vps-doctor` | Self-check: plugin state, current machine, connectivity, recent runs |

All of them default to the current machine and accept `-h <alias>`.

---

## Talking to the AI

Five tools are registered: `vps_hosts`, `vps_exec`, `vps_write_file`, `vps_task`, `vps_recipe`.

Every script is classified before it runs, and **the level the AI declares can only raise the result, never lower it**:

| Level | Examples |
|---|---|
| **read** | `df -h`, `systemctl status`, `docker ps`, `journalctl` |
| **change** | `apt-get install`, `sed -i`, `systemctl restart`, writing a file |
| **danger** | `rm -rf`, `mkfs`, firewall edits, `passwd`, `reboot`, `curl … \| sh` |

What happens next depends on the confirmation level of that machine (machine > group > global):

| Level | read | change | danger |
|---|---|---|---|
| **careful** (default) | auto | ask | ask |
| **relaxed** | auto | auto | ask |
| **auto** | auto | auto | auto |
| headless / no approver | auto | **denied** | **denied** |

Three protections come with it:

- **File edits are backed up automatically.** `vps_write_file` backs up, writes atomically, runs your validation command, and restores the original if validation fails. Backups never land in the target directory, where globs like `sites-enabled/*` would pick them up
- **A connectivity safety net** for firewall, SSH and network changes: a revert is scheduled on the server first, then the change runs, then a **brand-new connection** is tested (bypassing multiplexing, or the test would reuse the pre-change connection and lie). If it fails, the revert fires
- **Cancelling detaches, it does not kill.** Long operations run as remote tasks that survive disconnection; killing a package manager mid-run is usually worse than letting it finish. Terminating is always explicit

---

## Recipes

29 built-in recipes ship today: 16 read-only queries plus 13 install/config recipes (Docker, Nginx, BBR, system update, cleanup, common CLI tools, swap, timezone, automatic security updates, fail2ban, Portainer, Uptime Kuma, Nginx Proxy Manager). Each install recipe has `detect` (is it already there), `plan` (what it will do, in plain language), `run` (idempotent) and `verify` (**prove it works** — `docker info`, not `docker --version`).

Add your own two ways:

- Let the AI save one. After it finishes something reusable, ask it to save the steps as a recipe: it turns the specific values into parameters, writes `detect`/`verify`, and the plugin scans for credentials before it lands in `$DSH_HOME/vps-manager/recipes/`
- Drop a YAML file in that directory yourself

User recipes are treated as untrusted input: their level is the stricter of what they declare and what static analysis finds, and the first run of new or modified content asks for confirmation.

How to use them: `/vps-recipes [keyword]` to pick, `/vps-install <id>` to see the plan (parameters, defaults and the script itself), then `/vps-install <id> key=value --yes` to run it. Long installs detach into a remote task; `/vps-tasks` follows it and `/vps-tasks <id> --stop` terminates it.

---

## Interface

The rule is: **if the conversation can do it, the UI should not.** The sidebar panel (machine list, app store, system maintenance, task page) has been removed entirely — picking software, checking a task, running maintenance are all one sentence away in the conversation, and a page only adds a step. Three things stayed, because the conversation cannot do them well.

### 1. The VPS switch in the conversation header

Just the word `VPS` followed by one small rounded square per machine, no menus. Green means this conversation is bound to that machine, red means it is not; with several machines the squares are numbered. Click one to bind, click it again to unbind, and only one can be lit at a time.

Turn it on and this conversation is bound to one machine: commands drop the `-h` flag and the AI may omit `host` — you just talk. Turn it off and the conversation has nothing to do with servers again — with the switch off there is **no default machine at all**: commands need an explicit `-h`, and the AI must name the host. (`/vps-use <alias>` and `/vps-use off` do the same thing from the keyboard.) The binding is per conversation, so another window switching machines cannot affect this one.

### 2. The status line under the composer

**Nothing at all** unless something is worth interrupting you for: a background task still running, the machine unreachable, or the disk nearly full. Everything else — queries, installs, questions — is just conversation, because that is what the conversation is for.

### 3. DSH Settings → VPS Manager

Adding machines, editing connections, setting policy: these are forms, which conversations are bad at, so they live in settings — always visible, always editable, never through the model.

- **Machine list** — number (matching the squares in the conversation header), address, privilege, group, note; one-click connectivity test
- **Add machine** — the four-step wizard described under *Getting started*
- **Import from ~/.ssh/config** — adopt machines you can already reach
- **Per-machine settings** — alias, address, port, user, jump host, key placement, host fingerprint, confirmation level, removal. Saving a connection change tests it first
- **Basics form** (inside machine settings) — fill in the target state (timezone, swap size, BBR, automatic security updates, fail2ban, common CLI tools) and save: only the items that differ from the current state are executed, one remote task each, with live progress
- **Global settings** — default confirmation level, safety-net seconds, LAN toggle, data paths

The routes behind that page are protected by a per-boot token injected into the page, a same-origin check and JSON-only requests. **They never expose free-form command execution or arbitrary file writes.** If DSH's web server is bound to `0.0.0.0`, everything that changes state is disabled until you opt in.
---

## What this does not protect against

Stated plainly, because a security feature you misunderstand is worse than none:

- Tiered confirmation guards against **the AI making a mistake**, not against an AI deliberately working around it. Static analysis cannot catch every obfuscation, and the model can reach your servers through its own bash tool
- The host sandbox does not cover this plugin: its `spawn` is outside the confined bash/filesystem/terminal capabilities
- There is no general rollback. You get file backups, the connectivity safety net, and idempotent recipes. Snapshot your server before big changes

---

## Data

| Path | Contents |
|---|---|
| `$DSH_HOME/vps-manager/hosts.yml` | Machine list, groups, confirmation levels (hand-editable) |
| `$DSH_HOME/vps-manager/recipes/` | Your own recipes |
| `$DSH_HOME/vps-manager/audit/` | One JSON line per execution (who, where, what, outcome) |
| `~/.ssh/config.d/dsh-vps.conf` | Connection config the plugin owns |
| `~/.cache/dsh-vps/` (remote) | Task directories, logs, backups |

Private keys are never read by the plugin, and passwords never pass through it.

---

## Development

```bash
npm install
npm test
```

123 tests, no server required: local `sh -s` stands in for a remote `sshd`, which is enough to exercise the payload protocol, task lifecycle, locking, backup/restore, tier classification, settings routes and UI rendering.

---

## License

MIT
