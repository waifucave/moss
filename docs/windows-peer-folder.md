# A peer's command writing its folder on a Windows holder: design

Lane XC, 2026-11-28. This is the design for owed item "a peer's command writing its folder on Windows"
(`docs/across-computers-owed.md`, step 3b). The controller ruled that Windows follows Linux's rule: hold what exists,
sweep afterwards, and check identity. Reviewer a8f9eaf75511cf722 read the first version and asked for four changes,
which are folded in below (§2.2, §2.3, §3, §4).

No code is written yet. The code waits until lane WA's `wa-win-tasks` (the hold release on a stop) and
`wa-launch-line` have landed, because both edit `packages/core/src/fence/win-fenced.ts`.

## 1. What holds today, and why macOS's rule can't be followed

A peer call that is given its folder runs under the fence a local bot's commands get: `fencedSpawner` over
`peerFence` with the folder, so the same win-fenced plan. The folder is a persistent write root. Its denies are
`peerFolderDenies(folder, os: "windows")`: the run-later patterns `<folder>\**\.git`, `.envrc`, `.vscode` and the
rest, plus the user's secret places.

- **Rule 4.** Every match that exists at the start is stamped with a deny-write. The `**` walk has no depth cap, only a
  budget of 200,000 entries per root. Past the budget, the folders it didn't read are denied whole (at most 256 after
  collapsing).
- **Rule 7.** After the run, the patterns are walked again, and a new match is moved into the MOSS home's quarantine.
- **Why not macOS's rule.** NTFS ACLs sit on objects, not on names, so nothing can refuse a `.git` that doesn't exist
  yet.
- **What the stamps refuse.** With srt-win patch 0004 a stamped entry can't be replaced in place: the write deny holds
  DELETE, and its parent carries a FILE_DELETE_CHILD deny. A command can still rename a folder ABOVE a held entry,
  because the root's MODIFY_NO_FDC grants DELETE on it. It can also make a junction there, which needs no privilege.

Today rule 7 compares by path (`quarantinePatternMatches`: a match is new only when its path wasn't in the start
walk). So `ren proj proj-old && mkdir proj\.git\hooks` keeps the planted `proj\.git` and moves the person's real repo,
now `proj-old\.git`, aside. The rest of this document replaces the path comparison with identities.

## 2. Identity records

### 2.1 The identity

An entry's identity is (volume serial, 64-bit file index, kind):

- It comes from `lstatSync(p, { bigint: true })`: `dev` and `ino`, as libuv reads them (`FileFsVolumeInformation`,
  `FileInternalInformation`). On NTFS this is the MFT reference, which is the low half of `FILE_ID_INFO`'s 128-bit
  id, the key srt-win itself uses (`path_id.rs`, `capture_file_id`).
- It must be read as a bigint: the sequence number puts it above 2^53.
- The kind is file, folder, or reparse point (junction or symbolic link), read with lstat, never following.
- **NTFS only.** On ReFS (a Dev Drive) the 64-bit index isn't guaranteed unique, so a folder on a volume that isn't
  NTFS gets no peer folder, and the bot is told why. The file system is learned once per volume per process from
  `fsutil fsinfo volumeinfo <drive>:` ("File System Name"), a plain exe with no PowerShell.
- **Fallback.** If the probe (§5, test 0) shows Bun's `ino` is 0 or rounded, the identity comes from an srt-win patch
  that adds `srt-win fs id --json <paths>` over `capture_file_id`. That is lane WA's vendor area.

### 2.2 What is recorded at the start (change 1: the chain)

Before the command runs, MOSS records:

- **Each held entry.** Every path rule 4 stamps under the folder: the held matches, and the folders denied whole past
  the budget. Each gets its identity.
- **Every folder on the way.** Every folder from the root down to each held entry, with its identity, so each folder
  is recorded once. A path that resolves through a link is never recorded: the start walk doesn't go through links,
  and the chain is lstat'ed component by component from the root.
- **Every reparse point the start walk saw** under the folder, by path and identity.

