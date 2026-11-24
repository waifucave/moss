# Windows: two questions for you

On Windows, the bots' commands already run in MOSS's sandbox. Two parts are waiting on your answers. Each question
below says what the choice is, the options, what each one costs you and what it risks, and what we recommend.

## 1. Should MOSS start before you sign in to Windows?

**The choice.** Today MOSS starts when you sign in to Windows. Until you do (after a restart or an update, say), your
bots, routines and the other computers that reach this one through MOSS wait. MOSS can start when Windows starts
instead, before anyone signs in. Windows only does that for a program it can sign in for you, so it needs to keep a
way to sign in as you.

**Option A: start when you sign in (what MOSS does today).**
- Costs you: nothing to set up.
- Risks: after a restart nothing runs until you sign in. A routine due at 3 a.m. after a night-time update waits
  until you sign in, and a phone or another computer can't reach this one until then.

**Option B: start when Windows starts, with your Windows password kept by Windows.**
- Costs you: you type your Windows password once, when you turn this on. Windows keeps it in its own protected
  store; MOSS never sees it again and never writes it anywhere. When you change your Windows password, MOSS stops
  starting at boot until you type the new one, and it tells you so.
- Risks: anyone with administrator rights on this PC can already run programs as you; this doesn't change that. If
  you sign in with a Microsoft account or a PIN, it's still your account password (not the PIN) that Windows asks for.
  Our tests prove that MOSS and its sandbox work when started this way.

**Option C: start when Windows starts, without your password.**
- Costs you: nothing to type.
- Risks: Windows starts it in a cut-down way. MOSS can't reach anything that needs your sign-in on the network
  (a shared drive, a work proxy) and can't read the passwords Windows keeps for you. Some things then fail quietly
  until you sign in.

**Our recommendation: B,** as a switch in Settings that is off until you turn it on, for the PC you leave running.
Keep A on a laptop you sign in to every day.

## 2. When a bot's command needs your sign-in to a service, how should MOSS lend it?

**The choice.** A bot's commands run in a sandbox that can't read your passwords and keys. That's on purpose. It also
means a bot can't `git push` to your GitHub, run `gh` (GitHub's command-line tool), pull a private Docker image, or
use your SSH keys. MOSS can stand in the middle and lend your sign-in to one command at a time, without ever handing
the bot the password or key itself. We need five answers from you.

**2a. Which tools should be able to ask?**
- git (push and pull to services you're signed in to).
- gh (GitHub's tool: issues, pull requests, releases).
- Docker (pulling and pushing images from registries you're signed in to).
- SSH keys (git over SSH, signing in to servers).
- Costs and risks: each one you turn on is one more way a bot can act as you on that service. None is on by default.
  What we have to build for each: git is small, Docker is medium, SSH is medium to large, gh is large (it needs a
  go-between for GitHub's whole API, unless you allow handing the bot a GitHub token, which we don't recommend).

**2b. How should each use be approved?**
- A card every time a command uses your sign-in. The safest, but noisy for a bot that pushes often.
- A card the first time for each bot and each service (say, "Luna may push to github.com"), then no more cards for
  that pair. You can take it back in Settings.
- No card for services you list in Settings ahead of time; a card for anything else.
- Our recommendation: once per bot and service, with the list in Settings showing what each bot may use.

**2c. Which places?**
- Only the place the bot's project already points at (for git, the repository's own remote).
- Any address the command names.
- Our recommendation: only the project's own remote, plus any you add by hand. "Any address" lets a bot send your
  sign-in anywhere a command names.

**2d. SSH keys: which keys, and should each use ask?**
- Every key your SSH agent holds, or only keys you pick.
- A card for every signature (each time a key is used), or only per bot and server as in 2b.
- Risks: a key that signs in to a server opens everything that server allows, not just one project.
- Our recommendation: only keys you pick, and a card per bot and server.

**2e. Docker and gh: how much may a bot do?**
- Docker: download images only, or upload too.
- gh: read only (issues, pull requests), or also make changes (open pull requests, comment, release).
- Risks: uploading an image or making a release is public and hard to take back.
- Our recommendation: Docker download only, and gh read-only, until you choose more for a bot.
