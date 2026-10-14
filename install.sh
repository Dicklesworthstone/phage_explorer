#!/usr/bin/env bash
#
# Phage Explorer Installer
#
# One-liner installation:
#   curl -fsSL https://raw.githubusercontent.com/Dicklesworthstone/phage_explorer/main/install.sh | bash
#
# Environment variables:
#   VERSION     - Pin to specific release (e.g., v1.0.0)
#   DEST        - Install directory (default: ~/.local/bin)
#   OWNER       - GitHub owner (default: Dicklesworthstone)
#   REPO        - GitHub repo (default: phage_explorer)
#   BINARY      - Installed binary name (default: phage-explorer)
#
# Flags:
#   --version vX.Y.Z  Pin specific version
#   --dest DIR        Install directory
#   --system          Install to /usr/local/bin
#   --from-source     Skip binary download, build from source
#   --with-database   Also download/build the phage database
#   --easy-mode       Auto-update PATH in shell rc files
#   --verify          Accepted for compatibility; checksums are always verified
#   --insecure-skip-checksums
#                     Install WITHOUT SHA-256 verification (not recommended)
#   --quiet / -q      Suppress output
#   --help / -h       Show usage
#

set -euo pipefail

# ─────────────────────────────────────────────────────────────────────────────
# Defaults
# ─────────────────────────────────────────────────────────────────────────────

OWNER="${OWNER:-Dicklesworthstone}"
REPO="${REPO:-phage_explorer}"
BINARY="${BINARY:-phage-explorer}"
DEST="${DEST:-$HOME/.local/bin}"
VERSION="${VERSION:-}"
FROM_SOURCE=0
WITH_DATABASE=0
EASY_MODE=0
SKIP_CHECKSUMS=0
QUIET=0

# ─────────────────────────────────────────────────────────────────────────────
# Colors
# ─────────────────────────────────────────────────────────────────────────────

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m' # No Color

# ─────────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────────

log() {
  [[ $QUIET -eq 1 ]] && return
  echo -e "${CYAN}[phage-explorer]${NC} $1"
}

log_step() {
  [[ $QUIET -eq 1 ]] && return
  echo -e "\n${BOLD}${BLUE}[$1/6]${NC} ${BOLD}$2${NC}"
}

log_success() {
  [[ $QUIET -eq 1 ]] && return
  echo -e "${GREEN}✓${NC} $1"
}

log_warn() {
  echo -e "${YELLOW}⚠${NC} $1" >&2
}

log_error() {
  echo -e "${RED}✗${NC} $1" >&2
}

die() {
  log_error "$1"
  exit 1
}

usage() {
  cat <<EOF
${BOLD}Phage Explorer Installer${NC}

${BOLD}Usage:${NC}
  curl -fsSL https://raw.githubusercontent.com/$OWNER/$REPO/main/install.sh | bash
  ./install.sh [OPTIONS]

${BOLD}Options:${NC}
  --version vX.Y.Z   Pin specific version (default: latest release)
  --dest DIR         Install directory (default: ~/.local/bin)
  --system           Install to /usr/local/bin (may require sudo)
  --from-source      Skip binary download, build from source
  --with-database    Also download/build the phage database
  --easy-mode        Auto-update PATH in shell rc files
  --verify           Accepted for compatibility: the binary and the database
                     are always verified against the release's SHA-256 sums
  --insecure-skip-checksums
                     Install WITHOUT checksum verification (prints a warning;
                     only for releases that publish no checksums)
  --quiet, -q        Suppress output
  --help, -h         Show this help

${BOLD}Environment Variables:${NC}
  VERSION            Pin to specific release tag
  DEST               Install directory
  OWNER              GitHub owner (default: Dicklesworthstone)
  REPO               GitHub repo (default: phage_explorer)
  BINARY             Installed binary name (default: phage-explorer)

${BOLD}Examples:${NC}
  # Install latest release
  curl -fsSL https://raw.githubusercontent.com/$OWNER/$REPO/main/install.sh | bash

  # Install specific version
  VERSION=v1.0.0 curl -fsSL ... | bash

  # Install with database
  curl -fsSL ... | bash -s -- --with-database

  # Build from source
  curl -fsSL ... | bash -s -- --from-source

EOF
  exit 0
}

# ─────────────────────────────────────────────────────────────────────────────
# Parse arguments
# ─────────────────────────────────────────────────────────────────────────────

