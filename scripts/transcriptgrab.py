#!/usr/bin/env python3
"""Grab YouTube transcripts via yt-dlp with timedtext/watch-page + youtube-transcript-api fallbacks."""
from __future__ import annotations

import argparse
import html
import json
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Optional
from urllib.parse import parse_qs, urlencode, urlparse

LONG_PAUSE_SEC = 1.5
YTDLP_RETRY_ATTEMPTS = 3
TIMEDTEXT_RETRY_ATTEMPTS = 3
TIMEDTEXT_TIMEOUT_SEC = 12
USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"

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


@dataclass
class TimedTextTrack:
    lang_code: str
    name: str
    kind: str
    is_generated: bool


@dataclass
class CaptionTrack:
    language_code: str
    name: str
    kind: str
    base_url: str
    is_generated: bool


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


def parse_transcript_xml(text: str) -> list[Segment]:
    try:
        root = ET.fromstring(text)
    except ET.ParseError:
        return []

    segments: list[Segment] = []
    for node in root.findall("text"):
        start = float(node.attrib.get("start", 0))
        duration = float(node.attrib.get("dur", 0))
        segment_text = clean_text(node.text or "")
        segments.append(Segment(start, start + duration, segment_text))
    return segments


def fetch_url(url: str, attempts: int = TIMEDTEXT_RETRY_ATTEMPTS, timeout: int = TIMEDTEXT_TIMEOUT_SEC) -> str:
    last_error: Optional[Exception] = None
    for attempt in range(attempts):
        try:
            request = urllib.request.Request(
                url,
                headers={
                    "User-Agent": USER_AGENT,
                    "Accept-Language": "en-US,en;q=0.9",
                },
            )
            with urllib.request.urlopen(request, timeout=timeout) as response:
                charset = response.headers.get_content_charset() or "utf-8"
                return response.read().decode(charset, errors="ignore")
        except urllib.error.HTTPError as exc:
            last_error = exc
            if exc.code in {429, 500, 502, 503, 504} and attempt < attempts - 1:
                time.sleep(1 + attempt)
                continue
            raise RuntimeError(f"HTTP {exc.code} for {url}") from exc
        except Exception as exc:  # noqa: BLE001
            last_error = exc
            if attempt < attempts - 1:
                time.sleep(1 + attempt)
                continue
            raise RuntimeError(str(exc)) from exc

    raise RuntimeError(str(last_error) if last_error else "Request failed")


def parse_timedtext_tracks(payload: str) -> list[TimedTextTrack]:
    try:
        root = ET.fromstring(payload)
    except ET.ParseError:
        return []

    tracks: list[TimedTextTrack] = []
    for node in root.findall("track"):
        lang_code = node.attrib.get("lang_code", "").strip()
        if not lang_code:
            continue
        name = node.attrib.get("name", "")
        kind = node.attrib.get("kind", "")
        tracks.append(
            TimedTextTrack(
                lang_code=lang_code,
                name=name,
                kind=kind,
                is_generated=kind == "asr",
            )
        )
    return tracks


def select_timedtext_track(tracks: list[TimedTextTrack], lang: str) -> Optional[TimedTextTrack]:
    matches = [track for track in tracks if track.lang_code == lang or track.lang_code.startswith(f"{lang}-")]
    if not matches:
        return None
    matches.sort(key=lambda track: (track.is_generated, len(track.lang_code)))
    return matches[0]


def fetch_with_timedtext_api(video_id: str, lang: str) -> Optional[tuple[str, str]]:
    list_url = f"https://www.youtube.com/api/timedtext?type=list&v={video_id}"
    payload = fetch_url(list_url)
    tracks = parse_timedtext_tracks(payload)
    if not tracks:
        return None

    track = select_timedtext_track(tracks, lang)
    if not track:
        return None

    params = {"v": video_id, "lang": track.lang_code, "fmt": "vtt"}
    if track.name:
        params["name"] = track.name
    if track.kind:
        params["kind"] = track.kind

    track_url = f"https://www.youtube.com/api/timedtext?{urlencode(params)}"
    transcript_payload = fetch_url(track_url)
    if not transcript_payload.strip():
        return None

    segments = (
        parse_transcript_xml(transcript_payload)
        if transcript_payload.lstrip().startswith("<")
        else parse_vtt_to_segments(transcript_payload)
    )
    transcript = segments_to_text(segments)
    if not transcript:
        return None
    source = "yt-timedtext-auto" if track.is_generated else "yt-timedtext-manual"
    return transcript, source


def extract_json_array(text: str, key: str) -> Optional[str]:
    index = text.find(key)
    if index == -1:
        return None
    start = text.find("[", index)
    if start == -1:
        return None

    depth = 0
    in_string = False
    escape = False
    for i in range(start, len(text)):
        ch = text[i]
        if in_string:
            if escape:
                escape = False
                continue
            if ch == "\\":
                escape = True
                continue
            if ch == '"':
                in_string = False
            continue
        if ch == '"':
            in_string = True
            continue
        if ch == "[":
            depth += 1
        elif ch == "]":
            depth -= 1
            if depth == 0:
                return text[start : i + 1]
    return None


