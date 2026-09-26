#!/usr/bin/env python3
"""블로그 글쓰기 도구 (로컬 전용).

    python tools/writer.py [파일 또는 폴더 ...]

브라우저에 글쓰기 화면이 열린다. 파일을 끌어다 놓고 제목, 카테고리, 태그를
적은 뒤 [저장하고 게시하기]를 누르면 posts/ 아래에 글 폴더를 만들고
git commit, push 까지 한다. 이미 실행 중이면 새로 받은 파일을 그 창으로 넘긴다.
"""

from __future__ import annotations

import datetime as dt
import hashlib
import http.server
import json
import os
import re
import secrets
import shutil
import socket
import subprocess
import sys
import threading
import unicodedata
import urllib.parse
import urllib.request
import uuid
import webbrowser
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
ROOT = TOOLS.parent
sys.path.insert(0, str(TOOLS))

import yaml  # noqa: E402

import build  # noqa: E402
import mdrender  # noqa: E402

POSTS = ROOT / "posts"
UI_DIR = TOOLS / "writer"
STATE_DIR = ROOT / ".writer"
STAGING = STATE_DIR / "staging"
INSTANCE_FILE = STATE_DIR / "instance.json"
SETTINGS_FILE = ROOT / ".writer-local.json"
KST = build.KST
MAX_FILE = 100 * 1024 * 1024   # GitHub refuses files over 100 MB
WARN_FILE = 50 * 1024 * 1024
SKIP_DIRS = {".git", "node_modules", "__pycache__", ".venv", "venv", "third_party", "submodules"}

LOCK = threading.RLock()
ITEMS: dict[str, dict] = {}
INBOX: list[dict] = []
TOKEN = ""
PORT = 0
SERVER: http.server.ThreadingHTTPServer | None = None


class ApiError(Exception):
    def __init__(self, message: str, status: int = 400) -> None:
        super().__init__(message)
        self.status = status


# --------------------------------------------------------------------------
# settings
# --------------------------------------------------------------------------

def load_settings() -> dict:
    settings = {"source_roots": [], "start_dir": ""}
    try:
        settings.update(json.loads(SETTINGS_FILE.read_text(encoding="utf-8")))
    except (OSError, ValueError):
        pass
    return settings


def save_settings(settings: dict) -> None:
    SETTINGS_FILE.write_text(json.dumps(settings, ensure_ascii=False, indent=2), encoding="utf-8")


# --------------------------------------------------------------------------
# inspecting files
# --------------------------------------------------------------------------

_MD_LINK_RE = re.compile(r"!?\[(?:[^\]\\\n]|\\.)*\]\(\s*(<[^>\n]+>|[^)\s]+)(?:\s+[\"'(][^)\n]*)?\)")
_MD_REFDEF_RE = re.compile(r"^[ ]{0,3}\[[^\]\n]+\]:[ \t]*(<[^>\n]+>|\S+)", re.M)
_HTML_REF_RE = re.compile(r"""\b(?:src|poster)\s*=\s*(["'])(.*?)\1|<link\b[^>]*?\bhref\s*=\s*(["'])(.*?)\3""", re.I | re.S)
_FENCED_RE = re.compile(r"^([ \t]*)(`{3,}|~{3,})[^\n]*\n.*?^\1?[ \t]*\2[ \t]*$", re.M | re.S)
_TITLE_RE = re.compile(r"<title[^>]*>(.*?)</title>", re.I | re.S)


def _is_local_ref(ref: str) -> bool:
    return bool(ref) and not ref.startswith(("#", "/", "//")) and not re.match(r"^[A-Za-z][A-Za-z0-9+.-]*:", ref)


def find_refs(path: Path, kind: str, base: Path) -> tuple[list[list[str]], list[str]]:
    """Relative files a Markdown/HTML document points to: ([rel, abs], ...), [missing rel, ...]."""
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return [], []
    raw: list[str] = []
    if kind == "md":
        _, body = mdrender.split_front_matter(text)
        body = _FENCED_RE.sub("", body)
        body = re.sub(r"`[^`\n]*`", "", body)
        raw += [m.group(1) for m in _MD_LINK_RE.finditer(body)]
        raw += [m.group(1) for m in _MD_REFDEF_RE.finditer(body)]
        raw += [m.group(1) for m in mdrender._OBSIDIAN_EMBED_RE.finditer(body)]
        raw += [m.group(2) or m.group(4) for m in _HTML_REF_RE.finditer(body)]
    else:
        raw += [m.group(2) or m.group(4) for m in _HTML_REF_RE.finditer(text)]

    found: list[list[str]] = []
    missing: list[str] = []
    seen: set[str] = set()
    for ref in raw:
        ref = (ref or "").strip()
        if ref.startswith("<") and ref.endswith(">"):
            ref = ref[1:-1].strip()
        if not _is_local_ref(ref):
            continue
        head = re.split(r"[?#]", ref, maxsplit=1)[0]
        # the whole string first: a file name may itself contain '#'
        candidates = [urllib.parse.unquote(ref).replace("\\", "/")]
        if head != ref:
            candidates.append(urllib.parse.unquote(head).replace("\\", "/"))
        key = candidates[-1]
        if not key or key in seen:
            continue
        seen.add(key)
        for clean in candidates:
            target = base / clean
            if target.is_file():
                if target.resolve() != path.resolve():
                    found.append([clean, str(target.resolve())])
                break
        else:
            if Path(key).suffix:          # a link to a folder is not a missing file
                missing.append(key)
    return found, missing