The cap is 10,000 records in all. Past the cap the call gets no folder: it runs temp-only, and the bot is told.

### 2.3 What is checked after the run

Every check goes from the root down, one lstat per component, and never through a link.

1. **The chain.** For each recorded path, the first folder on its way that is now a reparse point, or whose identity
   changed, or that is gone, is where the plant is. Take `ren proj proj-old && mklink /J proj C:\Users\x\other-repo`:
   the recorded `proj\.git` would resolve into other-repo, but the check stops at `proj`. That component itself (the
   junction, never what it points to) is moved aside. `winChainIsClean` already refuses moving a path that goes
   through a link. Moving the link itself is allowed, because the folders above it are checked clean by this same
   walk.
2. **The held entry.** A recorded path that still resolves through a clean chain but has a different identity is
   planted, and is moved aside with reason "replaced while held". Nothing is spared. On Linux, a start-time plain file
   replaced in the same parent is left alone, because that is how an editor saves. On Windows that can't happen: the
   stamps refuse it. So a replacement seen at the same path means a stamp failed, and it is moved aside and said as a
   fence fault.
3. **The same identity at another path (change 2).** When a match has a recorded identity at a path other than the
   recorded one:
   - **The moved original.** If the recorded path no longer has that identity (gone, or another object), this is the
     person's original, moved by the command. It is never moved aside; its deny ACE travels with it. It is said:
     "<original> was moved to <new path>".
   - **A hard link.** If the recorded path STILL has that identity, the new path is a hard link to a held file (for
     example `proj\sub\.envrc` linked to `proj\.envrc`). The new name is moved aside, which renames the name and leaves
     the file in place, and it is said. A held file whose `nlink` grew during the run is said too, even when the new
     name lies outside the walk.
   - **The probe** (§5, test 2) shows whether the deny already refuses making the link. `CreateHardLinkW` opens the
     target for FILE_WRITE_ATTRIBUTES, which a write deny should refuse.
4. **New reparse points.** Any reparse point under the folder that the start walk didn't see (by path and identity) is
   moved aside, the link itself.
5. **New matches.** A match that is neither at a recorded path nor has a recorded identity is new, and is moved aside
   as today.

Whatever can't be moved, whatever was read only in part, and every "moved" or "hard link" line reaches the bot as
structured `endProblems` and `notClean`, as Linux's sweep does (`fencedExecutor`), not only as stderr text. The holder's
notice says the same.

## 3. The after-walk fails closed (change 3)

Today `quarantinePatternMatches` skips whatever the second walk didn't read (`unwalked`). On a peer folder it fails
closed instead, and the order of the walk is what keeps the person's own folders safe:

- **Known folders first.** The after-walk first reads the folders known from the start: those the start walk listed,
  matched by path AND identity, so a folder swapped in isn't "known". Only then does it read folders the run made.
- **New folders it didn't read** are moved aside whole. Only the run made them, or moved them into place.
- **The start's deny-whole folders** keep their records (§2.2) and are checked by identity, not walked.
- **Why the ceiling below, and not a cap on entries.** The reviewer offered a choice: move unread folders aside whole,
  or cap how many entries a peer command may create. NTFS has no live per-account count of entries (its quotas count
  bytes per owner), so a cap on what a command creates could only be checked afterwards, by this same walk. Moving
  aside is the only fail-closed choice that is actually enforced.
- **The ceiling on known folders.** The known folders get their own ceiling of 2,000,000 entries, not the shared
  budget: their size is about what the start walk read, plus whatever the command added inside them. Past the ceiling
  (a command that put millions of files into an existing folder), the person's own folders are NOT moved aside.
  Instead:
  - the call is notClean;
  - the folder goes on the holder's "unchecked" list;
  - every later peer call to it gets no folder until the person has looked (the holder's notice says which folder,
    and why).

## 4. The grant's lifetime, also across a crash (change 4)

- **Cost of forgetting.** `acl forget <root>` is "one walk of the tree per root", the same walk the first grant pays.
  Patch 0004 measured 21-27 s for an inheritable entry at the top of a 50,829-entry tree. A forget after every call
  would make every peer call pay two walks.