while [[ $# -gt 0 ]]; do
  case "$1" in
    --version)
      VERSION="$2"
      shift 2
      ;;
    --dest)
      DEST="$2"
      shift 2
      ;;
    --system)
      DEST="/usr/local/bin"
      shift
      ;;
    --from-source)
      FROM_SOURCE=1
      shift
      ;;
    --with-database)
      WITH_DATABASE=1
      shift
      ;;
    --easy-mode)
      EASY_MODE=1
      shift
      ;;
    --verify)
      # Verification is unconditional now; the flag stays accepted.
      shift
      ;;
    --insecure-skip-checksums)
      SKIP_CHECKSUMS=1
      shift
      ;;
    --quiet | -q)
      QUIET=1
      shift
      ;;
    --help | -h)
      usage
      ;;
    *)
      die "Unknown option: $1"
      ;;
  esac
done

# Every temporary path (lock, sha256.txt, source checkout) lives under TMPDIR;
# an unset or unusable TMPDIR means /tmp.
if [[ -z "${TMPDIR:-}" || ! -d "$TMPDIR" || ! -w "$TMPDIR" ]]; then
  export TMPDIR=/tmp
fi

if [[ $SKIP_CHECKSUMS -eq 1 ]]; then
  echo -e "${RED}${BOLD}WARNING: --insecure-skip-checksums: the binary and database will be installed WITHOUT SHA-256 verification.${NC}" >&2
fi

# ─────────────────────────────────────────────────────────────────────────────
# Cleanup: one EXIT trap owns every temporary path and the install lock
# ─────────────────────────────────────────────────────────────────────────────

TMP_DIR=""          # source checkout (source builds only)
CHECKSUMS_FILE=""   # downloaded sha256.txt
STAGED_BIN=""       # verified binary, renamed into place only at commit
STAGED_DB=""        # verified database, renamed into place only at commit
DB_DOWNLOAD=""      # compressed database download
LOCK_KIND=""
LOCK_DIR=""

