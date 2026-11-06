# -*- coding: utf-8 -*-
"""利用状況（だれが・どの PC で・どの版を使っているか）。WaveLog backend/presence.py を移したもの。

置き場: 設定 presence.dir（共有フォルダ）の下。空なら data/presence_docmaker（この PC の中だけ）。
    <key>.json          … いま使っている（心拍で at を更新。TTL を過ぎたら使っていない）
    history/<key>.json  … 使った記録（初めて・最後・回数・使った時間・版の移り変わり）
    key = 「PC名@ログインID」（ファイル名に使えない字は _、変えたら sha1 の頭を付ける）
**1つのファイルを書くのはその PC だけ**（ほかの PC とぶつからない）。書くときは一時ファイル → 置き換え。
読めないファイルは「無い」ではなく「読めない」（消さない）。

「最新版」は、使っている人たちの版のうちいちばん新しいもの（version.version_key で数で比べる）。
権限（役割）の仕組みができるまでは、全員を数える。あとで除外したい役割は EXCLUDED_ROLES に足す。
切断・記録の削除は、権限の判定ができてから足す（いまは作らない）。
"""
import hashlib
import json
import re
import threading
import time
from datetime import datetime
from pathlib import Path

from ..fsio import now_iso, write_json_atomic
from ..version import APP_VERSION, version_key

TTL_SEC = 75                 # 心拍がこれより古ければ「使っていない」
WRITE_INTERVAL_SEC = 20      # いまの状態を書く間隔（心拍はもっと頻繁でも、書くのはこの間隔）
HISTORY_WRITE_SEC = 60
SWEEP_INTERVAL_SEC = 300
NEWEST_INTERVAL_SEC = 300
HISTORY_VERSIONS = 10
EXCLUDED_ROLES = ()          # 「最新版」に数えない役割（権限管理ができたら使う）

_lock = threading.Lock()
_state = {"dir": None, "last_write": 0.0, "last_history": 0.0, "last_sweep": 0.0, "since": None,
          "session_key": None, "newest": None, "newest_at": 0.0, "busy": False, "left": False}


def configure(dir_path):
    with _lock:
        _state["dir"] = Path(dir_path) if dir_path else None
        _state.update(last_write=0.0, last_history=0.0, last_sweep=0.0, since=None, session_key=None,
                      newest=None, newest_at=0.0, left=False)


def presence_dir():
    return _state["dir"]


def terminal_key(login, pc):
    raw = f"{pc or '?'}@{login or '?'}"
    safe = re.sub(r'[\\/:*?"<>|\s]', "_", raw)[:100]
    if safe != raw:
        safe += "-" + hashlib.sha1(raw.encode("utf-8")).hexdigest()[:6]
    return safe


def _age_sec(data):
    try:
        return (datetime.now() - datetime.fromisoformat(str(data.get("at")))).total_seconds()
    except Exception:
        return None


def _read_json(path):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        return None
    except Exception:
        return {"_unreadable": True}


def _write_json(path, data):
    # 置き場の親（共有フォルダ・この PC の作業フォルダ）が無ければ書かない（共有の置き場そのものは作らない）
    root = presence_dir()
    if root is None or not root.parent.exists():
        return False
    try:
        write_json_atomic(path, data, indent=1, retry_budget=1.0)
        return True
    except OSError:
        return False


def _hist_path(key):
    return presence_dir() / "history" / f"{key}.json"


# ------------------------------------------------------------------ 書く（この PC の分だけ）
def _record(key, login, pc, now, final=False):
    """使った記録を足す。新しい使い始めは、key が変わった・前から TTL より空いたとき。"""
    path = _hist_path(key)
    h = _read_json(path)
    if not h or h.get("_unreadable"):
        h = {"key": key, "login": login, "pc": pc, "firstAt": now, "sessions": 0, "totalSec": 0, "versions": {}}
    last = h.get("lastAt")
    try:
        gap = (datetime.fromisoformat(now) - datetime.fromisoformat(last)).total_seconds() if last else None
    except Exception:
        gap = None
    new_session = _state["session_key"] != key or gap is None or gap > TTL_SEC
    if new_session:
        h["sessions"] = int(h.get("sessions") or 0) + 1
        h["sessionAt"] = now
        _state["session_key"] = key
    elif gap:
        h["totalSec"] = int(h.get("totalSec") or 0) + int(min(gap, TTL_SEC))
    h.update(login=login, pc=pc, lastAt=now, version=APP_VERSION)
    vers = dict(h.get("versions") or {})
    vers[APP_VERSION] = now
    h["versions"] = dict(sorted(vers.items(), key=lambda kv: kv[1])[-HISTORY_VERSIONS:])
    if final or new_session or time.time() - _state["last_history"] >= HISTORY_WRITE_SEC:
        _write_json(path, h)
        _state["last_history"] = time.time()