- **When a root is forgotten.** A peer-only root (one that wasn't a root before the peer's first call) is forgotten
  after 10 minutes with no call from that computer, or when the engine stops. It is skipped while any plan in flight
  opens it (`plansInFlight`).
- **Why MOSS checks this itself.** srt-win offers `--unless-held-by-others` only with `--all`: a hold is recorded by
  path, while a root is forgotten by its object.
- **The record.** `<mossHome>/run/peer-roots.json` holds one entry per peer-only root: its path, its identity, the
  computer, the first and last call, and `wasRoot: false`. It is written before the grant and removed after the forget
  succeeds. A root that already was a root (this engine's own `grantedRoots`, seeded from `user status`) is recorded
  with `wasRoot: true` and is never forgotten.
- **At engine start**, before any command, MOSS forgets every recorded peer-only root that is still a persistent root
  in `user status`. It skips one that has become another session's root since (one of this engine's sessions has
  granted it again). A root whose forget fails stays in the record and is tried again at the next start.
- **The residual.** Another MOSS home of the same Windows user, granting the same folder, loses write access there
  for the rest of a command that is running at that moment. Its next command grants the folder again. This is said
  in the code's comment.

## 5. Tests on the Windows runner

0. **A probe** (lands first; nothing else lands before it passes): on NTFS, Bun's bigint lstat keeps `(dev, ino)`
   across a rename and gives a new file a different one. The `ino` equals the low 64 bits of
   `fsutil file queryfileid`. A junction lstats as a reparse point.
1. **The swap:** `ren A\proj proj-old && mkdir A\proj\.git\hooks` (with a hook). Expected:
   - the new `A\proj\.git` is quarantined;
   - `A\proj-old\.git` keeps its contents and identity, and is named as moved;
   - notClean is set, and the exit code is kept.
   A second case renames the root `A` itself: `A` can't be made again, because its parent isn't writable.
2. **The junction swap:** `ren A\proj proj-old && mklink /J A\proj <another repo>`. The junction `A\proj` is moved
   aside (the link itself), and the other repo is untouched.
3. **A hard link beside a held run-later file:** `mklink /H A\sub\.envrc A\.envrc`. It is either refused by the deny
   (the probe's answer is recorded), or moved aside and said.
4. **An after-walk out of budget**, with a test-sized budget: the command makes a tree past the budget and plants a
   hook past it. The unread new folder is moved aside whole, and the hook goes with it. The start's deny-whole
   folders are unchanged.
5. **A cancelled call and a timed-out call:**
   - afterwards, `icacls A /T` shows no per-exec deny entry for the member SID;
   - the lease is released;
   - §2.3 still ran;
   - a later local command writes `A`.
   This needs `wa-win-tasks`.
6. **The forget:** after 10 idle minutes (a test clock), `A` is missing from `user status`'s persistent roots, and its
   DACL equals its start (`icacls /save`, compared). A folder that already was a local bot's root is not forgotten.
   A forget waits while a local command writes the root.
7. **A forget at the next start after a crash:** the engine is killed (its own pid) after a peer call. The next start
   forgets the recorded root before its first command, and the record is emptied.
8. **Junction-held names:** a `.vscode` junction pointing inside a root (its target is write-refused), pointing at the
   root itself (only the name is held, and the root stays writable), and pointing outside (nothing is added).
9. **Units:**
   - a volume that isn't NTFS refuses the folder in words;
   - the 10,000-record cap;
   - the known-folder ceiling leaves the person's folders in place and puts the folder on the unchecked list.

## 6. Order of the work

Once lane WA's two branches are merged:

1. the probe;
2. the records and checks of §2;
3. §3;
4. the structured end problems;
5. §4's record and forgets;
6. `prepare()` in `computers/fenced-executor.ts` admits `windows` on NTFS;
7. the end-to-end tests of §5.

The security page's held-link gap ("Windows junctions untested") is closed by §5 test 8.
