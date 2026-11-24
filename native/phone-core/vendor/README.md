# vendor

`netdev/` is [netdev](https://crates.io/crates/netdev) 0.46.3 (MIT, its `LICENSE` kept), as published, with one change. iroh 1.4.1 reaches it through netwatch 0.19.3.

## The change

In `src/os/darwin/ipv6_addr_flags.rs`, `get_ipv6_addr_flags` keeps its body on macOS only. On every other Apple target it reports no flags, as an ioctl that fails would.

The published crate uses `libc::in6_ifreq` on every Apple target, but libc 0.2.191, the newest 0.2, defines it for macOS only. So the crate doesn't build for `aarch64-apple-ios` or `aarch64-apple-ios-sim` (the phone-core workflow's iPhone job).

## Removing it

Drop the `[patch.crates-io]` entry and this folder once a netwatch release that iroh takes depends on a netdev that builds for iOS. netdev 0.48 may; check before removing.