def first_heading(path: Path) -> str:
    try:
        _, body = mdrender.split_front_matter(path.read_text(encoding="utf-8", errors="replace"))
    except OSError:
        return ""
    match = re.search(r"^#[ \t]+(.+?)[ \t#]*$", body, re.M)
    return match.group(1).strip() if match else ""


def html_title(path: Path) -> str:
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as handle:
            head = handle.read(200_000)
    except OSError:
        return ""
    match = _TITLE_RE.search(head)
    return re.sub(r"\s+", " ", match.group(1)).strip() if match else ""


def register(path: Path, *, base: Path | None = None, name: str | None = None, staged: bool = False, origin: str = "") -> dict:
    path = Path(path)
    if not path.is_file():
        raise ApiError(f"파일이 없습니다: {path}")
    name = name or path.name
    kind = mdrender.kind_of(name)
    base = Path(base) if base else path.parent
    refs, missing = find_refs(path, kind, base) if kind in ("md", "html") else ([], [])
    size = path.stat().st_size
    title = first_heading(path) if kind == "md" else html_title(path) if kind == "html" else ""
    warn = ""
    if size > MAX_FILE:
        warn = "100MB가 넘는 파일은 GitHub에 올릴 수 없습니다. 파일을 줄이거나 나눠 주세요."
    elif size > WARN_FILE:
        warn = "50MB가 넘는 큰 파일입니다. 올릴 수는 있지만 페이지가 느려질 수 있습니다."
    split_note = kind == "pdf" and mdrender.is_split_note_pdf(path)
    item = {
        "id": uuid.uuid4().hex[:12],
        "path": str(path),
        "base": str(base),
        "name": name,
        "kind": kind,
        "size": size,
        "size_text": mdrender.human_size(size),
        "refs": refs,
        "missing": missing,
        "title": title or Path(name).stem,
        "staged": staged,
        "origin": origin or ("" if staged else str(path)),
        "warn": warn,
        "attach": True,
        "split_note": split_note,
        "joined": split_note,
    }
    ITEMS[item["id"]] = item
    return public_item(item)


def public_item(item: dict) -> dict:
    refs_size = sum(Path(p).stat().st_size for _, p in item["refs"] if Path(p).exists())
    return {
        "id": item["id"],
        "name": item["name"],
        "kind": item["kind"],
        "size_text": item["size_text"],
        "refs": [rel for rel, _ in item["refs"]],
        "refs_size": mdrender.human_size(refs_size) if item["refs"] else "",
        "missing": item["missing"],
        "title": item["title"],
        "origin": item["origin"],
        "warn": item["warn"],
        "attach": item.get("attach", True),
        "split_note": item.get("split_note", False),
        "joined": item.get("joined", False),
    }


def register_many(paths: list[Path]) -> list[dict]:
    out = []
    for path in paths:
        path = Path(path)
        if path.is_dir():
            children = sorted(
                (p for p in path.iterdir() if p.is_file() and not p.name.startswith((".", "~$")) and p.name.lower() not in build.SKIP_FILES),
                key=lambda p: build.natural_key(p.name),
            )
            out += [register(child) for child in children]
        elif path.is_file():
            out.append(register(path))
    return out


def locate_original(name: str, size: int, modified_ms: int) -> Path | None:
    """Find where a file dropped into the browser came from (same name and size)."""
    best = None
    for root in load_settings().get("source_roots") or []:
        if not root or not Path(root).is_dir():
            continue
        for dirpath, dirnames, filenames in os.walk(root):
            dirnames[:] = [d for d in dirnames if not d.startswith(".") and d not in SKIP_DIRS]
            if name not in filenames:
                continue
            candidate = Path(dirpath) / name
            try:
                stat = candidate.stat()
            except OSError:
                continue
            if stat.st_size != size:
                continue
            if modified_ms and abs(stat.st_mtime * 1000 - modified_ms) < 3000:
                return candidate
            best = best or candidate
    return best


