# The pages tucked into a call (loggie-pause-attach, 2026-10-28): what the user dropped on the recording card or picked
# from its fusen tab, copied by Loggie into <call>/pages/. Read on this Mac only; their words join the user's own words
# for spelling (spelling.own_words) and their text, screened like the transcript, goes into the notes (byo.py <pages>).
# A page that cannot be read gives '' and is said in the log: a page never stops a write-up.
#   pages_of(folder)          -> [(name, text)] in the order they were tucked in (PDF, Word, PowerPoint, Excel, text)
#   capped(pages, words=6000) -> the same, cut so all of them together hold at most `words` words
import re, subprocess, sys, zipfile
import xml.etree.ElementTree as ET
from pathlib import Path

KINDS = ('.pdf', '.docx', '.pptx', '.xlsx', '.txt', '.md')
MOST_ROWS = 400   # a sheet's first rows; a data dump past this is numbers no note needs
MAX_WORDS = 6000

def text_of(path):
    path = Path(path)
    try:
        if path.suffix == '.pdf':
            return subprocess.run(['pdftotext', '-layout', str(path), '-'], capture_output=True, text=True, timeout=60, check=True).stdout
        if path.suffix == '.docx':
            return subprocess.run(['textutil', '-convert', 'txt', '-stdout', str(path)], capture_output=True, text=True, timeout=60, check=True).stdout
        if path.suffix == '.pptx':
            # each slide's text runs (<a:t>), slide 1 first; a slide's runs joined by spaces, slides by blank lines
            with zipfile.ZipFile(path) as z:
                slides = sorted((n for n in z.namelist() if re.fullmatch(r'ppt/slides/slide\d+\.xml', n)), key=lambda n: int(re.search(r'\d+', n).group()))
                return '\n\n'.join(' '.join(unescape(t) for t in re.findall(r'<a:t>([^<]*)</a:t>', z.read(n).decode('utf-8', 'replace'))) for n in slides)
        if path.suffix == '.xlsx': return sheets_text(path)
        if path.suffix in ('.txt', '.md'): return path.read_text(errors='replace')
    except (OSError, subprocess.SubprocessError, zipfile.BadZipFile, ValueError, KeyError, ET.ParseError) as error:
        print(f'pages: {path.name} could not be read ({type(error).__name__}); the notes go on without it', file=sys.stderr)
    return ''

X = '{http://schemas.openxmlformats.org/spreadsheetml/2006/main}'

def sheets_text(path):
    # Each sheet as "Sheet <name>", then one line a row, its cells joined by " | " (values as saved: a formula's last
    # result, a number as written). Sheets in workbook order; a sheet stops at MOST_ROWS rows.
    with zipfile.ZipFile(path) as z:
        names = z.namelist()
        shared = []
        if 'xl/sharedStrings.xml' in names:
            shared = [''.join(t.text or '' for t in si.iter(X + 't')) for si in ET.fromstring(z.read('xl/sharedStrings.xml')).iter(X + 'si')]
        titles = [s.get('name') for s in ET.fromstring(z.read('xl/workbook.xml')).iter(X + 'sheet')]
        files = sorted((n for n in names if re.fullmatch(r'xl/worksheets/sheet\d+\.xml', n)), key=lambda n: int(re.search(r'\d+', n).group()))
        out = []
        for k, name in enumerate(files):
            rows = []
            for row in ET.fromstring(z.read(name)).iter(X + 'row'):
                cells = []
                for c in row.iter(X + 'c'):
                    kind, v = c.get('t'), c.find(X + 'v')
                    if kind == 's' and v is not None: value = shared[int(v.text)]
                    elif kind == 'inlineStr': value = ''.join(t.text or '' for t in c.iter(X + 't'))
                    else: value = v.text if v is not None and v.text else ''
                    if value.strip(): cells.append(value.strip())
                if cells: rows.append(' | '.join(cells))
                if len(rows) >= MOST_ROWS: break
            if rows: out.append(f'Sheet {titles[k] if k < len(titles) else k + 1}\n' + '\n'.join(rows))
        return '\n\n'.join(out)

def unescape(s): return s.replace('&lt;', '<').replace('&gt;', '>').replace('&quot;', '"').replace('&apos;', "'").replace('&amp;', '&')

def pages_of(folder):
    d = Path(folder) / 'pages'
    if not d.is_dir(): return []
    files = sorted((f for f in d.iterdir() if f.is_file() and f.suffix.lower() in KINDS), key=lambda f: (f.stat().st_mtime, f.name))
    return [(f.name, re.sub(r'[ \t]+', ' ', text_of(f)).strip()) for f in files]

def capped(pages, words=MAX_WORDS):
    out, left = [], words
    for name, text in pages:
        found = list(re.finditer(r'\S+', text))
        if left <= 0 or not found: continue
        out.append((name, text if len(found) <= left else text[:found[left - 1].end()]))
        left -= min(left, len(found))
    return out
