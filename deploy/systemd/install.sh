#!/bin/sh
# CanvCode の定期バックアップ（canvcode-backup.service / .timer）を systemd のユーザーユニットとして入れる。
# 使い方：deploy/systemd/install.sh [--workspace <ワークスペース>] [--dry-run]
#   リポジトリの場所はこのスクリプトの場所から、node は PATH から決める。
#   ワークスペースは --workspace、なければ CANVCODE_WORKSPACE、なければ <リポジトリ>/workspace
#   --dry-run：書き出すユニットを表示するだけで、入れない
# リモート（既定 gdrive:CanvCode-backup）や rclone の場所を変えるときは ~/.config/canvcode/backup.env に
#   CANVCODE_BACKUP_REMOTE=... / CANVCODE_RCLONE=... を書く
set -eu

here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../.." && pwd)
workspace=${CANVCODE_WORKSPACE:-$repo/workspace}
dry_run=0
while [ $# -gt 0 ]; do
  case "$1" in
    --workspace) workspace=$2; shift 2 ;;
    --dry-run) dry_run=1; shift ;;
    *) echo "知らない引数です：$1" >&2; exit 1 ;;
  esac
done

node=$(command -v node) || { echo 'node が見つかりません' >&2; exit 1; }
command -v rclone >/dev/null || echo '注意：rclone が PATH にありません' >&2
path="$(dirname "$node"):/usr/local/bin:/usr/bin:/bin"
target=${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user

render() {
  sed -e "s|@REPO@|$repo|g" -e "s|@WORKSPACE@|$workspace|g" -e "s|@NODE@|$node|g" -e "s|@PATH@|$path|g" "$here/$1"
}

if [ "$dry_run" = 1 ]; then
  for unit in canvcode-backup.service canvcode-backup.timer; do
    echo "# $target/$unit"
    render "$unit"
    echo
  done
  exit 0
fi

mkdir -p "$target"
render canvcode-backup.service >"$target/canvcode-backup.service"
render canvcode-backup.timer >"$target/canvcode-backup.timer"
systemctl --user daemon-reload
systemctl --user enable --now canvcode-backup.timer
echo "入れました：$target/canvcode-backup.{service,timer}（ワークスペース：$workspace）"
systemctl --user list-timers canvcode-backup.timer --no-pager