# --------------------------------------------------------------------------
# posts on disk
# --------------------------------------------------------------------------

FRONT_ORDER = ["title", "date", "category", "tags", "description", "draft", "pin"]


def _yaml_value(value) -> str:
    text = yaml.safe_dump(value, allow_unicode=True, default_flow_style=True, width=10**9, sort_keys=False).strip()
    return text[:-4].rstrip() if text.endswith("\n...") else text


def dump_front_matter(meta: dict) -> str:
    lines = ["---"]
    for key in FRONT_ORDER + [k for k in meta if k not in FRONT_ORDER]:
        if key not in meta or meta[key] is None or meta[key] == "" or (key in ("draft", "pin") and not meta[key]):
            continue
        value = meta[key]
        if key == "date" and isinstance(value, str):
            lines.append(f"date: {value}")
        elif key == "tags":
            lines.append("tags: " + _yaml_value(list(value)))
        else:
            lines.append(f"{key}: " + _yaml_value(value))
    lines.append("---")
    return "\n".join(lines) + "\n"


def write_post_file(path: Path, meta: dict, body: str) -> None:
    text = dump_front_matter(meta) + "\n" + body.strip("\n") + "\n"
    path.write_text(text, encoding="utf-8", newline="\n")


def safe_name(text: str, limit: int = 60) -> str:
    text = unicodedata.normalize("NFC", text).strip()
    text = re.sub(r'[\\/:*?"<>|#%&{}^~\[\]`\'\x00-\x1f]', "", text)
    text = re.sub(r"\s+", "-", text)
    text = re.sub(r"-{2,}", "-", text).strip(".-")
    return text[:limit].rstrip(".-")


def post_source(slug: str) -> tuple[Path, Path, bool]:
    """(folder, markdown file, is_single_file) for an existing post slug."""
    if not slug or "/" in slug or "\\" in slug or slug in (".", ".."):
        raise ApiError("잘못된 글 이름입니다")
    folder = POSTS / slug
    if folder.is_dir():
        return folder, folder / "index.md", False
    for ext in mdrender.MD_EXT:
        single = POSTS / f"{slug}{ext}"
        if single.is_file():
            return POSTS, single, True
    raise ApiError("글을 찾을 수 없습니다", 404)


def read_meta(path: Path) -> tuple[dict, str]:
    if not path.exists():
        return {}, ""
    front, body = mdrender.split_front_matter(path.read_text(encoding="utf-8", errors="replace"))
    try:
        meta = yaml.safe_load(front) if front else {}
    except yaml.YAMLError:
        meta = {}
    return (meta if isinstance(meta, dict) else {}), body


def _file_digest(path: Path) -> str:
    digest = hashlib.sha1()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def place_files(items: list[dict], folder: Path) -> list[dict]:
    """Copy items (and the files they reference) into a post folder, keeping relative links valid."""
    taken: dict[str, Path] = {}
    for existing in folder.rglob("*"):
        if existing.is_file():
            taken[existing.relative_to(folder).as_posix().casefold()] = existing
    embeds = []
    for item in items:
        source = Path(item["path"])
        virtual = Path(item["base"]) / item["name"]
        refs = [Path(p) for _, p in item["refs"]]
        try:
            anchor = Path(os.path.commonpath([str(virtual.parent)] + [str(r.parent) for r in refs]))
        except ValueError:
            anchor, refs = virtual.parent, [r for r in refs if r.drive == virtual.drive]
        main_rel = virtual.relative_to(anchor).as_posix()
        stem, suffix = os.path.splitext(main_rel)
        if stem.casefold() == "index":          # index.md / index.html belong to the post itself
            main_rel = f"{stem}-1{suffix}"
        plan = [(source, main_rel)] + [(r, r.relative_to(anchor).as_posix()) for r in refs]

        def clashes(pairs) -> bool:
            for src, rel in pairs:
                other = taken.get(rel.casefold())
                if other is not None and (other.stat().st_size != src.stat().st_size or _file_digest(other) != _file_digest(src)):
                    return True
            return False

        if clashes(plan):
            prefix = safe_name(Path(item["name"]).stem, 40) or "files"
            number = 1
            while any(k.startswith((prefix + ("" if number == 1 else f"-{number}")).casefold() + "/") for k in taken):
                number += 1
            prefix = prefix if number == 1 else f"{prefix}-{number}"
            plan = [(src, f"{prefix}/{rel}") for src, rel in plan]
        for src, rel in plan:
            dest = folder / rel
            if rel.casefold() in taken and taken[rel.casefold()].exists():
                continue
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, dest)
            taken[rel.casefold()] = dest
        embeds.append({
            "rel": plan[0][1],
            "kind": item["kind"],
            "attach": item.get("attach", True),
            "joined": bool(item.get("joined")),
        })
    return embeds


