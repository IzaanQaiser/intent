#!/usr/bin/env python3
"""Grab YouTube transcripts via yt-dlp with a youtube-transcript-api fallback."""
from __future__ import annotations

import argparse
import html
import json
import re
import shutil
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Optional
from urllib.parse import parse_qs, urlparse

LONG_PAUSE_SEC = 1.5

VIDEO_ID_RE = re.compile(r"^[A-Za-z0-9_-]{11}$")
TIMESTAMP_RE = re.compile(
    r"(?P<start>\d{2}:\d{2}(?::\d{2})?\.\d{3})\s*-->\s*(?P<end>\d{2}:\d{2}(?::\d{2})?\.\d{3})"
)
WORD_RE = re.compile(r"[A-Za-z0-9']+")


@dataclass
class Segment:
    start: float
    end: float
    text: str


def parse_timestamp(value: str) -> float:
    parts = value.split(":")
    if len(parts) == 2:
        minutes, seconds = parts
        hours = 0
    else:
        hours, minutes, seconds = parts
    sec, ms = seconds.split(".")
    return int(hours) * 3600 + int(minutes) * 60 + int(sec) + int(ms) / 1000


def clean_text(value: str) -> str:
    value = re.sub(r"<[^>]+>", "", value)
    value = html.unescape(value)
    value = value.replace(">>", " ")
    value = re.sub(r"\s+", " ", value).strip()
    return value


def parse_vtt_to_segments(text: str) -> list[Segment]:
    segments: list[Segment] = []
    current_lines: list[str] = []
    current_start: Optional[float] = None
    current_end: Optional[float] = None
    skip_block = False

    for raw_line in text.splitlines():
        line = raw_line.strip("\ufeff").rstrip()
        stripped = line.strip()

        if not stripped:
            if current_start is not None:
                segment_text = clean_text(" ".join(current_lines)) if current_lines else ""
                segments.append(Segment(current_start, current_end or current_start, segment_text))
            current_lines = []
            current_start = None
            current_end = None
            skip_block = False
            continue

        if skip_block:
            continue

        if stripped.startswith("WEBVTT"):
            continue
        if stripped.startswith(("NOTE", "STYLE", "REGION")):
            skip_block = True
            continue
        if stripped.isdigit():
            continue

        match = TIMESTAMP_RE.search(stripped)
        if match:
            current_start = parse_timestamp(match.group("start"))
            current_end = parse_timestamp(match.group("end"))
            continue

        if current_start is None:
            continue

        current_lines.append(stripped)

    if current_start is not None:
        segment_text = clean_text(" ".join(current_lines)) if current_lines else ""
        segments.append(Segment(current_start, current_end or current_start, segment_text))

    return segments


def segments_to_paragraphs(segments: Iterable[Segment]) -> list[str]:
    paragraphs: list[str] = []
    current: list[str] = []
    last_end: Optional[float] = None

    for segment in segments:
        if not segment.text:
            if current:
                paragraphs.append(" ".join(current).strip())
                current = []
            last_end = segment.end
            continue

        if last_end is not None and segment.start - last_end > LONG_PAUSE_SEC:
            if current:
                paragraphs.append(" ".join(current).strip())
                current = []

        merge_segment_text(current, segment.text)
        last_end = segment.end

    if current:
        paragraphs.append(" ".join(current).strip())

    return [p for p in paragraphs if p]


def normalize_for_compare(text: str) -> str:
    return " ".join(WORD_RE.findall(text.lower()))


def strip_overlap(previous_text: str, new_text: str, max_words: int = 12) -> str:
    previous_words = previous_text.split()
    new_words = new_text.split()
    if not previous_words or not new_words:
        return new_text

    previous_norm = [re.sub(r"[^A-Za-z0-9']+", "", word).lower() for word in previous_words]
    new_norm = [re.sub(r"[^A-Za-z0-9']+", "", word).lower() for word in new_words]

    max_overlap = min(len(previous_norm), len(new_norm), max_words)
    for count in range(max_overlap, 0, -1):
        if previous_norm[-count:] == new_norm[:count]:
            return " ".join(new_words[count:]).strip()
    return new_text


def merge_segment_text(current: list[str], new_text: str) -> None:
    if not new_text:
        return
    if not current:
        current.append(new_text)
        return

    last_text = current[-1]
    last_norm = normalize_for_compare(last_text)
    new_norm = normalize_for_compare(new_text)

    if not new_norm:
        return
    if last_norm == new_norm:
        return
    if last_norm and last_norm in new_norm:
        current[-1] = new_text
        return
    if new_norm and new_norm in last_norm:
        return

    trimmed = strip_overlap(last_text, new_text)
    if not trimmed:
        return
    current.append(trimmed)


def segments_to_text(segments: Iterable[Segment]) -> str:
    paragraphs = segments_to_paragraphs(segments)
    return "\n\n".join(paragraphs).strip()


def extract_video_id(value: str) -> Optional[str]:
    value = value.strip()
    if VIDEO_ID_RE.match(value):
        return value

    try:
        parsed = urlparse(value)
    except ValueError:
        return None

    if parsed.netloc in {"youtu.be", "www.youtu.be"}:
        return parsed.path.lstrip("/")[:11] or None

    if "youtube.com" in parsed.netloc:
        if parsed.path == "/watch":
            query = parse_qs(parsed.query)
            ids = query.get("v")
            if ids:
                return ids[0]
        if parsed.path.startswith("/shorts/"):
            return parsed.path.split("/")[2][:11]
        if parsed.path.startswith("/embed/"):
            return parsed.path.split("/")[2][:11]

    return None


