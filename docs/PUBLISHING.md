# Publishing Cortex to npm

The release runbook. [CHANGELOG.md](../CHANGELOG.md) is the *record* of a release;
this file is *how you cut one*.

---

## The one thing that will bite you

Many machines in China have npm pointed at a **read-only mirror**:

```
$ npm config get registry
https://registry.npmmirror.com
```

A mirror **cannot accept publishes**. If you run bare `npm publish` against it, it
fails — and `npm login` against it either fails or stores a token bound to the
wrong registry, which is worse because it looks like it worked.

Cortex handles half of this for you: `package.json` pins

```json
"publishConfig": {
  "access": "public",
  "registry": "https://registry.npmjs.org"
}
```

so `npm publish` **always** talks to the real registry regardless of your global
config. You can see it working — this warning is the *good* outcome:

```
$ npm publish --dry-run
npm warn This command requires you to be logged in to https://registry.npmjs.org (dry-run)
```

It says `registry.npmjs.org`, not the mirror. That means the override took effect.

`publishConfig` does **not** apply to `npm login`, though. Login is a separate
command and needs the registry passed explicitly, or you will authenticate
against the mirror.

---

## Pre-flight (no credentials needed)

Run all of this **before** touching auth. Every check here catches a real way to
publish a broken package.

```bash
cd cortex-os

# 1. Is the name actually free? (404 = free; if it resolves, STOP and rename)
npm view cortex-os version --registry https://registry.npmjs.org

# 2. Does it compile, and does dist/ actually get written?
npm run build && ls dist/index.js dist/cli/index.js

# 3. What exactly would ship? (this is the honest answer, not a guess)
npm pack --dry-run

# 4. Any auto-corrections? Must be silent apart from the login warning.
npm publish --dry-run
```

Three things to confirm in the output of 3 and 4:

- **`prepublishOnly` runs.** The `scripts.prepublishOnly` hook builds `dist/`
  before packing, so `npm publish` can never ship a stale or empty `dist/`. If
  you ever see `Tarball Contents` without `dist/`, stop.
- **The bin survives.** `package.json` declares `cortex` and `ctx` pointing at
  `dist/cli/index.js`. Confirm the packed manifest still has them:
  ```bash
  npm pack >/dev/null && tar -xzOf cortex-os-<version>.tgz package/package.json | grep -A3 '"bin"'
  rm -f cortex-os-*.tgz
  ```
  (npm normalises this field on publish — both `dist/cli/index.js` and
  `./dist/cli/index.js` work, but writing it the way npm wants keeps the
  output warning-free.)
- **The doc set ships.** `files` covers `dist`, both READMEs, both manifestos,
  `CHANGELOG.md`, `assets/` and `docs/`. `examples/` is deliberately **not**
  shipped: the examples import `../src/index.js`, and `src/` is not published,
  so shipping them would ship broken code. They live in the repo for people who
  clone.

---

## Log in (once per machine)

Pass the registry explicitly — this is the step that trips people up.

```bash
npm login --registry https://registry.npmjs.org
```

Verify you are pointed at the right place:

```bash
npm whoami --registry https://registry.npmjs.org
```

If your account has 2FA enabled, publishing will prompt for a one-time code.
Pass it inline on headless/agent runs:

```bash
npm publish --otp=123456
```

---

## Publish

```bash
# from a clean tree, on the commit you intend to release
git status --short          # expect empty

npm publish
```

The registry comes from `publishConfig`, so no flag is needed. `prepublishOnly`
builds first, then npm uploads the tarball with public access.

Verify the result:

```bash
npm view cortex-os version --registry https://registry.npmjs.org
npm view cortex-os dist.tarball --registry https://registry.npmjs.org

# smoke-test the real install in a scratch dir
mkdir -p /tmp/cortex-install-check && cd /tmp/cortex-install-check
npm init -y >/dev/null
npm i cortex-os --registry https://registry.npmjs.org
npx cortex help
```

`npx cortex help` printing the command list is the end-to-end proof: it means the
tarball, the bin wiring and the CLI all survived the round trip.

---

## Cutting the *next* release

The order matters — the tag and the published tarball should describe the same
commit.

1. Land the work on `main`; smoke green (`npx tsx scripts/smoke.ts`) and
   `npx tsc -p tsconfig.json` clean.
2. Bump `version` in `package.json`.
3. Add the new entry to `CHANGELOG.md` (newest first). Keep the
   "known limitations" section honest — it is the most-read part.
4. Add `docs/release/v<version>.md` — the GitHub release body.
5. Update, together, in one commit: the release badge in `README.md` /
   `README.zh-CN.md`, the Status / 当前状态 section, the `MANIFESTO.md` status
   line, and the `## Releases` section of `BACKLOG.md`.
6. Commit, then tag and push both:
   ```bash
   git commit -am "release: v<version>"
   git tag -a v<version> -m "v<version> — <one line>"
   git push origin main && git push origin v<version>
   ```
7. `npm publish`.
8. Create the GitHub release. `gh` is **not installed** on the current dev
   machine, so either install it and run
   ```bash
   gh release create v<version> --notes-file docs/release/v<version>.md --title "v<version>"
   ```
   or paste that file into the Releases UI by hand.

---

## Notes and cautions

- **Version semantics.** `0.x` means the syscall ABI is not frozen; a minor bump
  may carry a breaking change. See the preamble in [CHANGELOG.md](../CHANGELOG.md).
- **A published version is effectively permanent.** npm allows unpublishing for
  72 hours, refuses it after that, and *always* refuses reuse of a version
  number. Treat `npm publish` as one-way; if a release is wrong, publish a
  `-patch`/patch bump rather than trying to unship it.
- **`dist/` is gitignored, and that is correct** — the build is reproducible from
  source, and `prepublishOnly` guarantees it exists at publish time. Don't
  "fix" this by committing build output.
- **Do not commit `*.tgz`.** `npm pack` leftovers are gitignored.