def _stacks(embed: dict | None) -> bool:
    """Images and handwritten-note PDFs stack into one continuous sheet."""
    return bool(embed) and (embed["kind"] == "image" or (embed["kind"] == "pdf" and embed.get("joined")))


def embed_markdown(embeds: list[dict]) -> list[str]:
    blocks: list[str] = []
    previous = None
    for embed in embeds:
        line = f"![](<{embed['rel']}>)"
        if embed["kind"] == "pdf":
            line += "{.joined}" if embed.get("joined") else "{.pages}"
        if blocks and _stacks(embed) and _stacks(previous) and embed.get("attach", True):
            blocks[-1] += "\n" + line
        else:
            blocks.append(line)
        previous = embed
    return blocks


def parse_input_date(value: str | None) -> dt.datetime:
    moment = build.parse_date(value.replace("T", " ") if value else None, None)
    return moment or dt.datetime.now(KST)


def rebuild() -> dict:
    with LOCK:
        return build.build(ROOT, include_drafts=True, quiet=True)


def site_meta() -> dict:
    config = build.load_config(ROOT)
    posts = build.load_posts(ROOT, config, include_drafts=True)
    base = config["base_path"]
    categories: dict[str, int] = {}
    tags: dict[str, list] = {}
    rows = []
    for post in posts:
        parts = post.category.split("/")
        for depth in range(1, len(parts) + 1):
            key = "/".join(parts[:depth])
            categories[key] = categories.get(key, 0) + 1
        for tag in post.tags:
            tags.setdefault(tag.casefold(), [tag, 0])[1] += 1
        rows.append({
            "slug": post.slug,
            "title": post.title,
            "date": post.date.strftime("%Y-%m-%d %H:%M"),
            "category": post.category,
            "tags": post.tags,
            "draft": post.draft,
            "pin": post.pinned,
            "url": f"{base}/posts/{urllib.parse.quote(post.slug)}/",
        })
    return {
        "site_title": config["title"],
        "site_url": config["url"],
        "base": base,
        "github": config.get("github", ""),
        "default_category": config["default_category"],
        "posts": rows,
        "categories": [{"name": k, "count": v} for k, v in sorted(categories.items(), key=lambda kv: build.natural_key(kv[0]))],
        "tags": [{"name": n, "count": c} for n, c in sorted(tags.values(), key=lambda t: (-t[1], t[0].casefold()))],
        "git": git_status(),
        "settings": load_settings(),
    }


def save_post(data: dict) -> dict:
    title = str(data.get("title") or "").strip()
    if not title:
        raise ApiError("제목을 적어 주세요.")
    items = []
    for entry in data.get("items") or []:
        item = ITEMS.get(str(entry.get("id")))
        if not item:
            raise ApiError("파일 목록이 오래되었습니다. 파일을 다시 넣어 주세요.")
        if item["size"] > MAX_FILE:
            raise ApiError(f"{item['name']}: 100MB가 넘어 올릴 수 없습니다.")
        items.append({
            **item,
            "attach": bool(entry.get("attach", True)),
            "joined": bool(entry.get("joined", item.get("joined", False))),
        })
    intro = str(data.get("intro") or "").strip()
    if not items and not intro:
        raise ApiError("올릴 파일이나 본문을 넣어 주세요.")
    config = build.load_config(ROOT)
    date = parse_input_date(data.get("date"))
    meta = {
        "title": title,
        "date": date.strftime("%Y-%m-%d %H:%M"),
        "category": build.normalize_category(data.get("category")) or config["default_category"],
        "tags": build.normalize_tags(data.get("tags") or []),
        "description": str(data.get("description") or "").strip(),
        "draft": bool(data.get("draft")),
    }
    with LOCK:
        POSTS.mkdir(exist_ok=True)
        base_name = f"{date:%Y-%m-%d}-{safe_name(title) or 'post'}"
        folder = POSTS / base_name
        number = 2
        while folder.exists() or (POSTS / f"{folder.name}.md").exists():
            folder = POSTS / f"{base_name}-{number}"
            number += 1
        folder.mkdir(parents=True)
        try:
            embeds = place_files(items, folder)
            blocks = ([intro] if intro else []) + embed_markdown(embeds)
            write_post_file(folder / "index.md", meta, "\n\n".join(blocks))
        except Exception:
            shutil.rmtree(folder, ignore_errors=True)
            raise
        result = rebuild()
    log(f"저장: {folder.name}")
    return {
        "slug": folder.name,
        "url": f"{config['base_path']}/posts/{urllib.parse.quote(folder.name)}/",
        "warnings": [w for w in result["warnings"] if w.startswith(folder.name)],
    }


