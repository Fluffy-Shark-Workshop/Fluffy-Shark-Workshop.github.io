"""Markdown -> HTML for the blog.

Math follows the same contract as md2html_report_v2_2.py: every TeX span is cut
out of the source *before* Markdown runs and put back verbatim afterwards, so
emphasis (`_`), backslash escapes (`\\`, `\\{`) and table pipes never touch it and
MathJax receives exactly what was written.

Attachments are embedded with image syntax:
    ![](note.png)      image           (consecutive lines = stacked with no gap)
    ![](lecture.pdf)   every PDF page  (rendered by pdf.js in the browser)
    ![](report.html)   full HTML page  (auto-height iframe)
    ![](notes.md)      another Markdown file rendered in place
    ![](data.zip)      download card for any other file type
"""

from __future__ import annotations

import html
import posixpath
import re
import struct
import unicodedata
import urllib.parse
from dataclasses import dataclass, field
from pathlib import Path

from markdown_it import MarkdownIt
from mdit_py_plugins.attrs import attrs_plugin
from mdit_py_plugins.deflist import deflist_plugin
from mdit_py_plugins.footnote import footnote_plugin
from mdit_py_plugins.tasklists import tasklists_plugin
from pygments import highlight as pygments_highlight
from pygments.formatters import HtmlFormatter
from pygments.lexers import get_lexer_by_name
from pygments.util import ClassNotFound

IMAGE_EXT = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp", ".avif", ".ico"}
PDF_EXT = {".pdf"}
HTML_EXT = {".html", ".htm"}
MD_EXT = {".md", ".markdown"}
VIDEO_EXT = {".mp4", ".webm", ".mov", ".m4v", ".ogv"}
AUDIO_EXT = {".mp3", ".m4a", ".wav", ".ogg", ".oga", ".flac"}

MAX_EMBED_DEPTH = 4


def kind_of(name: str) -> str:
    ext = Path(name).suffix.lower()
    if ext in IMAGE_EXT:
        return "image"
    if ext in PDF_EXT:
        return "pdf"
    if ext in HTML_EXT:
        return "html"
    if ext in MD_EXT:
        return "md"
    if ext in VIDEO_EXT:
        return "video"
    if ext in AUDIO_EXT:
        return "audio"
    return "file"


def human_size(size: int) -> str:
    value = float(size)
    for unit in ("B", "KB", "MB", "GB"):
        if value < 1024 or unit == "GB":
            return f"{value:.0f} {unit}" if unit == "B" else f"{value:.1f} {unit}"
        value /= 1024
    return f"{size} B"


def slugify(text: str, fallback: str = "section") -> str:
    text = unicodedata.normalize("NFC", text).strip().casefold()
    text = re.sub(r"[^\w\s+-]", "", text)
    text = re.sub(r"[\s_]+", "-", text).strip("-")
    return text or fallback


def split_front_matter(text: str) -> tuple[str, str]:
    """Return (yaml_text, body). yaml_text is '' when there is no front matter."""
    text = text.lstrip("﻿")
    match = re.match(r"^---[ \t]*\r?\n(.*?)\r?\n---[ \t]*(?:\r?\n|$)", text, re.S)
    if not match:
        return "", text
    return match.group(1), text[match.end():]


# --------------------------------------------------------------------------
# Math protection
# --------------------------------------------------------------------------

_TOKEN_RE = re.compile(r"QQMX([IDE])(\d{5})QQ")
_PARA_DISPLAY_RE = re.compile(r"<p>\s*QQMXD(\d{5})QQ\s*</p>")
_PREFIX_RE = re.compile(r"^([ \t]*(?:>[ \t]?)*[ \t]*)(.*)$")
_FENCE_RE = re.compile(r"^([ \t]*(?:>[ \t]?)*[ \t]*)(`{3,}|~{3,})(.*)$")
_BEGIN_RE = re.compile(
    r"^\\begin\{(equation|align|alignat|gather|multline|flalign|eqnarray|split|aligned|gathered|cases|matrix|pmatrix|bmatrix)(\*?)\}"
)


class MathStore:
    def __init__(self) -> None:
        self.items: list[tuple[str, str]] = []

    def add(self, kind: str, raw: str) -> str:
        self.items.append((kind, raw))
        return f"QQMX{kind}{len(self.items) - 1:05d}QQ"

    def raw(self, index: int) -> str:
        return self.items[index][1]