def ensure_url(input_value: str) -> tuple[str, str]:
    video_id = extract_video_id(input_value)
    if video_id:
        return video_id, f"https://www.youtube.com/watch?v={video_id}"

    parsed = urlparse(input_value)
    if parsed.scheme and parsed.netloc:
        raise ValueError("Unsupported YouTube URL format")

    if VIDEO_ID_RE.match(input_value):
        return input_value, f"https://www.youtube.com/watch?v={input_value}"

    raise ValueError("Input must be a YouTube URL or 11-character video ID")


def yt_dlp_available() -> bool:
    return shutil.which("yt-dlp") is not None


def rank_vtt_file(path: Path, lang: str) -> tuple[int, int]:
    name = path.name.lower()
    is_auto = "auto" in name
    lang_match = f".{lang.lower()}" in name or f"-{lang.lower()}" in name
    return (0 if lang_match else 1, 0 if not is_auto else 1)


def fetch_with_yt_dlp(url: str, lang: str) -> Optional[tuple[str, str]]:
    if not yt_dlp_available():
        raise RuntimeError("yt-dlp is not installed or not on PATH")

    with tempfile.TemporaryDirectory() as tmpdir:
        cmd = [
            "yt-dlp",
            "--skip-download",
            "--write-subs",
            "--write-auto-subs",
            "--sub-langs",
            f"{lang}.*,{lang}",
            "--sub-format",
            "vtt",
            "-o",
            "%(id)s.%(ext)s",
            url,
        ]
        result = subprocess.run(cmd, cwd=tmpdir, capture_output=True, text=True)
        if result.returncode != 0:
            detail = result.stderr.strip() or result.stdout.strip() or "yt-dlp failed"
            raise RuntimeError(detail)

        vtts = list(Path(tmpdir).glob("*.vtt"))
        if not vtts:
            return None

        vtts.sort(key=lambda path: rank_vtt_file(path, lang))
        chosen = vtts[0]
        source = "yt-dlp-auto" if "auto" in chosen.name.lower() else "yt-dlp-manual"
        text = chosen.read_text(encoding="utf-8", errors="ignore")
        segments = parse_vtt_to_segments(text)
        transcript = segments_to_text(segments)
        if not transcript:
            return None
        return transcript, source


def fetch_with_youtube_transcript_api(video_id: str, lang: str) -> Optional[tuple[str, str]]:
    try:
        from youtube_transcript_api import YouTubeTranscriptApi  # type: ignore
        from youtube_transcript_api._errors import (  # type: ignore
            NoTranscriptFound,
            TranscriptsDisabled,
        )
    except Exception as exc:  # noqa: BLE001
        raise RuntimeError("youtube-transcript-api is not installed") from exc

    try:
        transcript_list = YouTubeTranscriptApi.list_transcripts(video_id)
    except (NoTranscriptFound, TranscriptsDisabled):
        return None
    except Exception as exc:  # noqa: BLE001
        raise RuntimeError(str(exc)) from exc

    candidates = []
    for transcript in transcript_list:
        if transcript.language_code == lang or transcript.language_code.startswith(f"{lang}-"):
            candidates.append(transcript)

    if not candidates:
        return None

    candidates.sort(key=lambda t: (t.is_generated, t.language_code))
    transcript = candidates[0]

    try:
        entries = transcript.fetch()
    except (NoTranscriptFound, TranscriptsDisabled):
        return None
    except Exception as exc:  # noqa: BLE001
        raise RuntimeError(str(exc)) from exc

    segments = []
    for entry in entries:
        start = float(entry.get("start", 0))
        duration = float(entry.get("duration", 0))
        text = clean_text(entry.get("text", ""))
        segments.append(Segment(start, start + duration, text))

    transcript_text = segments_to_text(segments)
    if not transcript_text:
        return None
    source = "youtube-transcript-api-auto" if transcript.is_generated else "youtube-transcript-api-manual"
    return transcript_text, source


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="transcriptgrab",
        description="Grab YouTube transcripts via yt-dlp with a youtube-transcript-api fallback.",
    )
    parser.add_argument("url_or_id", help="YouTube URL or video ID")
    parser.add_argument("--lang", default="en", help="Preferred language (default: en)")
    parser.add_argument("--format", choices=("text", "json"), default="text")
    parser.add_argument("--out", help="Optional output file path")
    return parser


def main() -> int:
    args = build_parser().parse_args()
    try:
        video_id, url = ensure_url(args.url_or_id)
    except ValueError as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1

    transcript = None
    source = None
    tool_errors: list[str] = []

    try:
        result = fetch_with_yt_dlp(url, args.lang)
        if result:
            transcript, source = result
    except RuntimeError as exc:
        tool_errors.append(f"yt-dlp: {exc}")

    if not transcript:
        try:
            result = fetch_with_youtube_transcript_api(video_id, args.lang)
            if result:
                transcript, source = result
        except RuntimeError as exc:
            tool_errors.append(f"youtube-transcript-api: {exc}")

    if not transcript:
        print("No transcript available for this video", file=sys.stderr)
        if tool_errors:
            print("; ".join(tool_errors), file=sys.stderr)
            return 1
        return 2

    if args.format == "json":
        payload = {
            "video_id": video_id,
            "language": args.lang,
            "source": source,
            "transcript": transcript,
        }
        output = json.dumps(payload, ensure_ascii=True, indent=2)
    else:
        output = transcript

    print(output)

    if args.out:
        Path(args.out).write_text(output, encoding="utf-8")

    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        print("Interrupted", file=sys.stderr)
        raise SystemExit(1)
    except Exception as exc:  # noqa: BLE001
        print(f"Error: {exc}", file=sys.stderr)
        raise SystemExit(1)