def read_post(slug: str) -> dict:
    folder, source, single = post_source(slug)
    meta, body = read_meta(source)
    if not source.exists():
        body = build.auto_body(folder)
    config = build.load_config(ROOT)
    files = []
    if not single:
        for path in sorted(folder.rglob("*"), key=lambda p: build.natural_key(p.relative_to(folder).as_posix())):
            if path.is_file() and path.name != "index.md":
                files.append({"name": path.relative_to(folder).as_posix(), "size_text": mdrender.human_size(path.stat().st_size)})
    date = build.parse_date(meta.get("date"), None)
    return {
        "slug": slug,
        "title": str(meta.get("title") or ""),
        "date": date.strftime("%Y-%m-%dT%H:%M") if date else "",
        "category": build.normalize_category(meta.get("category", meta.get("categories"))),
        "tags": build.normalize_tags(meta.get("tags")),
        "description": str(meta.get("description") or ""),
        "draft": bool(meta.get("draft", False)),
        "pin": bool(meta.get("pin", meta.get("pinned", False))),
        "body": body.lstrip("\n"),
        "files": files,
        "single": single,
        "url": f"{config['base_path']}/posts/{urllib.parse.quote(slug)}/",
    }


def update_post(data: dict) -> dict:
    slug = str(data.get("slug") or "")
    with LOCK:
        folder, source, single = post_source(slug)
        meta, body = read_meta(source)
        if not source.exists():
            body = build.auto_body(folder)
        title = str(data.get("title") or "").strip()
        if not title:
            raise ApiError("제목을 적어 주세요.")
        meta["title"] = title
        date = parse_input_date(data.get("date"))
        meta["date"] = date.strftime("%Y-%m-%d %H:%M")
        meta.pop("categories", None)
        meta["category"] = build.normalize_category(data.get("category")) or build.load_config(ROOT)["default_category"]
        meta["tags"] = build.normalize_tags(data.get("tags") or [])
        meta["description"] = str(data.get("description") or "").strip()
        meta["draft"] = bool(data.get("draft"))
        meta["pin"] = bool(data.get("pin"))
        meta.pop("pinned", None)
        if "body" in data:
            body = str(data["body"])
        new_items = [
            ITEMS[e["id"]] | {"attach": bool(e.get("attach", True)), "joined": bool(e.get("joined", ITEMS[e["id"]].get("joined", False)))}
            for e in data.get("items") or []
            if e.get("id") in ITEMS
        ]
        if new_items:
            if single:
                raise ApiError("파일 하나짜리 글에는 파일을 추가할 수 없습니다.")
            embeds = place_files(new_items, folder)
            blocks = embed_markdown(embeds)
            body = body.rstrip("\n") + "\n\n" + "\n\n".join(blocks)
        write_post_file(source, meta, body)
        rebuild()
    log(f"수정: {slug}")
    return read_post(slug)


def delete_post(slug: str) -> dict:
    with LOCK:
        folder, source, single = post_source(slug)
        target = source if single else folder
        if POSTS.resolve() not in target.resolve().parents:
            raise ApiError("posts 폴더 밖은 지울 수 없습니다.")
        if single:
            target.unlink()
        else:
            shutil.rmtree(target)
        rebuild()
    log(f"삭제: {slug}")
    return {"ok": True}


def rename_everywhere(kind: str, old: str, new: str) -> dict:
    old = old.strip().lstrip("#").strip() if kind == "tag" else build.normalize_category(old)
    new = new.strip().lstrip("#").strip() if kind == "tag" else build.normalize_category(new)
    if not old or not new:
        raise ApiError("바꿀 이름과 새 이름을 모두 적어 주세요.")
    changed = 0
    with LOCK:
        sources = [p / "index.md" for p in POSTS.iterdir() if p.is_dir()] + [p for p in POSTS.iterdir() if p.is_file() and p.suffix.lower() in mdrender.MD_EXT]
        for source in sources:
            if not source.exists():
                continue
            meta, body = read_meta(source)
            if kind == "tag":
                tags = build.normalize_tags(meta.get("tags"))
                if old.casefold() not in [t.casefold() for t in tags]:
                    continue
                meta["tags"] = build.normalize_tags([new if t.casefold() == old.casefold() else t for t in tags])
            else:
                category = build.normalize_category(meta.get("category", meta.get("categories")))
                if category != old and not category.startswith(old + "/"):
                    continue
                meta.pop("categories", None)
                meta["category"] = new + category[len(old):]
            write_post_file(source, meta, body)
            changed += 1
        if changed:
            rebuild()
    log(f"이름 변경({kind}): {old} → {new}, {changed}개 글")
    return {"changed": changed}


