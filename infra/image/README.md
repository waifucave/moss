# The official image for cloud computers

Spec §9.2 "Official image" and "Safety"; plan §4 J, M3.

A cloud computer is a stock Ubuntu 24.04 VM that the provider plugin (`plugins/clover/plugins/provider-hetzner`,
`provider-gcp`) creates with the cloud-init the core writes (`packages/core/src/computers/image.ts`). There is no
prebuilt disk image to publish: the cloud-init is the image. It:

- first of all, blocks the cloud metadata addresses (`169.254.169.254`, `fd00:ec2::254`, `fd20:ce::254`) with
  nftables for every user: in `bootcmd` when the image has nft already, and again as the first `runcmd` lines, which
  also keep the rule across boots and enable nftables, before any download or user service (loading it twice is
  harmless);
- downloads the Clover daemon for Linux and Chrome for Testing's headless shell from pinned URLs and checks each one's
  SHA-256 before anything is unpacked (lane M's release pins);
- adds a `clover` user with no password, turns lingering on for it, and runs the daemon as a systemd user service, so
  it starts at boot with no login;
- writes the computer's name and its join ticket to `/etc/moss/`, readable only by `moss`; the daemon pairs once with
  the ticket and then deletes it from there (`removeCloudJoinFiles`). cloud-init also keeps a copy of the user-data
  under `/var/lib/cloud` on the VM's disk, which the daemon does not delete: the ticket is spent by its single use and
  its hour. The ticket is a pairing QR: besides the secret it carries the main computer's link addresses (its LAN and
  direct addresses), which stay in the user-data wherever the cloud keeps it. Google Cloud's `user-data` metadata is
  cleared after pairing; Hetzner keeps a server's user-data and can't clear it, so the main's addresses (not a live
  secret) stay readable to anyone who can read that server's user-data;
- carries the `clover-computer` label with its folder's id, by which the main computer finds it (`cloud.json` is only
  a cache).

The providers give the VM no cloud service account (Google Cloud: `serviceAccounts: []`; Hetzner has none), so even
without the block there is nothing to lift.

To see what a VM gets: `scripts/pinned-bun infra/image/print.ts`. It prints the cloud-init with placeholder values.

How the VM joins (built, proven on a stand-in; `packages/core/src/computers/cloud-join.ts`): the main computer begins one
ordinary pairing for the VM and writes its QR text to `/etc/moss/join`; the unit starts
`moss-core daemon run --cloud-join-dir /etc/moss`, which names the device from `/etc/moss/name`, joins with the ticket,
confirms its own end, and deletes the ticket once paired. The main confirms its end by itself only for a
pairing it began for a VM made from MOSS's own image, and only when the device that joined is a cloud computer that runs the
core, has no answer key, and calls itself that VM's computer. A folder that names any other image gets no ticket and no
automatic confirming: the person pairs it themselves with the four words (the create card says so).

Open before the live gate (the owner's list is in the lane's report):

- `IMAGE_DAEMON_PIN` in `packages/core/src/computers/image.ts` is not set: no Linux build of the engine is published for
  a VM to download, so no cloud computer is created (and the two providers stay `availability: not-yet`);
- the browser pin is the one the daemon's own headless install uses (`plugins/moss/plugins/browser/headless-shell.pins.json`);
- a desktop session for computer use comes with opensky, not here.
