#!/usr/bin/env python3
"""Build the blog into a static folder.

    python tools/build.py                  # -> _site/
    python tools/build.py --serve          # build, then preview at http://127.0.0.1:4000
    python tools/build.py --drafts         # include posts marked `draft: true`

Posts live in posts/<folder>/index.md (front matter + body) next to their
attachments. A folder without index.md still becomes a post: every file in it
is shown in name order.
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import http.server
import json
import re
import shutil
import sys
import time
import unicodedata
from dataclasses import dataclass, field
from email.utils import format_datetime
from functools import partial
from pathlib import Path
from urllib.parse import quote
from xml.sax.saxutils import escape as xml_escape

import yaml
from jinja2 import Environment, FileSystemLoader, select_autoescape
from pygments.formatters import HtmlFormatter

TOOLS = Path(__file__).resolve().parent
ROOT = TOOLS.parent
sys.path.insert(0, str(TOOLS))

import mdrender  # noqa: E402

KST = dt.timezone(dt.timedelta(hours=9))
SKIP_FILES = {".ds_store", "thumbs.db", "desktop.ini"}
WINDOWS_RESERVED = {"con", "prn", "aux", "nul"} | {f"com{i}" for i in range(10)} | {f"lpt{i}" for i in range(10)}
MATHJAX_URL = "https://cdn.jsdelivr.net/npm/mathjax@3.2.2/es5/tex-mml-chtml.js"

DEFAULT_CONFIG = {
    "title": "Blog",
    "author": "",
    "bio": "",
    "description": "",
    "url": "",
    "base_path": "",
    "avatar": "static/img/avatar.jpg",
    "github": "",
    "default_category": "미분류",
    "category_order": [],
    "sidebar_tag_limit": 0,
    "posts_per_page": 30,
}


# --------------------------------------------------------------------------
# helpers
# --------------------------------------------------------------------------

def load_config(root: Path) -> dict:
    config = dict(DEFAULT_CONFIG)
    path = root / "site.yml"
    if path.exists():
        config.update(yaml.safe_load(path.read_text(encoding="utf-8")) or {})
    config["base_path"] = "/" + str(config.get("base_path") or "").strip("/") if str(config.get("base_path") or "").strip("/") else ""
    config["url"] = str(config.get("url") or "").rstrip("/")
    return config


def url_segment(name: str) -> str:
    """A folder/URL-safe version of a category or tag name (keeps Korean)."""
    text = unicodedata.normalize("NFC", str(name)).strip().casefold()
    text = re.sub(r'[\\/:*?"<>|#%&{}^~\[\]`\'\x00-\x1f]', "", text)
    text = re.sub(r"\s+", "-", text).strip(".-")
    if not text:
        text = "x-" + hashlib.md5(str(name).encode("utf-8")).hexdigest()[:8]
    if text in WINDOWS_RESERVED:
        text += "-"
    return text


def normalize_tags(value) -> list[str]:
    if value is None:
        return []
    if isinstance(value, str):
        items = re.split(r"[,\n]", value) if ("," in value or "\n" in value) else value.split()
    elif isinstance(value, (list, tuple)):
        items = [str(v) for v in value if v is not None]
    else:
        items = [str(value)]
    tags: list[str] = []
    seen: set[str] = set()
    for item in items:
        tag = unicodedata.normalize("NFC", item).strip().lstrip("#").strip()
        if tag and tag.casefold() not in seen:
            seen.add(tag.casefold())
            tags.append(tag)
    return tags


def normalize_category(value) -> str:
    if value is None:
        return ""
    parts = [str(v) for v in value] if isinstance(value, (list, tuple)) else re.split(r"/", str(value))
    parts = [unicodedata.normalize("NFC", p).strip() for p in parts]
    return "/".join(p for p in parts if p)


def parse_date(value, fallback: dt.datetime | None) -> dt.datetime | None:
    moment = None
    if isinstance(value, dt.datetime):
        moment = value
    elif isinstance(value, dt.date):
        moment = dt.datetime(value.year, value.month, value.day)
    elif isinstance(value, str) and value.strip():
        text = value.strip().replace("/", "-")
        text = re.sub(r"^(\d{4})\.(\d{1,2})\.(\d{1,2})", r"\1-\2-\3", text)
        text = re.sub(r"^(\d{4})-(\d)-", r"\1-0\2-", text)
        text = re.sub(r"^(\d{4}-\d{2})-(\d)(\D|$)", r"\1-0\2\3", text)
        try:
            moment = dt.datetime.fromisoformat(text)
        except ValueError:
            moment = None
    if moment is None:
        return fallback
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=KST)
    return moment.astimezone(KST)


def natural_key(name: str):
    return [int(part) if part.isdigit() else part.casefold() for part in re.split(r"(\d+)", name)]


# --------------------------------------------------------------------------
# model
# --------------------------------------------------------------------------

@dataclass
class Post:
    slug: str
    folder: Path
    source: Path | None
    meta: dict
    body: str
    title: str
    date: dt.datetime
    category: str
    tags: list
    description: str = ""
    draft: bool = False
    pinned: bool = False
    url: str = ""
    html: str = ""
    excerpt: str = ""
    flags: set = field(default_factory=set)
    attachments: list = field(default_factory=list)
    missing: list = field(default_factory=list)
    tag_objs: list = field(default_factory=list)
    category_trail: list = field(default_factory=list)
    prev: "Post | None" = None
    next: "Post | None" = None

    @property
    def date_display(self) -> str:
        return self.date.strftime("%Y-%m-%d")

    @property
    def date_iso(self) -> str:
        return self.date.isoformat()


@dataclass
class Category:
    name: str
    path: str
    url: str = ""
    segments: list = field(default_factory=list)
    children: list = field(default_factory=list)
    posts: list = field(default_factory=list)       # includes sub-categories

    @property
    def count(self) -> int:
        return len(self.posts)


@dataclass
class Tag:
    name: str
    key: str
    slug: str
    url: str = ""
    posts: list = field(default_factory=list)

    @property
    def count(self) -> int:
        return len(self.posts)


def auto_body(folder: Path) -> str:
    """Markdown that shows every top-level file of a folder, images stacked."""
    files = sorted(
        (p for p in folder.iterdir() if p.is_file() and not p.name.startswith((".", "~$")) and p.name.lower() not in SKIP_FILES and p.name != "index.md"),
        key=lambda p: natural_key(p.name),
    )
    parts: list[str] = []
    previous_kind = None
    for path in files:
        kind = mdrender.kind_of(path.name)
        if parts:
            # consecutive images share a paragraph -> shown stacked with no gap
            parts.append("\n" if kind == "image" and previous_kind == "image" else "\n\n")
        parts.append(f"![](<{path.name}>)")
        previous_kind = kind
    return "".join(parts) + "\n"


def load_posts(root: Path, config: dict, include_drafts: bool) -> list[Post]:
    posts_dir = root / "posts"
    posts: list[Post] = []
    if not posts_dir.exists():
        return posts
    for entry in sorted(posts_dir.iterdir(), key=lambda p: p.name):
        if entry.name.startswith((".", "_")):
            continue
        if entry.is_dir():
            folder, source, slug = entry, entry / "index.md", entry.name
            if not source.exists():
                source = None
        elif entry.suffix.lower() in mdrender.MD_EXT:
            folder, source, slug = posts_dir, entry, entry.stem
        else:
            continue

        meta: dict = {}
        body = ""
        if source is not None:
            front, body = mdrender.split_front_matter(source.read_text(encoding="utf-8", errors="replace"))
            try:
                meta = (yaml.safe_load(front) or {}) if front else {}
            except yaml.YAMLError as error:
                print(f"  ! {slug}: front matter를 읽을 수 없습니다 ({error})", file=sys.stderr)
                meta = {}
            if not isinstance(meta, dict):
                meta = {}
        if not body.strip() and entry.is_dir():
            body = auto_body(folder)

        slug_date = None
        match = re.match(r"^(\d{4}-\d{2}-\d{2})", slug)
        if match:
            slug_date = parse_date(match.group(1), None)
        mtime = dt.datetime.fromtimestamp((source or entry).stat().st_mtime, KST)
        date = parse_date(meta.get("date"), slug_date or mtime)

        title = str(meta.get("title") or "").strip()
        if not title:
            title = re.sub(r"^\d{4}-\d{2}-\d{2}[-_ ]*", "", slug).replace("-", " ").replace("_", " ").strip() or slug

        category = normalize_category(meta.get("category", meta.get("categories"))) or config["default_category"]
        draft = bool(meta.get("draft", False))
        if draft and not include_drafts:
            continue
        posts.append(
            Post(
                slug=slug,
                folder=folder,
                source=source,
                meta=meta,
                body=body,
                title=title,
                date=date,
                category=category,
                tags=normalize_tags(meta.get("tags")),
                description=str(meta.get("description") or "").strip(),
                draft=draft,
                pinned=bool(meta.get("pin", meta.get("pinned", False))),
            )
        )
    posts.sort(key=lambda p: p.date, reverse=True)
    return posts


# --------------------------------------------------------------------------
# build
# --------------------------------------------------------------------------

class Output:
    def __init__(self, out: Path) -> None:
        self.out = out
        self.written: set[Path] = set()

    def write(self, rel: str, text: str) -> None:
        path = self.out / rel
        self.written.add(path)
        data = text.encode("utf-8")
        if path.exists() and path.stat().st_size == len(data) and path.read_bytes() == data:
            return
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)

    def copy(self, src: Path, rel: str) -> None:
        path = self.out / rel
        self.written.add(path)
        try:
            a, b = src.stat(), path.stat()
            if a.st_size == b.st_size and int(a.st_mtime) == int(b.st_mtime):
                return
        except FileNotFoundError:
            pass
        path.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, path)

    def prune(self) -> None:
        for path in sorted(self.out.rglob("*"), key=lambda p: len(p.parts), reverse=True):
            if path.is_file() and path not in self.written:
                path.unlink()
            elif path.is_dir() and not any(path.iterdir()):
                path.rmdir()


def build(root: Path = ROOT, out: Path | None = None, include_drafts: bool = False, quiet: bool = False) -> dict:
    started = time.time()
    root = root.resolve()
    out = (out or root / "_site").resolve()
    if out == root or out in root.parents:
        raise SystemExit(f"출력 폴더가 저장소 자체를 가리킵니다: {out}")
    out.mkdir(parents=True, exist_ok=True)

    config = load_config(root)
    base = config["base_path"]
    theme = root / "theme"
    output = Output(out)

    # static files (+ a short content hash for cache busting)
    digest = hashlib.sha1()
    static_dir = theme / "static"
    for path in sorted(static_dir.rglob("*")):
        if path.is_file():
            digest.update(path.read_bytes())
            output.copy(path, "static/" + path.relative_to(static_dir).as_posix())
    output.write("static/css/pygments.css", HtmlFormatter(style="default").get_style_defs(".code"))
    version = digest.hexdigest()[:10]

    posts = load_posts(root, config, include_drafts)
    renderer = mdrender.Renderer()

    # taxonomies -----------------------------------------------------------
    categories: dict[str, Category] = {}
    tags: dict[str, Tag] = {}
    used_tag_slugs: set[str] = set()

    def category_node(path: str) -> Category:
        if path in categories:
            return categories[path]
        parts = path.split("/")
        parent = category_node("/".join(parts[:-1])) if len(parts) > 1 else None
        segments = (parent.segments if parent else []) + [url_segment(parts[-1])]
        node = Category(
            name=parts[-1],
            path=path,
            segments=segments,
            url=f"{base}/categories/" + "/".join(quote(s) for s in segments) + "/",
        )
        categories[path] = node
        if parent:
            parent.children.append(node)
        return node

    for post in posts:
        post.url = f"{base}/posts/{quote(post.slug)}/"
        parts = post.category.split("/")
        trail = []
        for depth in range(1, len(parts) + 1):
            node = category_node("/".join(parts[:depth]))
            node.posts.append(post)
            trail.append(node)
        post.category_trail = trail
        for name in post.tags:
            key = name.casefold()
            if key not in tags:
                slug = url_segment(name)
                while slug in used_tag_slugs:
                    slug += "-"
                used_tag_slugs.add(slug)
                tags[key] = Tag(name=name, key=key, slug=slug, url=f"{base}/tags/{quote(slug)}/")
            tags[key].posts.append(post)
            post.tag_objs.append(tags[key])

    order = {name: i for i, name in enumerate(config.get("category_order") or [])}

    def sort_nodes(nodes: list[Category]) -> list[Category]:
        nodes.sort(key=lambda n: (order.get(n.path, order.get(n.name, len(order))), natural_key(n.name)))
        for n in nodes:
            sort_nodes(n.children)
        return nodes

    root_categories = sort_nodes([c for c in categories.values() if "/" not in c.path])
    tags_by_count = sorted(tags.values(), key=lambda t: (-t.count, t.name.casefold()))
    tags_by_name = sorted(tags.values(), key=lambda t: natural_key(t.name))

    # render posts ----------------------------------------------------------
    warnings: list[str] = []
    chronological = sorted(posts, key=lambda p: p.date)
    for index, post in enumerate(chronological):
        post.prev = chronological[index - 1] if index > 0 else None
        post.next = chronological[index + 1] if index + 1 < len(chronological) else None
        ctx = mdrender.DocContext(post_dir=post.folder, url_base=post.url, title=post.title)
        try:
            post.html = renderer.render(post.body, ctx)
        except Exception as error:  # keep the rest of the site building
            post.html = f'<p class="build-error">이 글을 변환하지 못했습니다: {error}</p>'
            warnings.append(f"{post.slug}: {error}")
        post.flags = set(ctx.flags)
        post.missing = list(dict.fromkeys(ctx.missing))
        for rel in post.missing:
            warnings.append(f"{post.slug}: 없는 파일을 참조합니다 → {rel}")
        post.excerpt = post.description or mdrender.excerpt_from_html(post.html)

        if post.folder == root / "posts":
            # single-file post: publish only what it references
            files = [(rel, post.folder / rel) for rel in dict.fromkeys(ctx.embedded)]
        else:
            files = [
                (path.relative_to(post.folder).as_posix(), path)
                for path in sorted(post.folder.rglob("*"))
                if path.is_file()
                and not any(part.startswith(".") for part in path.relative_to(post.folder).parts)
                and path.name.lower() not in SKIP_FILES
                and not path.name.startswith("~$")
            ]
        for rel, path in files:
            if rel == "index.md" or not path.is_file():
                continue
            output.copy(path, f"posts/{post.slug}/{rel}")
            if "/" not in rel and mdrender.kind_of(rel) != "image":
                post.attachments.append({
                    "name": rel,
                    "url": post.url + quote(rel),
                    "size": mdrender.human_size(path.stat().st_size),
                    "kind": mdrender.kind_of(rel),
                })

    # templates -------------------------------------------------------------
    env = Environment(
        loader=FileSystemLoader(str(theme / "templates")),
        autoescape=select_autoescape(["html", "xml"]),
        trim_blocks=True,
        lstrip_blocks=True,
    )
    site = dict(config)
    site["avatar_url"] = f"{base}/{str(config['avatar']).lstrip('/')}"
    tag_limit = int(config.get("sidebar_tag_limit") or 0)
    common = {
        "site": site,
        "base": base,
        "v": version,
        "mathjax_url": MATHJAX_URL,
        "total": len(posts),
        "nav_categories": root_categories,
        "nav_tags": tags_by_count[:tag_limit] if tag_limit else tags_by_count,
        "more_tags": max(0, len(tags_by_count) - tag_limit) if tag_limit else 0,
    }

    def render(template: str, rel: str, **context) -> None:
        output.write(rel, env.get_template(template).render(**common, **context))

    def list_flags(items: list[Post]) -> set:
        return {"math"} if any(re.search(r"\$|\\\(", p.title) for p in items) else set()

    for post in posts:
        render(
            "post.html",
            f"posts/{post.slug}/index.html",
            post=post,
            flags=post.flags | list_flags([post]),
            page_title=post.title,
            page_description=post.excerpt,
            active_category=post.category,
        )

    per_page = max(1, int(config.get("posts_per_page") or 30))
    ordered = sorted(posts, key=lambda p: (not p.pinned, -p.date.timestamp()))
    pages = [ordered[i:i + per_page] for i in range(0, len(ordered), per_page)] or [[]]
    for number, chunk in enumerate(pages, start=1):
        render(
            "home.html",
            "index.html" if number == 1 else f"page/{number}/index.html",
            posts=chunk,
            flags=list_flags(chunk),
            page_title="" if number == 1 else f"{number}쪽",
            active_home=True,
            page_number=number,
            page_count=len(pages),
            page_url=lambda n: f"{base}/" if n == 1 else f"{base}/page/{n}/",
        )

    for node in categories.values():
        parts = node.path.split("/")
        render(
            "list.html",
            "categories/" + "/".join(node.segments) + "/index.html",
            posts=node.posts,
            flags=list_flags(node.posts),
            page_title=node.path.replace("/", " › "),
            heading=node.path.replace("/", " › "),
            kind="category",
            node=node,
            trail=[categories["/".join(parts[:i])] for i in range(1, len(parts) + 1)],
            active_category=node.path,
        )
    render("categories.html", "categories/index.html", flags=set(), page_title="카테고리", all_categories=root_categories)

    for tag in tags.values():
        render(
            "list.html",
            f"tags/{tag.slug}/index.html",
            posts=tag.posts,
            flags=list_flags(tag.posts),
            page_title=f"#{tag.name}",
            heading=f"#{tag.name}",
            kind="tag",
            active_tag=tag.key,
        )
    render("tags.html", "tags/index.html", flags=set(), page_title="태그", tags_by_name=tags_by_name, tags_by_count=tags_by_count)
    render("404.html", "404.html", flags=set(), page_title="페이지를 찾을 수 없습니다")

    # machine-readable files -------------------------------------------------
    search = {
        "posts": [
            {"t": p.title, "u": p.url, "d": p.date_display, "c": p.category, "g": p.tags}
            for p in posts
        ],
        "tags": [{"n": t.name, "u": t.url, "k": t.count} for t in tags_by_count],
        "categories": [{"n": c.path, "u": c.url, "k": c.count} for c in categories.values()],
    }
    output.write("search.json", json.dumps(search, ensure_ascii=False, separators=(",", ":")))

    site_url = config["url"]
    items = []
    for post in posts[:30]:
        link = site_url + post.url
        items.append(
            "<item>"
            f"<title>{xml_escape(post.title)}</title><link>{xml_escape(link)}</link>"
            f'<guid isPermaLink="true">{xml_escape(link)}</guid>'
            f"<pubDate>{format_datetime(post.date)}</pubDate>"
            f"<category>{xml_escape(post.category)}</category>"
            f"<description>{xml_escape(post.excerpt)}</description>"
            "</item>"
        )
    output.write(
        "feed.xml",
        '<?xml version="1.0" encoding="utf-8"?>\n<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom"><channel>'
        f"<title>{xml_escape(config['title'])}</title><link>{xml_escape(site_url + base + '/')}</link>"
        f"<description>{xml_escape(config.get('description') or config.get('bio') or '')}</description><language>ko</language>"
        f'<atom:link href="{xml_escape(site_url + base + "/feed.xml")}" rel="self" type="application/rss+xml"/>'
        + "".join(items)
        + "</channel></rss>\n",
    )
    urls = [f"{site_url}{base}/"] + [site_url + p.url for p in posts] + [site_url + c.url for c in categories.values()] + [site_url + t.url for t in tags.values()]
    output.write(
        "sitemap.xml",
        '<?xml version="1.0" encoding="utf-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'
        + "".join(f"<url><loc>{xml_escape(u)}</loc></url>" for u in urls)
        + "</urlset>\n",
    )
    output.write("robots.txt", f"User-agent: *\nAllow: /\nSitemap: {site_url}{base}/sitemap.xml\n")
    output.write(".nojekyll", "")
    output.prune()

    result = {
        "posts": len(posts),
        "categories": len(categories),
        "tags": len(tags),
        "warnings": warnings,
        "seconds": round(time.time() - started, 2),
        "out": str(out),
    }
    if not quiet:
        print(f"완료: 글 {result['posts']}개, 카테고리 {result['categories']}개, 태그 {result['tags']}개 ({result['seconds']}초) → {out}")
        for warning in warnings:
            print("  ! " + warning)
    return result


# --------------------------------------------------------------------------
# preview server
# --------------------------------------------------------------------------

class SiteHandler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".mjs": "text/javascript",
        ".md": "text/markdown; charset=utf-8",
        ".json": "application/json",
    }

    def log_message(self, *args) -> None:  # keep the console quiet
        pass

    def send_error(self, code, message=None, explain=None):
        if code == 404:
            page = Path(self.directory) / "404.html"
            if page.exists():
                body = page.read_bytes()
                self.send_response(404)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
        super().send_error(code, message, explain)

    def end_headers(self) -> None:
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


def main() -> int:
    parser = argparse.ArgumentParser(description="블로그를 정적 사이트로 만듭니다.")
    parser.add_argument("--out", type=Path, default=ROOT / "_site")
    parser.add_argument("--drafts", action="store_true", help="draft: true 인 글도 포함")
    parser.add_argument("--serve", action="store_true", help="빌드 후 로컬 미리보기 서버 실행")
    parser.add_argument("--port", type=int, default=4000)
    args = parser.parse_args()
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except AttributeError:
        pass
    result = build(ROOT, args.out, include_drafts=args.drafts)
    if args.serve:
        handler = partial(SiteHandler, directory=result["out"])
        server = http.server.ThreadingHTTPServer(("127.0.0.1", args.port), handler)
        print(f"미리보기: http://127.0.0.1:{args.port}/  (끝내려면 Ctrl+C)")
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