# --------------------------------------------------------------------------
# git
# --------------------------------------------------------------------------

def git(*args: str, timeout: int = 120) -> tuple[int, str]:
    try:
        proc = subprocess.run(
            ["git", "-c", "core.quotepath=false", *args],
            cwd=ROOT,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
        )
    except FileNotFoundError:
        return 127, "git이 설치되어 있지 않습니다."
    except subprocess.TimeoutExpired:
        return 124, f"git {' '.join(args)} 명령이 {timeout}초 안에 끝나지 않았습니다."
    return proc.returncode, (proc.stdout + proc.stderr).strip()


def git_status() -> dict:
    code, out = git("status", "--porcelain=v1", "--untracked-files=all")
    if code != 0:
        return {"ok": False, "message": out, "changes": 0}
    changes = [line for line in out.splitlines() if line.strip()]
    code, remote = git("remote", "get-url", "origin")
    remote = remote if code == 0 else ""
    ahead = 0
    code, upstream = git("rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}")
    upstream = upstream if code == 0 else ""
    if upstream:
        code, count = git("rev-list", "--count", "@{u}..HEAD")
        ahead = int(count) if code == 0 and count.isdigit() else 0
    return {"ok": True, "changes": len(changes), "ahead": ahead, "remote": remote, "upstream": upstream}


def publish(message: str) -> dict:
    steps: list[str] = []
    with LOCK:
        status = git_status()
        if not status["ok"]:
            raise ApiError("git 저장소가 아닙니다: " + status.get("message", ""))
        if not status["remote"]:
            raise ApiError("GitHub 저장소(origin)가 연결되어 있지 않습니다. README의 '처음 한 번' 절을 보세요.")
        code, out = git("add", "-A")
        steps.append("$ git add -A\n" + out)
        if code != 0:
            return {"ok": False, "log": "\n".join(steps)}
        code, _ = git("diff", "--cached", "--quiet")
        if code == 1:
            message = message.strip() or f"블로그 업데이트 {dt.datetime.now(KST):%Y-%m-%d %H:%M}"
            code, out = git("commit", "-m", message)
            steps.append("$ git commit\n" + out)
            if code != 0:
                return {"ok": False, "log": "\n".join(steps)}
        else:
            steps.append("(새로 커밋할 변경 없음)")
        code, upstream = git("rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}")
        if code == 0:
            code, out = git("pull", "--rebase", "--autostash", timeout=300)
            steps.append("$ git pull --rebase\n" + out)
            if code != 0:
                return {"ok": False, "log": "\n".join(steps)}
            code, out = git("push", timeout=600)
        else:
            code, out = git("push", "-u", "origin", "HEAD", timeout=600)
        steps.append("$ git push\n" + out)
    ok = code == 0
    log("게시 " + ("완료" if ok else "실패"))
    return {"ok": ok, "log": "\n\n".join(steps)}


# --------------------------------------------------------------------------
# http
# --------------------------------------------------------------------------

def log(message: str) -> None:
    print(f"[{dt.datetime.now():%H:%M:%S}] {message}", flush=True)


def pick(mode: str) -> list[str]:
    settings = load_settings()
    start = settings.get("start_dir") or next((r for r in settings.get("source_roots") or [] if Path(r).is_dir()), "") or str(Path.home())
    proc = subprocess.run(
        [sys.executable, str(TOOLS / "pick_files.py"), mode, start],
        capture_output=True,
        timeout=3600,
    )
    try:
        paths = json.loads(proc.stdout.decode("utf-8") or "[]")
    except ValueError:
        paths = []
    if paths and mode == "files":
        settings["start_dir"] = str(Path(paths[0]).parent)
        save_settings(settings)
    return [str(Path(p)) for p in paths]