def _strip_prefix(line: str, prefix: str) -> str:
    if prefix and line.startswith(prefix):
        return line[len(prefix):]
    if ">" in prefix:
        match = re.match(r"^[ \t]*(?:>[ \t]?){%d}" % prefix.count(">"), line)
        if match:
            return line[match.end():]
    return line.lstrip(" \t")


def _find_block_end(lines: list[str], start: int, prefix: str, closer: str) -> int:
    for index in range(start, len(lines)):
        if _strip_prefix(lines[index], prefix).rstrip().endswith(closer):
            return index
    return -1


def _split_code_spans(line: str) -> list[tuple[bool, str]]:
    """Split one line into (is_code_span, text) pieces."""
    pieces: list[tuple[bool, str]] = []
    buf: list[str] = []
    i = 0
    n = len(line)
    while i < n:
        if line[i] != "`":
            buf.append(line[i])
            i += 1
            continue
        j = i
        while j < n and line[j] == "`":
            j += 1
        run = j - i
        k = j
        close = -1
        while k < n:
            if line[k] == "`":
                m = k
                while m < n and line[m] == "`":
                    m += 1
                if m - k == run:
                    close = m
                    break
                k = m
            else:
                k += 1
        if close == -1:
            buf.append(line[i:j])
            i = j
            continue
        if buf:
            pieces.append((False, "".join(buf)))
            buf = []
        pieces.append((True, line[i:close]))
        i = close
    if buf:
        pieces.append((False, "".join(buf)))
    return pieces


def _protect_line(line: str, store: MathStore) -> str:
    return "".join(
        text if is_code else _protect_inline(_fix_links(text), store)
        for is_code, text in _split_code_spans(line)
    )


def _protect_inline(line: str, store: MathStore) -> str:
    """Replace inline TeX in a code-free piece of one source line with tokens."""
    out: list[str] = []
    i = 0
    n = len(line)
    while i < n:
        c = line[i]
        if c == "\\" and i + 1 < n:
            nxt = line[i + 1]
            if nxt == "$":
                out.append(store.add("E", "\\$"))
                i += 2
                continue
            if nxt == "(":
                k = line.find("\\)", i + 2)
                if k != -1:
                    out.append(store.add("I", line[i:k + 2]))
                    i = k + 2
                    continue
            if nxt == "[":
                k = line.find("\\]", i + 2)
                if k != -1:
                    out.append(store.add("D", line[i:k + 2]))
                    i = k + 2
                    continue
            out.append(line[i:i + 2])
            i += 2
            continue
        if c == "$":
            if line.startswith("$$", i):
                k = line.find("$$", i + 2)
                if k > i + 2:
                    out.append(store.add("D", line[i:k + 2]))
                    i = k + 2
                    continue
                out.append("$$")
                i += 2
                continue
            # Same rule as md2html_report_v2_2.py:
            # (?<!\\)\$(?!\$)([^\n$]+?)(?<!\\)\$(?!\$)
            k = line.find("$", i + 1)
            if k > i + 1 and line[k - 1] != "\\" and not line.startswith("$$", k):
                out.append(store.add("I", line[i:k + 1]))
                i = k + 1
                continue
            out.append("$")
            i += 1
            continue
        out.append(c)
        i += 1
    return "".join(out)


_OBSIDIAN_EMBED_RE = re.compile(r"!\[\[([^\]|\n]+?)(?:\|([^\]\n]*))?\]\]")
_SPACED_DEST_RE = re.compile(r"(!?\[[^\]\n]*\])\((?!<)([^()<>\"'\n]*\s[^()<>\"'\n]*?\.[A-Za-z0-9]{1,5})\)")


def _fix_links(line: str) -> str:
    """Accept `![[file.png|300]]` (Obsidian) and paths with spaces (Typora)."""

    def obsidian(match: re.Match[str]) -> str:
        target = match.group(1).strip()
        option = (match.group(2) or "").strip()
        attrs = ""
        if re.fullmatch(r"\d+(x\d+)?", option):
            attrs = "{width=%s}" % option.split("x")[0]
        return f"![](<{target}>){attrs}"

    line = _OBSIDIAN_EMBED_RE.sub(obsidian, line)
    return _SPACED_DEST_RE.sub(lambda m: f"{m.group(1)}(<{m.group(2).strip()}>)", line)


