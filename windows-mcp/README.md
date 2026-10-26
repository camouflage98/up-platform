# windows-mcp

An MCP server that gives an AI assistant hands-on control of a Windows machine: run PowerShell
and cmd, hold open interactive terminals, launch and close applications, download files, and
install packages with winget, Chocolatey or Scoop.

It speaks MCP over stdio, so any MCP client can drive it: Claude Desktop, Claude Code, or your
own.

**The server has to run on the Windows machine you want to control.** It is the local agent for
that box, not a remote controller. Started anywhere else, every OS-facing tool refuses with an
explanation instead of pretending to work.

## Install

On the Windows machine, with [Node.js 20+](https://nodejs.org):

```powershell
git clone <this-repo> windows-mcp
cd windows-mcp
npm install
npm run doctor
```

`npm run doctor` prints what the server found: PowerShell version, which package managers are
installed, the folders it may touch, and where the audit log goes. Fix anything it flags before
wiring it into a client.

## Connect a client

### Claude Desktop

Edit `%APPDATA%\Claude\claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "windows": {
      "command": "node",
      "args": ["C:\\path\\to\\windows-mcp\\src\\index.js"],
      "env": {
        "WINDOWS_MCP_CONFIG": "C:\\path\\to\\windows-mcp\\config.json"
      }
    }
  }
}
```

Restart Claude Desktop. The tools appear under the plug icon.

### Claude Code

```powershell
claude mcp add windows -- node C:\path\to\windows-mcp\src\index.js
```

Or commit a `.mcp.json` in your project with the same `command` and `args` shape as above.

## What it can do

| Tool | What it does |
| --- | --- |
| `powershell_run` | Run a PowerShell command, get stdout, stderr and exit code |
| `cmd_run` | Same through `cmd.exe`, for batch syntax and older tools |
| `terminal_open` | Start a persistent shell that keeps its state between calls |
| `terminal_run` | Run a command in that shell and wait for it to finish |
| `terminal_send_input` | Type into a program that is sitting at a prompt |
| `terminal_read` | Drain whatever a terminal has printed since the last read |
| `terminal_list` / `terminal_close` | See and close open terminals |
| `app_open` | Launch an app, document, folder, shell URI or URL |
| `app_find` | Turn "my editor" into an exact Start Menu or App Paths target |
| `app_list_installed` | List installed programs from the uninstall registry |
| `process_list` | Running processes with pid, memory and window title |
| `process_stop` | Ask a program to close, or force it |
| `window_focus` | Bring a window to the front by pid or title |
| `file_list` / `file_search` | Browse and search folders |
| `file_read` / `file_write` | Read and write files, text or base64 |
| `file_move` / `file_delete` | Move, copy, rename, delete |
| `known_folders` | Real paths of Desktop, Documents, Downloads, AppData |
| `download_file` | Fetch a URL to disk, with size limit and SHA-256 |
| `package_search` / `package_install` / `package_uninstall` / `package_list` | winget, Chocolatey, Scoop |
| `system_info` | Windows build, CPU, memory, uptime, free disk |
| `clipboard_read` / `clipboard_write` | Read and set the clipboard |
| `screenshot` | Capture the screen and return the image |
| `admin_status` | Report whether administrator rights are available, and how UAC is set |
| `admin_run` | Run one command as administrator |
| `server_policy` | Report exactly what this server is allowed to do |

### One-shot commands versus terminals

`powershell_run` is non-interactive. A command that stops to ask something will sit there until
the timeout. Anything interactive, or anything where state has to survive between commands, goes
through a terminal:

```
terminal_open        -> { "terminalId": "term_a1b2c3d4" }
terminal_run         -> cd C:\src\app; .\venv\Scripts\Activate.ps1
terminal_run         -> pip install -r requirements.txt     (still in the venv, still in that folder)
terminal_send_input  -> Y                                    (answers a prompt)
terminal_close
```

Terminals are closed after 30 minutes idle, and there is a cap on how many can be open at once.

## Safety model

The server assumes it is running on someone's real desktop, with their files and their logged-in
sessions on it. Four things hold it in:

**Blocked commands.** Patterns whose only purpose is destroying the machine or its backups are
refused outright: volume formatting, `diskpart`, `bcdedit`, deleting shadow copies, wiping
`C:\Windows`, disabling Defender's real-time protection. Editing `blockedCommandPatterns` in your
own config is the only way past them.

**Confirmation.** Recursive deletes, service changes, registry writes, user-account changes,
shutdowns, uninstalls, elevated launches and package installs all need `confirm: true` on the
call. The tool description tells the model that confirmation is the user's decision to make, so
the intended flow is: show the exact command, ask, then repeat the call with `confirm: true`.

**Path roots.** File tools only reach paths under `allowedRoots`, which defaults to the user
profile and temp. Anything matching `deniedPathPatterns` is refused even inside a root. Set
`"allowedRoots": []` explicitly if you want the whole filesystem; an empty list that comes from a
failed variable expansion falls back to the user profile rather than opening everything.

**An audit log.** Every call appends a JSON line with the tool, its arguments, whether it
succeeded and how long it took. Arguments that look like secrets are redacted. Default location:
`%LOCALAPPDATA%\windows-mcp\audit.jsonl`.

None of this is a sandbox. The server runs with your Windows account's privileges and a
determined command can still do real damage. Treat it like handing someone your keyboard: fine
for a machine you own, not for a shared or production box. Elevated launches and most installers
still raise a UAC prompt that only the person at the keyboard can accept.

## Administrator access

Some things genuinely need administrator rights: a machine-wide install, a service, most registry
writes under `HKLM`, a driver. Windows does not let a program grant itself those rights, and
nothing in this server tries to. `admin_status` reports what is actually possible on the machine:
whether the server is already elevated, whether the signed-in account could elevate at all, and
whether UAC will prompt.

There are three ways to give the assistant admin, in increasing order of how much you hand over.

### 1. Per-command elevation, with you accepting the prompt (recommended)

Leave the server unelevated and use `admin_run`. Each call raises a UAC prompt that you accept in
person, the command runs elevated, and its combined output and exit code come back:

```
admin_run  { "command": "Install-WindowsFeature -Name Telnet-Client", "confirm": true }
```

Nothing runs admin unless you click Yes on that specific action, so a mistake costs one prompt.
The cost is that you have to be at the keyboard, and the call blocks while it waits for you.
Output arrives as one combined stream rather than separate stdout and stderr, because Windows will
not let an elevated child write back into an unelevated parent's pipes.

For installs, `package_install` takes `elevated: true` for the same flow, and `scope: "user"` for
the opposite one: many winget packages install per-user with no admin at all. Try user scope first.

### 2. Start the whole server elevated

Launch your MCP client, or the server, from an administrator terminal. Child processes inherit the
elevated token, so every tool call runs as admin with no prompts and nothing blocks waiting for
you. `admin_status` will say `serverProcessElevated: true`.

Understand what this changes. UAC is the thing that was making a mistake cost one click, and this
removes it for every call, not just the ones you were thinking of. The blocked-command list and
the path roots become the only thing between a badly worded request and your system folders, and
they are pattern matching, not a sandbox. If you do this, tighten the config: narrow
`allowedRoots`, and consider `"features": { "packages": false }`.

Worth doing for a machine you are rebuilding or a VM you can throw away. Not worth doing on your
daily driver.

### 3. A pre-registered elevated task

An administrator can register a scheduled task once with "Run with highest privileges", and a
non-elevated caller can then start it without a prompt. That gives unattended admin for one fixed
job, which is the legitimate use: a specific maintenance script you already trust.

Do not use it as a general escape hatch. A task that takes a command as an argument is a standing
UAC bypass for anything on the machine that can start a task, including malware that has nothing
to do with this server. If you register one, hard-code the exact command and accept no arguments.
There is no tool in this server for this on purpose.

### What not to do

Setting UAC to "Never notify", or `ConsentPromptBehaviorAdmin` to 0, makes every elevation on the
machine silent, for every program, forever. `admin_status` reports it as a weak configuration. The
same goes for `runas /savecred`, which stores admin credentials for any process running as you.

Even with admin, two things stay out of reach. The server cannot accept a UAC prompt on your
behalf: that prompt lives on the secure desktop, where no automation can click. And an installer
that insists on its own interactive wizard needs a person, or a silent-install flag that the
vendor supports.

## Configuration

The server reads the first of these that exists:

1. `$env:WINDOWS_MCP_CONFIG`
2. `config.json` beside `package.json`
3. `%LOCALAPPDATA%\windows-mcp\config.json`
4. `~\.windows-mcp.json`

Copy `config.example.json` to `config.json` and edit. Values expand `%VAR%`, `$env:VAR` and a
leading `~`. A malformed config is a startup error, not a silent fallback to defaults.

| Key | Meaning |
| --- | --- |
| `allowedRoots` | Folders the file tools may touch. `[]` means unrestricted |
| `deniedPathPatterns` | Regexes refused even inside an allowed root |
| `writeEnabled` | `false` makes the server read-only |
| `downloadDir` | Where `download_file` puts things by default |
| `allowedDownloadHosts` | Empty means any HTTPS host |
| `allowInsecureDownloads` | Allow plain HTTP. Off by default |
| `maxDownloadBytes` | Size ceiling, enforced while streaming |
| `defaultTimeoutMs` / `maxTimeoutMs` | Command timeouts |
| `maxOutputBytes` | Output above this is truncated in the middle, keeping head and tail |
| `maxTerminals` / `terminalIdleTimeoutMs` | Terminal limits |
| `powershellPath` / `preferPwsh` | Which PowerShell to drive. Defaults to pwsh 7, then Windows PowerShell |
| `packageManagers` | Which of winget, choco, scoop are permitted |
| `features` | Turn off whole groups: `shell`, `terminals`, `apps`, `files`, `downloads`, `packages`, `system`, `admin` |
| `blockedCommandPatterns` | Refused outright |
| `confirmCommandPatterns` | Allowed only with `confirm: true` |
| `auditLogPath` | `null` disables the log |

A locked-down example, for a machine where the assistant should only look and fetch:

```json
{
  "allowedRoots": ["%USERPROFILE%\\Projects"],
  "writeEnabled": false,
  "features": { "packages": false, "terminals": false },
  "allowedDownloadHosts": ["github.com", "objects.githubusercontent.com"]
}
```

## Tests

```powershell
npm test
```

The suite covers the policy engine, the download path end to end against a local HTTP server, and
the MCP surface itself over a real stdio client. It runs on any platform: the OS-facing tools are
expected to refuse when the host is not Windows, and the tests assert that they do.

## Troubleshooting

**"This tool controls a Windows machine, but the server is running on linux."** The server is not
on the Windows box. Install and start it there.

**"No PowerShell executable found."** Set `powershellPath` to the full path of `powershell.exe` or
`pwsh.exe`.

**A call was refused and you want to know why.** Call `server_policy`. It reports the config file
in use, the allowed roots, the enabled features and both pattern lists.

**Screenshots come back black or fail.** The server has to run in the interactive desktop session.
A service, a scheduled task with no desktop, or a disconnected RDP session has no screen to
capture.

**Nothing happens after an install.** Some installers raise UAC. Check the machine for a prompt
waiting to be accepted.

**`admin_run` came back saying the prompt was declined.** The UAC dialog was dismissed, or it
timed out behind another window. Nothing ran. Check the machine and call again.

**An elevated command timed out.** The elevated process may still be running, and an unelevated
server cannot stop it. Look at the machine before retrying, or the second attempt will collide
with the first.
