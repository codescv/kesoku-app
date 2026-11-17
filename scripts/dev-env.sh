#!/usr/bin/env bash
# Deterministic non-interactive developer environment setup for Node/pnpm, JDK, and Android SDK.
#
# Usage:
#   . scripts/dev-env.sh                  # source in a shell or build script
#   ./scripts/dev-env.sh <cmd> [args...]  # run a command with the resolved environment

_kesoku_prepend_path() {
  local dir="$1"
  if [[ -n "$dir" && -d "$dir" ]]; then
    case ":${PATH:-}:" in
      *":$dir:"*) ;;
      *) PATH="${dir}${PATH:+:$PATH}" ;;
    esac
  fi
}

_kesoku_latest_glob_dir() {
  local pattern="$1"
  local match=""
  local candidate
  while IFS= read -r candidate; do
    if [[ -n "$candidate" && -d "$candidate" ]]; then
      match="$candidate"
    fi
  done < <(compgen -G "$pattern" 2>/dev/null | sort -V || true)
  printf '%s' "$match"
}

_kesoku_setup_env() {
  local home="${HOME:-}"
  if [[ -z "$home" ]]; then
    home="$(cd ~ 2>/dev/null && pwd || true)"
  fi

  local fnm_latest=""
  local nvm_latest=""
  if [[ -n "$home" ]]; then
    fnm_latest="$(_kesoku_latest_glob_dir "$home/.local/share/fnm/node-versions/*/installation/bin")"
    nvm_latest="$(_kesoku_latest_glob_dir "$home/.nvm/versions/node/*/bin")"
  fi

  # Prepend in reverse priority order so highest-priority directories end up first on PATH.
  [[ -n "$nvm_latest" ]] && _kesoku_prepend_path "$nvm_latest"
  [[ -n "$home" ]] && _kesoku_prepend_path "$home/.local/bin"
  [[ -n "$fnm_latest" ]] && _kesoku_prepend_path "$fnm_latest"
  [[ -n "$home" ]] && _kesoku_prepend_path "$home/.local/share/fnm/aliases/default/bin"
  [[ -n "$home" ]] && _kesoku_prepend_path "$home/.local/share/pnpm"

  # Resolve JAVA_HOME if unset or pointing to a non-existent java binary.
  if [[ -z "${JAVA_HOME:-}" || ! -x "${JAVA_HOME}/bin/java" ]]; then
    local java_bin=""
    java_bin="$(command -v java 2>/dev/null || true)"
    local need_probe=0
    if [[ -z "${JAVA_HOME:-}" ]]; then
      need_probe=1
    elif [[ -z "$java_bin" || ! -e "$java_bin" ]]; then
      need_probe=1
    fi

    if [[ "$need_probe" -eq 1 ]]; then
      local jdk_candidate=""
      local c
      for c in \
        "$(_kesoku_latest_glob_dir "/usr/lib/jvm/java-21-*")" \
        "$(_kesoku_latest_glob_dir "/usr/lib/jvm/java-17-*")" \
        "${home:+$(_kesoku_latest_glob_dir "$home/.jdks/*")}" \
        "/usr/lib/jvm/default-java"
      do
        if [[ -n "$c" && -x "$c/bin/java" ]]; then
          jdk_candidate="$c"
          break
        fi
      done
      if [[ -n "$jdk_candidate" ]]; then
        export JAVA_HOME="$jdk_candidate"
      fi
    fi
  fi

  if [[ -n "${JAVA_HOME:-}" && -d "${JAVA_HOME}/bin" ]]; then
    export JAVA_HOME
    _kesoku_prepend_path "${JAVA_HOME}/bin"
  fi

  # Resolve ANDROID_HOME / ANDROID_SDK_ROOT if unset.
  if [[ -z "${ANDROID_HOME:-}" && -n "${ANDROID_SDK_ROOT:-}" && -d "${ANDROID_SDK_ROOT}" ]]; then
    export ANDROID_HOME="${ANDROID_SDK_ROOT}"
  fi
  if [[ -z "${ANDROID_HOME:-}" ]]; then
    local sdk_candidate
    for sdk_candidate in "${home:+$home/Android/Sdk}" "/opt/android-sdk"; do
      if [[ -n "$sdk_candidate" && -d "$sdk_candidate" ]]; then
        export ANDROID_HOME="$sdk_candidate"
        break
      fi
    done
  fi
  if [[ -n "${ANDROID_HOME:-}" && -z "${ANDROID_SDK_ROOT:-}" ]]; then
    export ANDROID_SDK_ROOT="${ANDROID_HOME}"
  fi

  export PATH
}

_kesoku_setup_env
unset -f _kesoku_prepend_path _kesoku_latest_glob_dir _kesoku_setup_env

if [[ "${BASH_SOURCE[0]}" == "${0}" && $# -gt 0 ]]; then
  exec "$@"
fi
