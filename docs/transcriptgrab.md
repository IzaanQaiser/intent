# transcriptgrab

Grab a clean YouTube transcript via `yt-dlp`, with a fallback to `youtube-transcript-api`.

## Requirements

- Python 3.11+
- `yt-dlp` on PATH (primary)
- `youtube-transcript-api` (fallback)

Install fallback dependency if you want it:

```bash
python -m pip install youtube-transcript-api
```

## Usage

```bash
python scripts/transcriptgrab.py <url-or-id> [--lang en] [--format text|json] [--out output.txt]
```

The CLI reports itself as `transcriptgrab` in help output and is designed to be aliased as needed.

## Examples (placeholders)

```bash
python scripts/transcriptgrab.py dQw4w9WgXcQ --lang en
```

Expected output (text):

```
Never gonna give you up never gonna let you down

Never gonna run around and desert you
```

```bash
python scripts/transcriptgrab.py https://youtu.be/VIDEO_ID_ABC --format json
```

Expected output (json):

```json
{
  "video_id": "VIDEO_ID_ABC",
  "language": "en",
  "source": "yt-dlp-manual",
  "transcript": "First line.\n\nSecond paragraph."
}
```

```bash
python scripts/transcriptgrab.py https://www.youtube.com/shorts/VIDEO_ID_DEF --lang en --out transcript.txt
```

Expected output (text):

```
Shorts transcript text goes here.
```

## Exit codes

- `0`: success
- `2`: no transcript available
- `1`: other errors