def touch(login, pc, force=False):
    """いま使っていることを書く（WRITE_INTERVAL ごと）。記録・掃除・最新版の数え直しもここで。"""
    if presence_dir() is None:
        return False
    t = time.time()
    if not force and t - _state["last_write"] < WRITE_INTERVAL_SEC:
        return False
    key = terminal_key(login, pc)
    now = now_iso()
    if _state["since"] is None or _state["session_key"] != key:
        _state["since"] = now
    ok = _write_json(presence_dir() / f"{key}.json", {"key": key, "login": login, "pc": pc,
                                                       "version": APP_VERSION, "since": _state["since"], "at": now})
    _state["last_write"] = t
    _state["left"] = False
    _record(key, login, pc, now)
    if t - _state["last_sweep"] >= SWEEP_INTERVAL_SEC:
        _sweep()
        _state["last_sweep"] = t
    return ok


def touch_async(login, pc):
    """心拍から呼ぶ。書くのは裏の1本の糸（共有が遅くても心拍を待たせない）。書いている最中の頼みは捨てる。"""
    if presence_dir() is None or time.time() - _state["last_write"] < WRITE_INTERVAL_SEC:
        return
    with _lock:
        if _state["busy"]:
            return
        _state["busy"] = True

    def run():
        try:
            touch(login, pc)
            if time.time() - _state["newest_at"] >= NEWEST_INTERVAL_SEC:
                refresh_newest()
        except Exception:
            pass
        finally:
            _state["busy"] = False
    threading.Thread(target=run, name="presence", daemon=True).start()


def leave(login, pc):
    """使い終わり（アプリの終了）。いまのファイルを消し、記録を最後まで書く。"""
    if presence_dir() is None or _state["left"]:
        return
    key = terminal_key(login, pc)
    try:
        _record(key, login, pc, now_iso(), final=True)
        (presence_dir() / f"{key}.json").unlink(missing_ok=True)
    except OSError:
        pass
    _state["left"] = True


def _sweep():
    """古い「いま使っている」（TTL の4倍）を消す。読めないものは消さない。記録は消さない。"""
    try:
        for p in presence_dir().glob("*.json"):
            data = _read_json(p)
            if not data or data.get("_unreadable"):
                continue
            age = _age_sec(data)
            if age is not None and age > TTL_SEC * 4:
                p.unlink(missing_ok=True)
    except OSError:
        pass


# ------------------------------------------------------------------ 読む
def _online():
    d = presence_dir()
    out = []
    if d is None or not d.exists():
        return out
    for p in d.glob("*.json"):
        data = _read_json(p)
        if not data or data.get("_unreadable"):
            continue
        age = _age_sec(data)
        if age is not None and age <= TTL_SEC:
            out.append(dict(data, idleSec=int(age)))
    return out


def _history():
    d = presence_dir()
    out = []
    if d is None or not (d / "history").exists():
        return out
    for p in (d / "history").glob("*.json"):
        data = _read_json(p)
        if data and not data.get("_unreadable"):
            out.append(data)
    return out


def latest_version():
    """使っている人たちの版のうち、いちばん新しいもの。数えられなければ None。"""
    vers = [str(r.get("version") or "") for r in _history() + _online()]
    vers = [v for v in vers if v]
    return max(vers, key=version_key) if vers else None


def refresh_newest():
    try:
        v = latest_version()
        if v:
            _state["newest"] = v
    except Exception:
        pass            # 読めなければ前の答えのまま
    _state["newest_at"] = time.time()


def version_notice():
    """{latestVersion, myVersion, outdated}（まだ数えていなければ None）。"""
    latest = _state["newest"]
    if not latest:
        return None
    return {"latestVersion": latest, "myVersion": APP_VERSION, "outdated": version_key(latest) > version_key(APP_VERSION)}


def fleet():
    """利用状況の画面の中身: PC ごとの記録（いま使っているか・版・最新か）と数。"""
    online = {r["key"]: r for r in _online()}
    hist = {h.get("key"): h for h in _history() if h.get("key")}
    latest = latest_version()
    items = []
    for k in set(online) | set(hist):
        o, h = online.get(k), hist.get(k) or {}
        src = o or h
        ver = (o or {}).get("version") or h.get("version") or ""
        items.append({"key": k, "login": src.get("login", ""), "pc": src.get("pc", ""), "version": ver,
                      "online": bool(o), "idleSec": o.get("idleSec") if o else None, "since": (o or {}).get("since"),
                      "firstAt": h.get("firstAt"), "lastAt": (o or {}).get("at") or h.get("lastAt"),
                      "sessions": h.get("sessions", 0), "totalSec": h.get("totalSec", 0), "versions": h.get("versions", {}),
                      "outdated": bool(latest and ver and version_key(latest) > version_key(ver))})
    items.sort(key=lambda x: (not x["outdated"], not x["online"], x["pc"], x["login"]))
    return {"items": items, "latest": latest, "online": sum(1 for x in items if x["online"]),
            "outdated": sum(1 for x in items if x["outdated"]), "total": len(items),
            "dir": str(presence_dir() or ""), "ttlSec": TTL_SEC}
