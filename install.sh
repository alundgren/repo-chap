#!/usr/bin/env bash
set -euo pipefail

repository=https://github.com/alundgren/repo-chap
ref=main
prefix=${REPO_CHAP_INSTALL_PREFIX:-"$HOME/.local"}
source_directory=
skill_choice=${REPO_CHAP_INSTALL_SKILL:-ask}

usage() {
  cat <<'EOF'
Usage: install.sh [--ref <git-ref>] [--prefix <absolute-path>] [--source <checkout>]

Install or upgrade the Repo Chap CLI and desktop app, then offer to install the
workflow skill globally for selected agents.

Options:
  --ref       Git branch or tag to download. Defaults to main.
  --prefix    User-owned install prefix. Defaults to $HOME/.local.
  --source    Build an existing checkout instead of downloading from GitHub.
  -h, --help  Show this help.
EOF
}

fail() {
  printf 'repo-chap install: %s\n' "$*" >&2
  exit 1
}

while (( $# > 0 )); do
  case $1 in
    --ref)
      (( $# >= 2 )) || fail '--ref needs a value.'
      ref=$2
      shift 2
      ;;
    --prefix)
      (( $# >= 2 )) || fail '--prefix needs a value.'
      prefix=$2
      shift 2
      ;;
    --source)
      (( $# >= 2 )) || fail '--source needs a value.'
      source_directory=$2
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      fail "Unknown option: $1"
      ;;
  esac
done

[[ $prefix == /* ]] || fail '--prefix must be an absolute path.'
[[ $ref =~ ^[A-Za-z0-9][A-Za-z0-9._/-]*$ && $ref != *..* ]] || fail '--ref must be a plain Git branch or tag.'
[[ $skill_choice == ask || $skill_choice == yes || $skill_choice == no ]] ||
  fail 'REPO_CHAP_INSTALL_SKILL must be ask, yes, or no.'

command -v vp >/dev/null 2>&1 || fail 'Vite+ is required. Install it from https://viteplus.dev/guide/ and try again.'

case $(uname -s) in
  Linux) platform=linux ;;
  Darwin) platform=darwin ;;
  *) fail 'Only macOS and Linux are supported.' ;;
esac

case $(uname -m) in
  x86_64|amd64) architecture=x64 ;;
  arm64|aarch64) architecture=arm64 ;;
  *) fail "Unsupported CPU architecture: $(uname -m)" ;;
esac

temporary=$(mktemp -d "${TMPDIR:-/tmp}/repo-chap-install.XXXXXXXX")
cleanup() {
  rm -rf "$temporary"
}
trap cleanup EXIT

if [[ -n $source_directory ]]; then
  [[ -f $source_directory/package.json && -f $source_directory/pnpm-lock.yaml ]] || fail '--source must point to a Repo Chap checkout.'
  source_directory=$(cd "$source_directory" && pwd)
else
  command -v curl >/dev/null 2>&1 || fail 'curl is required to download Repo Chap.'
  command -v tar >/dev/null 2>&1 || fail 'tar is required to unpack Repo Chap.'
  source_directory=$temporary/source
  mkdir -p "$source_directory"
  printf 'Downloading Repo Chap %s...\n' "$ref"
  curl --fail --location --silent --show-error "$repository/archive/$ref.tar.gz" |
    tar -xz --strip-components=1 -C "$source_directory"
fi

printf 'Building Repo Chap...\n'
(
  cd "$source_directory"
  vp install --frozen-lockfile
  vp run build
)

mkdir -p "$temporary/packages" "$temporary/desktop" "$prefix/bin" "$prefix/share/repo-chap"
(
  cd "$source_directory"
  vp pm pack --filter repo-chap --pack-destination "$temporary/packages"
  vp run @repo-chap/desktop#package \
    --out "$temporary/desktop" --platform "$platform" --arch "$architecture"
)

shopt -s nullglob
cli_packages=("$temporary"/packages/repo-chap-*.tgz)
(( ${#cli_packages[@]} == 1 )) || fail 'The CLI build did not produce one package.'

printf 'Installing the CLI into %s...\n' "$prefix"
(
  cd "$source_directory"
  PATH="$prefix/bin:$PATH" vp exec pnpm add --global --global-dir "$prefix/lib/repo-chap" --global-bin-dir "$prefix/bin" "${cli_packages[0]}"
)

if [[ $platform == linux ]]; then
  packaged_desktop="$temporary/desktop/Repo Chap-linux-$architecture"
  desktop_target="$prefix/share/repo-chap/desktop"
  desktop_executable="$desktop_target/repo-chap-desktop"
else
  packaged_desktop="$temporary/desktop/Repo Chap-darwin-$architecture/Repo Chap.app"
  mkdir -p "$HOME/Applications"
  desktop_target="$HOME/Applications/Repo Chap.app"
  desktop_executable="$desktop_target/Contents/MacOS/repo-chap-desktop"
fi

[[ -x $packaged_desktop/repo-chap-desktop || -x $packaged_desktop/Contents/MacOS/repo-chap-desktop ]] ||
  fail 'The desktop build did not produce the expected application.'

rm -rf "$desktop_target"
mv "$packaged_desktop" "$desktop_target"
# Agent hosts can export this variable, which makes Electron run as Node.
quoted_desktop=$(printf '%s' "$desktop_executable" | sed "s/'/'\\\\''/g")
rm -f "$prefix/bin/repo-chap-desktop"
cat > "$prefix/bin/repo-chap-desktop" <<EOF
#!/bin/sh
unset ELECTRON_RUN_AS_NODE
exec '$quoted_desktop' "\$@"
EOF
chmod 0755 "$prefix/bin/repo-chap-desktop"

# Installers cannot change the parent shell, so persist PATH for new terminals.
path_files=()
path_configured=no
case ${SHELL:-} in
  */zsh) path_files=("${ZDOTDIR:-$HOME}/.zshrc") ;;
  */bash)
    path_files=("$HOME/.bashrc")
    if [[ -f $HOME/.bash_profile ]]; then
      path_files+=("$HOME/.bash_profile")
    elif [[ -f $HOME/.bash_login ]]; then
      path_files+=("$HOME/.bash_login")
    else
      path_files+=("$HOME/.profile")
    fi
    ;;
esac
# Single quotes keep spaces, dollar signs, and command substitutions literal.
quoted_bin=$(printf '%s' "$prefix/bin" | sed "s/'/'\\\\''/g")
path_line="export PATH='$quoted_bin':\"\$PATH\""
for path_file in ${path_files[@]+"${path_files[@]}"}; do
  path_configured=yes
  mkdir -p "$(dirname "$path_file")"
  if ! grep -Fqx "$path_line" "$path_file" 2>/dev/null; then
    printf '\n# Repo Chap CLI and desktop launcher\n%s\n' "$path_line" >> "$path_file"
  fi
done

skill_input=
skill_tty=no
if [[ $skill_choice == ask ]]; then
  if exec 3<>/dev/tty 2>/dev/null; then
    skill_tty=yes
    printf 'Install the Repo Chap workflow skill globally? [Y/n] ' >&3
    IFS= read -r skill_input <&3 || skill_input=n
    case $skill_input in
      ''|y|Y|yes|YES|Yes) skill_choice=yes ;;
      *) skill_choice=no ;;
    esac
  else
    skill_choice=no
    printf 'No interactive terminal found, so the workflow skill was not installed.\n'
  fi
fi

if [[ $skill_choice == yes ]]; then
  printf 'Choose which agents should receive the global workflow skill.\n'
  if [[ $skill_tty == yes ]]; then
    vp dlx skills add "$source_directory/skills/repo-chap-workflows" --global <&3
    exec 3>&-
  else
    vp dlx skills add "$source_directory/skills/repo-chap-workflows" --global
  fi
elif [[ $skill_tty == yes ]]; then
  exec 3>&-
fi

printf '\nRepo Chap is installed and up to date.\n'
if [[ :$PATH: != *":$prefix/bin:"* ]]; then
  if [[ $path_configured == yes ]]; then
    printf 'Open a new terminal, or run this in your current Bash/Zsh shell:\n  %s\n' "$path_line"
  else
    printf 'Add %s/bin to PATH in your shell configuration, then open a new terminal.\n' "$prefix"
  fi
fi
if [[ $platform == darwin ]]; then
  printf 'Desktop app: %s\n' "$desktop_target"
fi
printf 'From a configured repository, open the app with:\n'
printf '  repo-chap-desktop --repo-root "$PWD" --workflow "$PWD/.repo-chap/workflow.json"\n'