def protect_math(text: str, store: MathStore) -> str:
    lines = text.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    out: list[str] = []
    fence: tuple[str, int] | None = None
    index = 0
    while index < len(lines):
        line = lines[index]

        if fence is not None:
            out.append(line)
            char, length = fence
            if re.match(r"^[ \t>]*" + re.escape(char) + "{%d,}[ \t]*$" % length, line):
                fence = None
            index += 1
            continue

        match = _FENCE_RE.match(line)
        if match and not (match.group(2)[0] == "`" and "`" in match.group(3)):
            fence = (match.group(2)[0], len(match.group(2)))
            out.append(line)
            index += 1
            continue

        prefix, rest = _PREFIX_RE.match(line).groups()
        stripped = rest.strip()

        # $$ ... $$ blocks (the guide's canonical form), \[ ... \], \begin{env} ... \end{env}
        block_end = -1
        opener = ""
        if stripped.startswith("$$"):
            inner = stripped[2:]
            if inner.endswith("$$") and len(stripped) > 4 and "$$" not in inner[:-2]:
                block_end, opener = index, "$$"
            elif "$$" not in inner:
                block_end, opener = _find_block_end(lines, index + 1, prefix, "$$"), "$$"
        elif stripped.startswith("\\["):
            inner = stripped[2:]
            if inner.endswith("\\]") and "\\]" not in inner[:-2]:
                block_end, opener = index, "\\["
            elif "\\]" not in inner:
                block_end, opener = _find_block_end(lines, index + 1, prefix, "\\]"), "\\["
        else:
            env = _BEGIN_RE.match(stripped)
            if env and (not out or not out[-1].strip() or _PREFIX_RE.match(out[-1]).group(2).strip() == ""):
                closer = "\\end{%s%s}" % (env.group(1), env.group(2))
                if stripped.endswith(closer):
                    block_end, opener = index, "env"
                else:
                    block_end, opener = _find_block_end(lines, index + 1, prefix, closer), "env"

        if block_end != -1:
            body = [rest] + [_strip_prefix(lines[j], prefix) for j in range(index + 1, block_end + 1)]
            raw = "\n".join(part.rstrip() for part in body).strip()
            out.append(prefix + store.add("D", raw))
            index = block_end + 1
            continue

        out.append(_protect_line(line, store))
        index += 1
    return "\n".join(out)


def restore_math(rendered: str, store: MathStore) -> str:
    rendered = _PARA_DISPLAY_RE.sub(
        lambda m: '<div class="math-block">' + html.escape(store.raw(int(m.group(1)))) + "</div>",
        rendered,
    )
    return _TOKEN_RE.sub(lambda m: html.escape(store.raw(int(m.group(2)))), rendered)


def _plain_math(text: str, store: MathStore) -> str:
    def repl(match: re.Match[str]) -> str:
        kind, raw = store.items[int(match.group(2))]
        if kind == "E":
            return "$"
        return re.sub(r"^(\$\$|\$|\\\(|\\\[)|(\$\$|\$|\\\)|\\\])$", "", raw.strip()).strip()

    return _TOKEN_RE.sub(repl, text)


# --------------------------------------------------------------------------
# Image size sniffing (lets the browser reserve space before lazy images load)
# --------------------------------------------------------------------------

def image_size(path: Path) -> tuple[int, int] | None:
    try:
        with open(path, "rb") as handle:
            head = handle.read(32)
            if head.startswith(b"\x89PNG\r\n\x1a\n") and head[12:16] == b"IHDR":
                return struct.unpack(">II", head[16:24])
            if head[:6] in (b"GIF87a", b"GIF89a"):
                return struct.unpack("<HH", head[6:10])
            if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
                chunk = head[12:16]
                if chunk == b"VP8X":
                    handle.seek(24)
                    data = handle.read(6)
                    return (int.from_bytes(data[0:3], "little") + 1, int.from_bytes(data[3:6], "little") + 1)
                if chunk == b"VP8 ":
                    handle.seek(26)
                    w, h = struct.unpack("<HH", handle.read(4))
                    return (w & 0x3FFF, h & 0x3FFF)
                if chunk == b"VP8L":
                    handle.seek(21)
                    b = handle.read(4)
                    w = 1 + (((b[1] & 0x3F) << 8) | b[0])
                    h = 1 + (((b[3] & 0xF) << 10) | (b[2] << 2) | ((b[1] & 0xC0) >> 6))
                    return (w, h)
            if head[:2] == b"\xff\xd8":
                handle.seek(2)
                while True:
                    marker = handle.read(2)
                    if len(marker) < 2 or marker[0] != 0xFF:
                        return None
                    code = marker[1]
                    if code in (0xD8, 0x01) or 0xD0 <= code <= 0xD7:
                        continue
                    length = struct.unpack(">H", handle.read(2))[0]
                    if 0xC0 <= code <= 0xCF and code not in (0xC4, 0xC8, 0xCC):
                        data = handle.read(5)
                        h, w = struct.unpack(">HH", data[1:5])
                        return (w, h)
                    handle.seek(length - 2, 1)
    except (OSError, struct.error):
        return None
    return None