# Every step is non-fatal: under `set -e` a failing command here would replace
# the installer's own exit status.
cleanup() {
  local path
  for path in "$CHECKSUMS_FILE" "$STAGED_BIN" "$STAGED_DB" "$DB_DOWNLOAD"; do
    if [[ -n "$path" && -f "$path" ]]; then rm -f "$path" || true; fi
  done
  if [[ -n "$TMP_DIR" && -d "$TMP_DIR" ]]; then rm -rf "$TMP_DIR" || true; fi
  if [[ "$LOCK_KIND" == "mkdir" && -n "$LOCK_DIR" ]]; then
    rm -f "$LOCK_DIR/pid" || true
    rmdir "$LOCK_DIR" 2>/dev/null || true
  fi
  return 0
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP

# ─────────────────────────────────────────────────────────────────────────────
# Lock: one installer per user at a time
# ─────────────────────────────────────────────────────────────────────────────
#
# flock(1) is util-linux; stock macOS does not ship it. Where it is missing, an
# atomic mkdir lock gives the same mutual exclusion. Its owner's pid is
# recorded so a lock left behind by a killed installer can be retired, under a
# second mkdir mutex so that two installers never retire the same lock or a
# fresh one.

acquire_install_lock() {
  local base="$TMPDIR"
  local lock_path
  lock_path="${base%/}/phage-explorer-install-$(id -u).lock"

  if command -v flock &>/dev/null; then
    # Never follow a planted symlink: opening it would create or lock a file
    # elsewhere. Append mode: opening the lock must never truncate whatever is there.
    [[ ! -L "$lock_path" ]] || die "Install lock path is a symlink: $lock_path"
    exec 200>>"$lock_path" || die "Cannot open the install lock: $lock_path"
    flock -n 200 || die "Another installation is in progress (lock: $lock_path)"
    LOCK_KIND="flock"
    return 0
  fi

  local dir="$lock_path.d"
  local owner attempt
  for attempt in 1 2; do
    if mkdir "$dir" 2>/dev/null; then
      LOCK_KIND="mkdir"
      LOCK_DIR="$dir"
      printf '%s\n' "$$" >"$dir/pid" || die "Cannot record the install lock owner: $dir/pid"
      return 0
    fi
    if [[ ! -e "$dir" && ! -L "$dir" ]]; then
      # Released between our mkdir and this check: try once more; otherwise
      # the directory really cannot be created.
      [[ $attempt -eq 1 ]] && continue
      die "Cannot create the install lock directory: $dir"
    fi
    [[ -d "$dir" && ! -L "$dir" ]] || die "Install lock path exists but is not a directory: $dir"
    owner="$(cat "$dir/pid" 2>/dev/null || true)"
    if [[ $attempt -eq 1 && "$owner" =~ ^[0-9]+$ ]] && ! kill -0 "$owner" 2>/dev/null; then
      if mkdir "$dir.retire" 2>/dev/null; then
        # Re-read under the retire mutex: only the same dead owner is retired.
        if [[ "$(cat "$dir/pid" 2>/dev/null || true)" == "$owner" ]] && ! kill -0 "$owner" 2>/dev/null; then
          rm -f "$dir/pid"
          rmdir "$dir" 2>/dev/null || true
        fi
        rmdir "$dir.retire" 2>/dev/null || true
        continue
      fi
    fi
    die "Another installation is in progress (lock: $dir${owner:+, pid $owner}). If no installer is running, remove $dir (and $dir.retire if present)."
  done
  die "Another installation is in progress (lock: $dir)"
}

acquire_install_lock

# ─────────────────────────────────────────────────────────────────────────────
# Checksums
# ─────────────────────────────────────────────────────────────────────────────

# Hash from stdin: with a file argument, sha256sum and shasum prefix the sum
# with a backslash when the path contains one (Git Bash paths). Each tool is
# tried in turn until one prints a well-formed digest.
sha256_of() {
  local sum=""
  [[ -f "$1" && -r "$1" ]] || return 1
  if command -v sha256sum &>/dev/null; then
    sum="$(sha256sum <"$1" 2>/dev/null | awk '{print tolower($1)}')" || sum=""
  fi
  if [[ ! "$sum" =~ ^[0-9a-f]{64}$ ]] && command -v shasum &>/dev/null; then
    sum="$(shasum -a 256 <"$1" 2>/dev/null | awk '{print tolower($1)}')" || sum=""
  fi
  if [[ ! "$sum" =~ ^[0-9a-f]{64}$ ]] && command -v openssl &>/dev/null; then
    sum="$(openssl dgst -sha256 <"$1" 2>/dev/null | awk '{print tolower($NF)}')" || sum=""
  fi
  [[ "$sum" =~ ^[0-9a-f]{64}$ ]] || return 1
  printf '%s\n' "$sum"
}

# Print the one SHA-256 that sha256.txt (or the asset's own .sha256 sidecar)
# publishes for an exact asset name. Fails when there is none, or more than one.
expected_sha256() {
  local name="$1" sums sidecar
  if [[ -n "$CHECKSUMS_FILE" && -s "$CHECKSUMS_FILE" ]]; then
    sums="$(awk -v n="$name" 'length($1) == 64 && $1 ~ /^[0-9a-fA-F]+$/ && ($2 == n || $2 == "*" n) {print tolower($1)}' "$CHECKSUMS_FILE" | sort -u)"
    if [[ -n "$sums" ]]; then
      [[ "$(printf '%s\n' "$sums" | wc -l | tr -d ' ')" == "1" ]] || return 1
      printf '%s\n' "$sums"
      return 0
    fi
  fi
  sidecar="$(curl -fsSL "$RELEASE_URL/$name.sha256" 2>/dev/null || true)"
  sums="$(printf '%s\n' "$sidecar" | awk -v n="$name" 'length($1) == 64 && $1 ~ /^[0-9a-fA-F]+$/ && ($2 == n || $2 == "*" n || $2 == "") {print tolower($1)}' | sort -u)"
  [[ -n "$sums" && "$(printf '%s\n' "$sums" | wc -l | tr -d ' ')" == "1" ]] || return 1
  printf '%s\n' "$sums"
}

# verify_sha256 FILE EXPECTED LABEL: fail unless FILE hashes to EXPECTED.
verify_sha256() {
  local file="$1" expected="$2" label="$3" actual
  if [[ $SKIP_CHECKSUMS -eq 1 ]]; then
    log_warn "NOT VERIFIED (--insecure-skip-checksums): $label"
    return 0
  fi
  [[ -n "$expected" ]] || {
    log_error "No published SHA-256 for $label (only for a release that publishes no checksums: --insecure-skip-checksums)"
    return 1
  }
  actual="$(sha256_of "$file")" && [[ -n "$actual" ]] || {
    log_error "Cannot compute the SHA-256 of $label (needs sha256sum, shasum or openssl)"
    return 1
  }
  if [[ "$actual" != "$expected" ]]; then
    log_error "Checksum mismatch for $label: expected $expected, got $actual"
    return 1
  fi
  log_success "Checksum verified: $label ($expected)"
}

# ─────────────────────────────────────────────────────────────────────────────
# Step 1: Detect platform
# ─────────────────────────────────────────────────────────────────────────────

log_step 1 "Detecting platform..."

OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
ARCH="$(uname -m)"

case "$OS" in
  linux)
    OS="linux"
    ;;
  darwin)
    OS="macos"
    ;;
  msys* | mingw* | cygwin*)
    OS="windows"
    ;;
  *)
    die "Unsupported OS: $OS"
    ;;
