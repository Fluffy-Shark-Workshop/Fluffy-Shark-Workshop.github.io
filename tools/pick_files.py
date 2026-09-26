"""Native file/folder dialog for the writer (runs in its own process).

    python pick_files.py files|folder [start_dir]

Prints the chosen paths as a JSON list.
"""

import json
import sys
import tkinter as tk
from tkinter import filedialog


def main() -> int:
    mode = sys.argv[1] if len(sys.argv) > 1 else "files"
    start = sys.argv[2] if len(sys.argv) > 2 and sys.argv[2] else None
    root = tk.Tk()
    root.withdraw()
    root.attributes("-topmost", True)
    root.update()
    if mode == "folder":
        chosen = filedialog.askdirectory(parent=root, initialdir=start, title="폴더 선택", mustexist=True)
        paths = [chosen] if chosen else []
    else:
        chosen = filedialog.askopenfilenames(
            parent=root,
            initialdir=start,
            title="블로그에 올릴 파일 선택",
            filetypes=[
                ("블로그 파일", "*.md *.markdown *.html *.htm *.pdf *.png *.jpg *.jpeg *.gif *.webp *.svg"),
                ("모든 파일", "*.*"),
            ],
        )
        paths = list(chosen)
    root.destroy()
    sys.stdout.buffer.write(json.dumps(paths, ensure_ascii=False).encode("utf-8"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
