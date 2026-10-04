#!/usr/bin/env python3
"""Preserve deliberate extra Markdown blank lines as LaTeX vertical space.

Pandoc collapses every run of blank Markdown lines into a single paragraph
boundary. This preprocessor retains the first blank line as that boundary and
turns each additional blank line into one \baselineskip of vertical space.
Fenced code blocks are copied unchanged.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

FENCE_RE = re.compile(r"^\s*(`{3,}|~{3,})")


def is_blank(line: str) -> bool:
    return not line.strip()


def transform(text: str) -> str:
    lines = text.splitlines(keepends=True)
    output: list[str] = []
    index = 0
    in_fence = False

    while index < len(lines):
        line = lines[index]
        if FENCE_RE.match(line):
            in_fence = not in_fence
            output.append(line)
            index += 1
            continue

        if in_fence or not is_blank(line):
            output.append(line)
            index += 1
            continue

        start = index
        while index < len(lines) and is_blank(lines[index]):
            index += 1
        blank_count = index - start

        if blank_count == 1:
            output.append(lines[start])
            continue

        # One blank line preserves the normal Markdown paragraph break.
        # Each further blank line becomes one visible blank line in the PDF.
        newline = "\r\n" if "\r\n" in lines[start] else "\n"
        output.append(newline)
        output.append(r"\vspace{" + str(blank_count - 1) + r"\baselineskip}" + newline)
        output.append(newline)

    return "".join(output)


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit(f"Usage: {Path(sys.argv[0]).name} INPUT.md")
    source = Path(sys.argv[1])
    sys.stdout.write(transform(source.read_text(encoding="utf-8")))


if __name__ == "__main__":
    main()