esac

case "$ARCH" in
  x86_64 | amd64)
    ARCH="x64"
    ;;
  aarch64 | arm64)
    ARCH="arm64"
    ;;
  *)
    die "Unsupported architecture: $ARCH"
    ;;
esac

# Windows only supports x64 currently
if [[ "$OS" == "windows" && "$ARCH" != "x64" ]]; then
  die "Windows builds only available for x64 architecture"
fi

# Construct asset name
if [[ "$OS" == "windows" ]]; then
  ASSET_NAME="phage-explorer-${OS}-${ARCH}.exe"
else
  ASSET_NAME="phage-explorer-${OS}-${ARCH}"
fi

log_success "Platform: $OS-$ARCH"
log "Asset: $ASSET_NAME"

# ─────────────────────────────────────────────────────────────────────────────
# Step 2: Resolve version
# ─────────────────────────────────────────────────────────────────────────────

log_step 2 "Resolving version..."

if [[ -z "$VERSION" ]]; then
  log "Fetching latest release tag..."
  VERSION=$(curl -fsSL "https://api.github.com/repos/$OWNER/$REPO/releases/latest" \
    | grep -o '"tag_name": *"[^"]*"' \
    | head -n 1 \
    | sed -E 's/.*"([^"]*)"$/\1/' \
    || echo "")
  case "$VERSION" in v[0-9]*|[0-9]*) ;; *) VERSION="" ;; esac

  if [[ -z "$VERSION" ]]; then
    log_warn "Could not fetch latest release, falling back to source build"
    FROM_SOURCE=1
  fi
fi

if [[ -n "$VERSION" ]]; then
  log_success "Version: $VERSION"
fi

# ─────────────────────────────────────────────────────────────────────────────
# Step 3: Create destination directory
# ─────────────────────────────────────────────────────────────────────────────

log_step 3 "Preparing install directory..."

mkdir -p "$DEST" || die "Failed to create directory: $DEST"
log_success "Install directory: $DEST"

# ─────────────────────────────────────────────────────────────────────────────
# Step 4: Download or build binary
# ─────────────────────────────────────────────────────────────────────────────
#
# Nothing in DEST or DATA_DIR changes until every requested artifact is
# verified: each one is staged in a private file beside its destination, and
# only the commit step below renames them into place. A failed download,
# missing checksum, missing hash tool or mismatch leaves an existing install
# exactly as it was.

log_step 4 "Preparing binary..."

INSTALL_PATH="$DEST/$BINARY"
if [[ "$OS" == "windows" ]]; then
  INSTALL_PATH="$DEST/$BINARY.exe"
fi

DATA_DIR="$HOME/.phage-explorer"
DB_PATH="$DATA_DIR/phage.db"
RELEASE_URL=""
if [[ -n "$VERSION" ]]; then
  RELEASE_URL="https://github.com/$OWNER/$REPO/releases/download/$VERSION"
fi

NOT_CHANGED="nothing was installed or changed"

new_staging_file() {
  mktemp "$1/.$2.download.XXXXXX" || die "Cannot create a staging file in $1; $NOT_CHANGED"
}

fetch_release_checksums() {
  [[ $SKIP_CHECKSUMS -eq 1 || -n "$CHECKSUMS_FILE" ]] && return 0
  CHECKSUMS_FILE="$(mktemp "${TMPDIR:-/tmp}/phage-explorer-sha256.XXXXXX")" \
    || die "Cannot create a temporary file for sha256.txt; $NOT_CHANGED"
  # A missing sha256.txt is not fatal by itself: expected_sha256 then tries
  # the asset's .sha256 sidecar, and fails if that is missing too.
  curl -fsSL "$RELEASE_URL/sha256.txt" -o "$CHECKSUMS_FILE" 2>/dev/null || : >"$CHECKSUMS_FILE"
}

# Read-only lookup, safe inside $(...); fetch_release_checksums must already
# have run in the main shell so the trap knows the temporary file.
release_sha256() {
  [[ $SKIP_CHECKSUMS -eq 1 ]] && return 0
  expected_sha256 "$1" || true
}

