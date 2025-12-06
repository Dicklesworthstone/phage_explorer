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
#   --verify          Require checksum verification
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
VERIFY=0
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
  --verify           Require checksum verification (fail if unavailable)
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
      VERIFY=1
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

# ─────────────────────────────────────────────────────────────────────────────
# Lock file to prevent concurrent installs
# ─────────────────────────────────────────────────────────────────────────────

LOCK_FILE="/tmp/phage-explorer-install.lock"
exec 200>"$LOCK_FILE"
flock -n 200 || die "Another installation is in progress"

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
    | grep '"tag_name":' \
    | sed -E 's/.*"([^"]+)".*/\1/' \
    || echo "")

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

log_step 4 "Installing binary..."

INSTALL_PATH="$DEST/$BINARY"
if [[ "$OS" == "windows" ]]; then
  INSTALL_PATH="$DEST/$BINARY.exe"
fi

if [[ $FROM_SOURCE -eq 0 && -n "$VERSION" ]]; then
  # Try to download prebuilt binary
  DOWNLOAD_URL="https://github.com/$OWNER/$REPO/releases/download/$VERSION/$ASSET_NAME"
  CHECKSUM_URL="https://github.com/$OWNER/$REPO/releases/download/$VERSION/sha256.txt"

  log "Downloading $ASSET_NAME..."

  TMP_FILE=$(mktemp)
  if curl -fsSL "$DOWNLOAD_URL" -o "$TMP_FILE" 2>/dev/null; then
    # Verify checksum if available
    if [[ $VERIFY -eq 1 ]] || curl -fsSL "$CHECKSUM_URL" -o /dev/null 2>/dev/null; then
      log "Verifying checksum..."
      EXPECTED_SUM=$(curl -fsSL "$CHECKSUM_URL" 2>/dev/null | grep "$ASSET_NAME" | awk '{print $1}' || echo "")

      if [[ -n "$EXPECTED_SUM" ]]; then
        if command -v sha256sum &>/dev/null; then
          ACTUAL_SUM=$(sha256sum "$TMP_FILE" | awk '{print $1}')
        elif command -v shasum &>/dev/null; then
          ACTUAL_SUM=$(shasum -a 256 "$TMP_FILE" | awk '{print $1}')
        else
          log_warn "No sha256sum or shasum available, skipping verification"
          ACTUAL_SUM="$EXPECTED_SUM"
        fi

        if [[ "$EXPECTED_SUM" != "$ACTUAL_SUM" ]]; then
          rm -f "$TMP_FILE"
          die "Checksum mismatch! Expected: $EXPECTED_SUM, Got: $ACTUAL_SUM"
        fi
        log_success "Checksum verified"
      elif [[ $VERIFY -eq 1 ]]; then
        rm -f "$TMP_FILE"
        die "Checksum verification required but sha256.txt not available"
      fi
    fi

    mv "$TMP_FILE" "$INSTALL_PATH"
    chmod +x "$INSTALL_PATH"
    log_success "Binary installed: $INSTALL_PATH"
  else
    rm -f "$TMP_FILE"
    log_warn "Binary download failed, falling back to source build"
    FROM_SOURCE=1
  fi
fi

if [[ $FROM_SOURCE -eq 1 ]]; then
  log "Building from source..."

  # Check for git and bun
  command -v git &>/dev/null || die "git is required for source builds"
  command -v bun &>/dev/null || die "bun is required for source builds (https://bun.sh)"

  # Clone and build
  TMP_DIR=$(mktemp -d)
  trap "rm -rf $TMP_DIR" EXIT

  log "Cloning repository..."
  git clone --depth 1 ${VERSION:+--branch "$VERSION"} \
    "https://github.com/$OWNER/$REPO.git" "$TMP_DIR" 2>/dev/null \
    || git clone --depth 1 "https://github.com/$OWNER/$REPO.git" "$TMP_DIR"

  cd "$TMP_DIR"

  log "Installing dependencies..."
  bun install --frozen-lockfile 2>/dev/null || bun install

  log "Building binary..."
  bun run build

  if [[ -f "dist/phage-explorer" ]]; then
    mv "dist/phage-explorer" "$INSTALL_PATH"
    chmod +x "$INSTALL_PATH"
    log_success "Binary built and installed: $INSTALL_PATH"
  else
    die "Build failed: binary not found"
  fi

  cd - >/dev/null
fi

# ─────────────────────────────────────────────────────────────────────────────
# Step 5: Install database (optional)
# ─────────────────────────────────────────────────────────────────────────────

log_step 5 "Database setup..."

DATA_DIR="$HOME/.phage-explorer"
DB_PATH="$DATA_DIR/phage.db"

if [[ $WITH_DATABASE -eq 1 ]]; then
  mkdir -p "$DATA_DIR"

  # Try to download pre-built database from release
  if [[ -n "$VERSION" ]]; then
    DB_URL="https://github.com/$OWNER/$REPO/releases/download/$VERSION/phage.db"
    log "Downloading database..."

    if curl -fsSL "$DB_URL" -o "$DB_PATH" 2>/dev/null; then
      log_success "Database installed: $DB_PATH"
    else
      log_warn "Pre-built database not available"
      log "You can build it by running: phage-explorer --build-db"
    fi
  else
    log_warn "No version specified, cannot download database"
    log "You can build it by running: phage-explorer --build-db"
  fi
else
  log "Skipping database download (use --with-database to include)"
  log "You can build the database later with: phage-explorer --build-db"
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
  log_error "Binary is not executable"
fi