class Handler(build.SiteHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT / "_site"), **kwargs)

    # -- plumbing ----------------------------------------------------------
    def _host_ok(self) -> bool:
        return self.headers.get("Host", "") in (f"127.0.0.1:{PORT}", f"localhost:{PORT}")

    def _json(self, data, status: int = 200) -> None:
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _body(self) -> dict:
        length = int(self.headers.get("Content-Length") or 0)
        if not length:
            return {}
        try:
            return json.loads(self.rfile.read(length).decode("utf-8"))
        except ValueError as error:
            raise ApiError(f"요청을 읽지 못했습니다: {error}") from error

    def do_GET(self) -> None:
        if not self._host_ok():
            self.send_error(403)
            return
        path = urllib.parse.urlsplit(self.path).path
        if path.startswith("/__api/"):
            self._api("GET", path)
        elif path in ("/__writer", "/__writer/"):
            self._ui("index.html")
        elif path.startswith("/__writer/"):
            self._ui(path[len("/__writer/"):])
        else:
            super().do_GET()

    def do_HEAD(self) -> None:
        if not self._host_ok():
            self.send_error(403)
            return
        super().do_HEAD()

    def do_POST(self) -> None:
        if not self._host_ok():
            self.send_error(403)
            return
        path = urllib.parse.urlsplit(self.path).path
        if path.startswith("/__api/"):
            self._api("POST", path)
        else:
            self.send_error(405)

    def _ui(self, name: str) -> None:
        target = (UI_DIR / name).resolve()
        if UI_DIR.resolve() not in target.parents or not target.is_file():
            self.send_error(404)
            return
        data = target.read_bytes()
        if target.name == "index.html":
            base = build.load_config(ROOT)["base_path"]
            data = data.replace(b"{{TOKEN}}", TOKEN.encode()).replace(b"{{BASE}}", base.encode())
        types = {".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8"}
        self.send_response(200)
        self.send_header("Content-Type", types.get(target.suffix, "application/octet-stream"))
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _api(self, method: str, path: str) -> None:
        query = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query)
        token = self.headers.get("X-Writer-Token") or (query.get("t") or [""])[0]
        if not secrets.compare_digest(token, TOKEN):
            self._json({"error": "권한이 없습니다"}, 403)
            return
        name = path[len("/__api/"):]
        try:
            if method == "GET":
                result = self._get(name, query)
                if result is None:
                    return
            else:
                result = self._post(name)
            self._json(result)
        except ApiError as error:
            self._json({"error": str(error)}, error.status)
        except Exception as error:  # report instead of dropping the connection
            log(f"오류: {error!r}")
            self._json({"error": f"처리 중 오류가 났습니다: {error}"}, 500)

    def _get(self, name: str, query: dict):
        if name == "ping":
            return {"ok": True}
        if name == "meta":
            return site_meta()
        if name == "git":
            return git_status()
        if name == "inbox":
            with LOCK:
                items, INBOX[:] = list(INBOX), []
            return {"items": items}
        if name == "post":
            return read_post((query.get("slug") or [""])[0])
        if name == "thumb":
            item = ITEMS.get((query.get("id") or [""])[0])
            if not item or item["kind"] != "image":
                raise ApiError("없는 이미지입니다", 404)
            data = Path(item["path"]).read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", self.guess_type(item["name"]))
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return None
        raise ApiError("없는 기능입니다", 404)

    def _post(self, name: str):
        if name == "upload":
            return self._upload()
        data = self._body()
        if name == "pick":
            paths = pick("folder" if data.get("mode") == "folder" else "files")
            if data.get("mode") == "folder":
                return {"paths": paths}
            return {"items": register_many([Path(p) for p in paths])}
        if name == "inspect":
            paths = [Path(str(p).strip().strip('"')) for p in data.get("paths") or [] if str(p).strip()]
            missing = [str(p) for p in paths if not p.exists()]
            return {"items": register_many([p for p in paths if p.exists()]), "missing": missing}
        if name == "resolve":
            item = ITEMS.get(str(data.get("id")))
            folder = Path(str(data.get("folder") or ""))
            if not item or not folder.is_dir():
                raise ApiError("파일이나 폴더를 찾을 수 없습니다")
            fresh = register(Path(item["path"]), base=folder, name=item["name"], staged=item["staged"], origin=str(folder / item["name"]))
            fresh_item = ITEMS[fresh["id"]]
            ITEMS[item["id"]] = {**fresh_item, "id": item["id"]}
            return public_item(ITEMS[item["id"]])
        if name == "inbox":
            items = register_many([Path(p) for p in data.get("paths") or []])
            with LOCK:
                INBOX.extend(items)
            return {"ok": True, "count": len(items)}
        if name == "save":
            result = save_post(data)
            if data.get("publish"):
                result["publish"] = publish(data.get("message") or f"글: {data.get('title', '').strip()}")
            return result
        if name == "post/update":
            return update_post(data)
        if name == "post/delete":
            return delete_post(str(data.get("slug") or ""))
        if name == "rename":
            return rename_everywhere("tag" if data.get("kind") == "tag" else "category", str(data.get("old") or ""), str(data.get("new") or ""))
        if name == "publish":
            return publish(str(data.get("message") or ""))
        if name == "rebuild":
            return rebuild()
        if name == "settings":
            settings = load_settings()
            roots = [str(Path(r)) for r in data.get("source_roots", settings.get("source_roots") or []) if str(r).strip()]
            settings["source_roots"] = roots
            save_settings(settings)
            return settings
        if name == "open":
            target = ROOT if data.get("target") == "repo" else post_source(str(data.get("slug") or ""))[0]
            if hasattr(os, "startfile"):
                os.startfile(str(target))  # noqa: S606 - opens Explorer on the user's own folder
            return {"ok": True}
        if name == "quit":
            threading.Thread(target=lambda: SERVER and SERVER.shutdown(), daemon=True).start()
            return {"ok": True}
        raise ApiError("없는 기능입니다", 404)

    def _upload(self) -> dict:
        length = int(self.headers.get("Content-Length") or 0)
        name = urllib.parse.unquote(self.headers.get("X-File-Name") or "")
        name = Path(name.replace("\\", "/")).name
        if not name:
            raise ApiError("파일 이름이 없습니다")
        if length > MAX_FILE:
            raise ApiError(f"{name}: 100MB가 넘어 올릴 수 없습니다.", 413)
        modified = int(self.headers.get("X-File-Modified") or 0)
        folder = STAGING / uuid.uuid4().hex[:12]
        folder.mkdir(parents=True, exist_ok=True)
        path = folder / name
        remaining = length
        with open(path, "wb") as handle:
            while remaining > 0:
                chunk = self.rfile.read(min(remaining, 1 << 20))
                if not chunk:
                    break
                handle.write(chunk)
                remaining -= len(chunk)
        item = register(path, name=name, staged=True)
        if ITEMS[item["id"]]["kind"] in ("md", "html") and item["missing"]:
            original = locate_original(name, length, modified)
            if original is not None:
                return register(original)
        return item