if [[ $FROM_SOURCE -eq 0 && -n "$VERSION" ]]; then
  STAGED_BIN="$(new_staging_file "$DEST" "$BINARY")"
  log "Downloading $ASSET_NAME..."
  if curl -fsSL "$RELEASE_URL/$ASSET_NAME" -o "$STAGED_BIN" 2>/dev/null; then
    fetch_release_checksums
    verify_sha256 "$STAGED_BIN" "$(release_sha256 "$ASSET_NAME")" "$ASSET_NAME" \
      || die "Refusing to install $ASSET_NAME; $NOT_CHANGED"
    chmod 755 "$STAGED_BIN"
  else
    rm -f "$STAGED_BIN"
    STAGED_BIN=""
    log_warn "Binary download failed, falling back to source build"
    FROM_SOURCE=1
  fi
fi

if [[ $FROM_SOURCE -eq 1 ]]; then
  log "Building from source..."

  # Check for git and bun
  command -v git &>/dev/null || die "git is required for source builds"
  command -v bun &>/dev/null || die "bun is required for source builds (https://bun.sh)"

  TMP_DIR="$(mktemp -d)" || die "Cannot create a temporary directory; $NOT_CHANGED"

  log "Cloning repository..."
  # A pinned or resolved version builds exactly that tag; only an unresolved
  # version builds the default branch.
  if [[ -n "$VERSION" ]]; then
    git clone --depth 1 --branch "$VERSION" "https://github.com/$OWNER/$REPO.git" "$TMP_DIR" \
      || die "Cannot clone tag $VERSION of $OWNER/$REPO; $NOT_CHANGED"
  else
    git clone --depth 1 "https://github.com/$OWNER/$REPO.git" "$TMP_DIR" \
      || die "Cannot clone $OWNER/$REPO; $NOT_CHANGED"
  fi

  log "Installing dependencies and building..."
  # Chained explicitly: `set -e` does not apply inside `( ... ) || die`.
  (
    cd "$TMP_DIR" \
      && { bun install --frozen-lockfile 2>/dev/null || bun install; } \
      && bun run build
  ) || die "Build failed; $NOT_CHANGED"

  [[ -f "$TMP_DIR/dist/phage-explorer" ]] || die "Build failed: binary not found; $NOT_CHANGED"
  STAGED_BIN="$(new_staging_file "$DEST" "$BINARY")"
  if ! { cp "$TMP_DIR/dist/phage-explorer" "$STAGED_BIN" && chmod 755 "$STAGED_BIN"; }; then
    die "Cannot stage the built binary; $NOT_CHANGED"
  fi
  log_success "Binary built from source"
fi

# ─────────────────────────────────────────────────────────────────────────────
# Step 5: Install database (optional)
# ─────────────────────────────────────────────────────────────────────────────

log_step 5 "Database setup..."

if [[ $WITH_DATABASE -eq 1 ]]; then
  mkdir -p "$DATA_DIR" || die "Failed to create directory: $DATA_DIR; $NOT_CHANGED"
  STAGED_DB="$(new_staging_file "$DATA_DIR" "phage.db")"

  if [[ $FROM_SOURCE -eq 1 ]]; then
    # The repository ships the release database together with its manifest.
    SRC_DB="$TMP_DIR/packages/web/public/phage.db"
    SRC_MANIFEST="$TMP_DIR/packages/web/public/phage.db.manifest.json"
    [[ -f "$SRC_DB" ]] || die "The source tree has no packages/web/public/phage.db; $NOT_CHANGED"
    EXPECTED_DB=""
    if [[ $SKIP_CHECKSUMS -eq 0 ]]; then
      EXPECTED_DB="$(sed -nE 's/^[[:space:]]*"sha256"[[:space:]]*:[[:space:]]*"([0-9a-fA-F]{64})".*/\1/p' "$SRC_MANIFEST" 2>/dev/null \
        | head -n 1 | tr '[:upper:]' '[:lower:]')"
    fi
    cp "$SRC_DB" "$STAGED_DB" || die "Cannot stage the database; $NOT_CHANGED"
    verify_sha256 "$STAGED_DB" "$EXPECTED_DB" "phage.db (source tree, per phage.db.manifest.json)" \
      || die "Refusing to install the database; $NOT_CHANGED"
  elif [[ -n "$VERSION" ]]; then
    # Whatever the transport, the installed bytes must be the phage.db the
    # release publishes a checksum for.
    fetch_release_checksums
    EXPECTED_DB="$(release_sha256 phage.db)"
    [[ $SKIP_CHECKSUMS -eq 1 || -n "$EXPECTED_DB" ]] \
      || die "Release $VERSION publishes no SHA-256 for phage.db; refusing to install an unverified database; $NOT_CHANGED"

    DB_STAGED_OK=0
    if command -v gunzip &>/dev/null; then
      DB_DOWNLOAD="$(new_staging_file "$DATA_DIR" "phage.db.gz")"
      if curl -fsSL "$RELEASE_URL/phage.db.gz" -o "$DB_DOWNLOAD" 2>/dev/null; then
        if gunzip -c "$DB_DOWNLOAD" >"$STAGED_DB" \
          && verify_sha256 "$STAGED_DB" "$EXPECTED_DB" "phage.db (from phage.db.gz)"; then
          DB_STAGED_OK=1
        else
          log_warn "The compressed database did not verify; trying the uncompressed asset"
        fi
      else
        log "Compressed database not available, trying uncompressed..."
      fi
    fi
    if [[ $DB_STAGED_OK -eq 0 ]]; then
      curl -fsSL "$RELEASE_URL/phage.db" -o "$STAGED_DB" 2>/dev/null \
        || die "Could not download the database from release $VERSION; $NOT_CHANGED"
      verify_sha256 "$STAGED_DB" "$EXPECTED_DB" "phage.db" \
        || die "Refusing to install the database; $NOT_CHANGED"
    fi
  else
    die "No release version was resolved, so no verified database can be installed; $NOT_CHANGED"
  fi
  chmod 644 "$STAGED_DB"