# --------------------------------------------------------------------------
# Rendering context
# --------------------------------------------------------------------------

@dataclass
class DocContext:
    post_dir: Path              # folder that holds the post and its attachments
    url_base: str               # public URL of that folder, ends with '/'
    rel_dir: str = ""           # this document's folder relative to post_dir (posix)
    title: str = ""
    depth: int = 0
    flags: set = field(default_factory=set)
    embedded: list = field(default_factory=list)   # rel paths embedded in the page
    missing: list = field(default_factory=list)    # references that do not exist
    heading_ids: dict = field(default_factory=dict)

    def child(self, rel_dir: str) -> "DocContext":
        return DocContext(
            post_dir=self.post_dir,
            url_base=self.url_base,
            rel_dir=rel_dir,
            title=self.title,
            depth=self.depth + 1,
            flags=self.flags,
            embedded=self.embedded,
            missing=self.missing,
            heading_ids=self.heading_ids,
        )

    def resolve(self, src: str) -> tuple[str, Path, str] | None:
        """Map a relative reference to (rel_path, file_path, public_url)."""
        if not src or src.startswith(("/", "#", "//")) or re.match(r"^[A-Za-z][A-Za-z0-9+.-]*:", src):
            return None
        path_part = re.split(r"[?#]", src, maxsplit=1)[0]
        # A file name may itself contain '#' or '?': prefer the whole string when such a file exists.
        options = [(src, "")] if path_part == src else [(src, ""), (path_part, src[len(path_part):])]
        for index, (part, suffix) in enumerate(options):
            rel = posixpath.normpath(posixpath.join(self.rel_dir, urllib.parse.unquote(part).replace("\\", "/")))
            if rel in (".", "..") or rel.startswith("../"):
                continue
            if index == len(options) - 1 or (self.post_dir / rel).is_file():
                url = self.url_base + urllib.parse.quote(rel, safe="/") + suffix
                return rel, self.post_dir / rel, url
        return None


# --------------------------------------------------------------------------
# markdown-it setup
# --------------------------------------------------------------------------

_FORMATTER = HtmlFormatter(nowrap=True)


def _highlight(code: str, lang: str, _attrs: str) -> str:
    if not lang:
        return ""
    try:
        lexer = get_lexer_by_name(lang)
    except ClassNotFound:
        return ""
    body = pygments_highlight(code, lexer, _FORMATTER)
    return f'<pre class="code"><code class="language-{html.escape(lang)}">{body}</code></pre>'


def _attr_str(attrs: dict) -> str:
    return "".join(f' {k}="{html.escape(str(v))}"' for k, v in attrs.items() if v is not None)


def _embed_bar(badge: str, name: str, url: str, extra: str = "") -> str:
    safe_name = html.escape(name)
    safe_url = html.escape(url)
    return (
        '<div class="embed-bar">'
        f'<span class="embed-badge">{badge}</span>'
        f'<a class="embed-name" href="{safe_url}" target="_blank" rel="noopener" title="{safe_name}">{safe_name}</a>'
        f"{extra}"
        '<span class="embed-actions">'
        f'<a href="{safe_url}" target="_blank" rel="noopener">새 탭에서 열기</a>'
        f'<a href="{safe_url}" download>다운로드</a>'
        "</span></div>"
    )


def _rule(method):
    """Adapt a bound method to markdown-it's rule(renderer, tokens, idx, options, env)."""

    def rule(renderer, tokens, idx, options, env):
        return method(renderer, tokens, idx, options, env)

    return rule