# --------------------------------------------------------------------------
# main
# --------------------------------------------------------------------------

def _existing_instance() -> dict | None:
    try:
        info = json.loads(INSTANCE_FILE.read_text(encoding="utf-8"))
        request = urllib.request.Request(f"http://127.0.0.1:{info['port']}/__api/ping", headers={"X-Writer-Token": info["token"]})
        with urllib.request.urlopen(request, timeout=1.5) as response:
            if response.status == 200:
                return info
    except Exception:
        return None
    return None


def _free_port(start: int = 4010) -> int:
    for port in range(start, start + 40):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
            try:
                probe.bind(("127.0.0.1", port))
                return port
            except OSError:
                continue
    raise SystemExit("사용할 수 있는 포트를 찾지 못했습니다.")


def main(argv: list[str]) -> int:
    global TOKEN, PORT, SERVER
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except AttributeError:
        pass
    no_browser = "--no-browser" in argv
    paths = [Path(a) for a in argv if a and not a.startswith("--")]

    existing = _existing_instance()
    if existing:
        if paths:
            body = json.dumps({"paths": [str(p) for p in paths]}).encode("utf-8")
            request = urllib.request.Request(
                f"http://127.0.0.1:{existing['port']}/__api/inbox",
                data=body,
                headers={"X-Writer-Token": existing["token"], "Content-Type": "application/json"},
            )
            urllib.request.urlopen(request, timeout=30).read()
        print("이미 실행 중인 글쓰기 도구로 파일을 넘겼습니다.")
        if not no_browser:
            webbrowser.open(f"http://127.0.0.1:{existing['port']}/__writer/")
        return 0

    STATE_DIR.mkdir(exist_ok=True)
    shutil.rmtree(STAGING, ignore_errors=True)
    TOKEN = secrets.token_urlsafe(24)
    PORT = _free_port()
    print("블로그를 준비하는 중...", flush=True)
    result = rebuild()
    INBOX.extend(register_many(paths))
    SERVER = http.server.ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    INSTANCE_FILE.write_text(json.dumps({"port": PORT, "token": TOKEN}), encoding="utf-8")
    url = f"http://127.0.0.1:{PORT}/__writer/"
    print(f"글 {result['posts']}개를 불러왔습니다.")
    print(f"글쓰기 화면: {url}")
    print("이 창을 닫거나 화면의 [종료]를 누르면 끝납니다.", flush=True)
    if not no_browser:
        webbrowser.open(url)
    try:
        SERVER.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        try:
            INSTANCE_FILE.unlink()
        except OSError:
            pass
        shutil.rmtree(STAGING, ignore_errors=True)
    print("글쓰기 도구를 종료했습니다.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