def parse_caption_tracks_from_html(html_text: str) -> list[CaptionTrack]:
    array_text = extract_json_array(html_text, '"captionTracks":')
    if not array_text:
        return []
    try:
        data = json.loads(array_text)
    except json.JSONDecodeError:
        return []
    if not isinstance(data, list):
        return []

    tracks: list[CaptionTrack] = []
    for item in data:
        if not isinstance(item, dict):
            continue
        language_code = item.get("languageCode", "")
        base_url = item.get("baseUrl", "")
        if not isinstance(language_code, str) or not isinstance(base_url, str):
            continue
        name_data = item.get("name", {})
        name = ""
        if isinstance(name_data, dict):
            name = name_data.get("simpleText", "") if isinstance(name_data.get("simpleText", ""), str) else ""
        kind = item.get("kind", "") if isinstance(item.get("kind", ""), str) else ""
        tracks.append(
            CaptionTrack(
                language_code=language_code,
                name=name,
                kind=kind,
                base_url=base_url,
                is_generated=kind == "asr",
            )
        )
    return tracks


def select_caption_track(tracks: list[CaptionTrack], lang: str) -> Optional[CaptionTrack]:
    matches = [
        track
        for track in tracks
        if track.language_code == lang or track.language_code.startswith(f"{lang}-")
    ]
    if not matches:
        return None
    matches.sort(key=lambda track: (track.is_generated, len(track.language_code)))
    return matches[0]


def fetch_with_watch_html(video_id: str, lang: str) -> Optional[tuple[str, str]]:
    watch_url = f"https://www.youtube.com/watch?v={video_id}&hl={lang}"
    html_text = fetch_url(watch_url)
    tracks = parse_caption_tracks_from_html(html_text)
    if not tracks:
        return None

    track = select_caption_track(tracks, lang)
    if not track:
        return None

    base_url = track.base_url
    if "fmt=" not in base_url:
        base_url = f"{base_url}&fmt=vtt"

    transcript_payload = fetch_url(base_url)
    if not transcript_payload.strip():
        return None

    segments = (
        parse_transcript_xml(transcript_payload)
        if transcript_payload.lstrip().startswith("<")
        else parse_vtt_to_segments(transcript_payload)
    )
    transcript = segments_to_text(segments)
    if not transcript:
        return None
    source = "yt-watch-auto" if track.is_generated else "yt-watch-manual"
    return transcript, source


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

    def run_yt_dlp(extractor_args: Optional[str] = None) -> tuple[int, str, str, Path]:
        tmpdir = Path(tempfile.mkdtemp())
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
        if extractor_args:
            cmd.extend(["--extractor-args", extractor_args])
        result = subprocess.run(cmd, cwd=tmpdir, capture_output=True, text=True)
        return result.returncode, result.stdout, result.stderr, tmpdir

    def read_vtt_from(tmpdir: Path) -> Optional[tuple[str, str]]:
        vtts = list(tmpdir.glob("*.vtt"))
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

    last_error: Optional[str] = None
    for attempt in range(YTDLP_RETRY_ATTEMPTS):
        code, stdout, stderr, tmpdir = run_yt_dlp()
        try:
            result = read_vtt_from(tmpdir)
            if result:
                return result
            if code == 0:
                last_error = stderr.strip() or stdout.strip() or "yt-dlp found no subtitles"
                break
            detail = stderr.strip() or stdout.strip() or "yt-dlp failed"
            last_error = detail
            detail_lower = detail.lower()
            if (
                ("http error 429" in detail_lower or "too many requests" in detail_lower)
                and attempt < YTDLP_RETRY_ATTEMPTS - 1
            ):
                time.sleep(1 + attempt)
                continue
            break
        finally:
            shutil.rmtree(tmpdir, ignore_errors=True)

    code, stdout, stderr, tmpdir = run_yt_dlp("youtube:player_client=android")
    try:
        result = read_vtt_from(tmpdir)
        if result:
            return result
        if code == 0:
            last_error = stderr.strip() or stdout.strip() or last_error
        else:
            last_error = stderr.strip() or stdout.strip() or last_error
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)

    if last_error:
        raise RuntimeError(last_error)
    return None


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
            result = fetch_with_timedtext_api(video_id, args.lang)
            if result:
                transcript, source = result
        except RuntimeError as exc:
            tool_errors.append(f"timedtext: {exc}")

    if not transcript:
        try:
            result = fetch_with_watch_html(video_id, args.lang)
            if result:
                transcript, source = result
        except RuntimeError as exc:
            tool_errors.append(f"watch-page: {exc}")

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