class Renderer:
    def __init__(self) -> None:
        md = MarkdownIt("commonmark", {"html": True, "linkify": False, "typographer": False})
        md.enable(["table", "strikethrough"])
        md.use(footnote_plugin).use(tasklists_plugin).use(deflist_plugin).use(attrs_plugin)
        md.options["highlight"] = _highlight
        self._default_fence = md.renderer.rules["fence"]
        md.add_render_rule("image", _rule(self._render_image))
        md.add_render_rule("table_open", lambda r, t, i, o, e: '<div class="table-wrap"><table>\n')
        md.add_render_rule("table_close", lambda r, t, i, o, e: "</table></div>\n")
        md.add_render_rule("link_open", _rule(self._render_link_open))
        md.add_render_rule("html_block", _rule(self._render_html))
        md.add_render_rule("html_inline", _rule(self._render_html))
        md.add_render_rule("fence", _rule(self._render_fence))
        self.md = md

    # ---- public API -------------------------------------------------------

    def render(self, text: str, ctx: DocContext) -> str:
        store = MathStore()
        source = protect_math(text, store)
        env = {"ctx": ctx, "store": store}
        tokens = self.md.parse(source, env)
        self._post_process(tokens, ctx, store)
        rendered = self.md.renderer.render(tokens, self.md.options, env)
        if store.items:
            ctx.flags.add("math")
        return restore_math(rendered, store)

    def render_file(self, path: Path, ctx: DocContext, strip_title: str = "") -> str:
        text = path.read_text(encoding="utf-8", errors="replace")
        _, body = split_front_matter(text)
        if strip_title:
            match = re.match(r"^\s*#[ \t]+(.+?)[ \t#]*\n", body)
            if match and _norm(match.group(1)) == _norm(strip_title):
                body = body[match.end():]
        return self.render(body, ctx)

    # ---- token pass ------------------------------------------------------

    def _post_process(self, tokens, ctx: DocContext, store: MathStore) -> None:
        for index, token in enumerate(tokens):
            if token.type == "paragraph_open" and index + 2 < len(tokens):
                inline = tokens[index + 1]
                if inline.type == "inline" and self._is_media_only(inline.children or []):
                    token.tag = tokens[index + 2].tag = "div"
                    token.attrSet("class", "media")
                    for child in inline.children:
                        if child.type == "image":
                            child.meta["block"] = True
            elif token.type == "heading_open" and index + 1 < len(tokens):
                inline = tokens[index + 1]
                text = "".join(
                    child.content for child in (inline.children or []) if child.type in ("text", "code_inline")
                )
                base = slugify(_plain_math(text, store))
                slug = base
                number = 1
                while slug in ctx.heading_ids:
                    number += 1
                    slug = f"{base}-{number}"
                ctx.heading_ids[slug] = True
                token.attrSet("id", slug)

    @staticmethod
    def _is_media_only(children) -> bool:
        has_media = False
        for child in children:
            if child.type == "image":
                has_media = True
            elif child.type in ("softbreak", "hardbreak", "link_open", "link_close"):
                continue
            elif child.type == "text" and not child.content.strip():
                continue
            else:
                return False
        return has_media

    # ---- render rules ----------------------------------------------------

    def _render_fence(self, renderer, tokens, idx, options, env):
        token = tokens[idx]
        info = token.info.strip().split(maxsplit=1)[0].lower() if token.info.strip() else ""
        if info == "math":
            env["ctx"].flags.add("math")
            return '<div class="math-block">' + html.escape("\\[" + token.content.strip() + "\\]") + "</div>\n"
        if info:
            env["ctx"].flags.add("code")
        return self._default_fence(tokens, idx, options, env)

    def _render_link_open(self, renderer, tokens, idx, options, env):
        token = tokens[idx]
        href = token.attrGet("href") or ""
        ctx: DocContext = env["ctx"]
        resolved = ctx.resolve(href)
        if resolved:
            token.attrSet("href", resolved[2])
        elif re.match(r"^https?://", href):
            token.attrSet("target", "_blank")
            token.attrSet("rel", "noopener")
        return renderer.renderToken(tokens, idx, options, env)

    def _render_html(self, renderer, tokens, idx, options, env):
        content = tokens[idx].content
        ctx: DocContext = env["ctx"]

        def fix(match: re.Match[str]) -> str:
            resolved = ctx.resolve(match.group(3))
            if not resolved:
                return match.group(0)
            return f"{match.group(1)}={match.group(2)}{resolved[2]}{match.group(2)}"

        return re.sub(r"""\b(src|href|poster)=(["'])(.*?)\2""", fix, content)

    def _render_image(self, renderer, tokens, idx, options, env):
        token = tokens[idx]
        ctx: DocContext = env["ctx"]
        store: MathStore = env["store"]
        src = token.attrGet("src") or ""
        alt = renderer.renderInlineAsText(token.children or [], options, env)
        block = bool(token.meta.get("block"))
        extra = {k: v for k, v in token.attrs.items() if k not in ("src", "alt")}

        resolved = ctx.resolve(src)
        if resolved is None:
            # external or absolute: plain image
            ctx.flags.add("image")
            return f'<img src="{html.escape(src)}" alt="{html.escape(alt)}" loading="lazy"{_attr_str(extra)}>'

        rel, path, url = resolved
        name = posixpath.basename(rel)
        kind = kind_of(name)
        exists = path.is_file()
        if not exists:
            ctx.missing.append(rel)
            return (
                f'<span class="missing-file" title="파일을 찾을 수 없습니다">'
                f"⚠ {html.escape(rel)} (파일 없음)</span>"
            )
        ctx.embedded.append(rel)

        if kind == "image":
            ctx.flags.add("image")
            attrs = {"src": url, "alt": alt, "loading": "lazy", "decoding": "async"}
            size = image_size(path)
            if size and "width" not in extra and "height" not in extra:
                attrs["width"], attrs["height"] = size
            attrs.update(extra)
            return f"<img{_attr_str(attrs)}>"

        if not block:
            # A document embed in the middle of a sentence becomes a link.
            return f'<a class="file-link" href="{html.escape(url)}">{html.escape(alt or name)}</a>'

        if kind == "pdf":
            ctx.flags.add("pdf")
            return (
                f'<div class="embed embed-pdf" data-src="{html.escape(url)}">'
                + _embed_bar("PDF", name, url, '<span class="embed-meta" data-pages></span>')
                + '<div class="pdf-pages"><div class="embed-loading">PDF 불러오는 중…</div></div>'
                + f'<noscript><p><a href="{html.escape(url)}">{html.escape(name)} 열기</a></p></noscript>'
                + "</div>"
            )
        if kind == "html":
            ctx.flags.add("html")
            return (
                '<div class="embed embed-html">'
                + _embed_bar("HTML", name, url)
                + f'<iframe class="html-frame" src="{html.escape(url)}" title="{html.escape(name)}" '
                + 'loading="lazy" scrolling="no" data-autoheight></iframe>'
                + "</div>"
            )
        if kind == "md":
            if ctx.depth >= MAX_EMBED_DEPTH:
                return f'<a class="file-link" href="{html.escape(url)}">{html.escape(name)}</a>'
            child = ctx.child(posixpath.dirname(rel))
            inner = self.render_file(path, child, strip_title=ctx.title)
            return f'<div class="embed-md" data-source="{html.escape(rel)}">\n{inner}\n</div>'
        if kind == "video":
            return f'<video class="embed-video" src="{html.escape(url)}" controls preload="metadata"></video>'
        if kind == "audio":
            return f'<audio class="embed-audio" src="{html.escape(url)}" controls preload="metadata"></audio>'

        size_text = human_size(path.stat().st_size)
        ext = (path.suffix[1:] or "file").upper()
        return (
            f'<a class="file-card" href="{html.escape(url)}" download>'
            f'<span class="file-ext">{html.escape(ext[:5])}</span>'
            f'<span class="file-name">{html.escape(alt or name)}</span>'
            f'<span class="file-size">{size_text}</span></a>'
        )


def _norm(text: str) -> str:
    return re.sub(r"\s+", " ", unicodedata.normalize("NFC", text)).strip().casefold()


_TAG_RE = re.compile(r"<[^>]+>")


def excerpt_from_html(rendered: str, limit: int = 160) -> str:
    text = re.sub(r"<(script|style|pre)\b.*?</\1>", " ", rendered, flags=re.S)
    text = re.sub(r'<div class="math-block">.*?</div>', " ", text, flags=re.S)
    text = re.sub(r'<div class="embed-bar">.*?</div>', " ", text, flags=re.S)
    text = re.sub(r"<(h1)\b.*?</\1>", " ", text, flags=re.S, count=1)
    text = html.unescape(_TAG_RE.sub(" ", text))
    text = re.sub(r"\$\$.*?\$\$", " ", text, flags=re.S)
    text = re.sub(r"\\\[.*?\\\]", " ", text, flags=re.S)
    text = re.sub(r"\$([^$\n]+)\$", r"\1", text)
    text = re.sub(r"\\\((.+?)\\\)", r"\1", text)
    text = re.sub(r"\s+", " ", text).strip()
    if len(text) > limit:
        text = text[:limit].rstrip() + "…"
    return text