else
  log "Skipping database download (use --with-database to include)"
  log "You can install it later by re-running with --with-database."
fi

# Commit: every requested artifact is verified; rename each into place.
mv -f "$STAGED_BIN" "$INSTALL_PATH" || die "Could not install $INSTALL_PATH; $NOT_CHANGED"
STAGED_BIN=""
log_success "Binary installed: $INSTALL_PATH"
if [[ -n "$STAGED_DB" ]]; then
  mv -f "$STAGED_DB" "$DB_PATH" \
    || die "The binary was installed, but the database could not be moved into place at $DB_PATH"
  STAGED_DB=""
  log_success "Database installed: $DB_PATH"
fi

# ─────────────────────────────────────────────────────────────────────────────
# Step 6: Update PATH (optional)
# ─────────────────────────────────────────────────────────────────────────────

log_step 6 "Finalizing installation..."

# Check if DEST is in PATH
if [[ ":$PATH:" != *":$DEST:"* ]]; then
  log_warn "$DEST is not in your PATH"

  if [[ $EASY_MODE -eq 1 ]]; then
    SHELL_RC=""
    if [[ -f "$HOME/.zshrc" ]]; then
      SHELL_RC="$HOME/.zshrc"
    elif [[ -f "$HOME/.bashrc" ]]; then
      SHELL_RC="$HOME/.bashrc"
    elif [[ -f "$HOME/.bash_profile" ]]; then
      SHELL_RC="$HOME/.bash_profile"
    fi

    if [[ -n "$SHELL_RC" ]]; then
      EXPORT_LINE="export PATH=\"\$PATH:$DEST\""
      if ! grep -q "$DEST" "$SHELL_RC" 2>/dev/null; then
        echo "" >> "$SHELL_RC"
        echo "# Added by phage-explorer installer" >> "$SHELL_RC"
        echo "$EXPORT_LINE" >> "$SHELL_RC"
        log_success "Added $DEST to PATH in $SHELL_RC"
        log "Run: source $SHELL_RC"
      fi
    fi
  else
    log "Add to your shell profile:"
    echo -e "  ${BOLD}export PATH=\"\$PATH:$DEST\"${NC}"
  fi
fi

# ─────────────────────────────────────────────────────────────────────────────
# Done!
# ─────────────────────────────────────────────────────────────────────────────

echo ""
echo -e "${GREEN}${BOLD}Installation complete!${NC}"
echo ""
echo -e "  Binary: ${CYAN}$INSTALL_PATH${NC}"
[[ -f "$DB_PATH" ]] && echo -e "  Database: ${CYAN}$DB_PATH${NC}"
echo ""
echo -e "  Run: ${BOLD}$BINARY${NC}"
echo ""

# Verify installation
if [[ -x "$INSTALL_PATH" ]]; then
  log_success "Binary is executable"
else
  die "Binary is not executable: $INSTALL_PATH"
fi
